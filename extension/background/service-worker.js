// YixiuBridge — background service worker (classic script, MV3).
// Wires everything together: loads the shared constants + tool catalog,
// owns the BridgeClient (SSE to the local bridge), the DebuggerManager and
// the Router. Keeps itself alive with a 1-minute alarm; the bridge
// reconnects automatically after a service-worker restart.
importScripts(
  '../kernel/shared/constants.js',
  '../kernel/control/host/tools.js',
  './bridge-client.js',
  './debugger.js',
  './router.js'
);

(function () {
  'use strict';

  var VERSION = '0.4.12';
  var PROFILE_KEY = 'yixiubridge.profile';
  var UPDATE_CHECK_KEY = 'yixiubridge.lastAutoReloadVersion';

  var profile = null;
  var bridge = null;
  var router = null;
  var debuggerMgr = null;

  function randomId() {
    var s = '';
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return 'Profile-' + s;
  }

  async function loadProfile() {
    var stored = await chrome.storage.local.get(PROFILE_KEY);
    if (stored && stored[PROFILE_KEY] && stored[PROFILE_KEY].id) {
      profile = stored[PROFILE_KEY];
    } else {
      profile = { id: randomId(), label: '' };
      profile.label = profile.id;
      await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    }
    return profile;
  }

  async function setProfileLabel(label) {
    profile.label = label || profile.id;
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    // Reconnect so the bridge learns the new label.
    if (bridge) { bridge.stop(); }
    startBridge();
  }

  function startBridge() {
    var BridgeClient = globalThis.YixiuBridgeBridgeClient;
    var Router = globalThis.YixiuBridgeRouter;
    var DebuggerManager = globalThis.YixiuBridgeDebuggerManager;
    debuggerMgr = debuggerMgr || new DebuggerManager();
    bridge = new BridgeClient({
      profile: profile,
      onToolCall: function (frame) { return handleToolCall(frame); },
      onStatus: function () { /* status visible via get_status */ },
    });
    router = new Router({ bridge: bridge, debugger: debuggerMgr, profile: profile, version: VERSION });
    bridge.connect();
  }

  async function handleToolCall(frame) {
    var res;
    try {
      res = await router.handle(frame);
    } catch (e) {
      res = { ok: false, error: 'router crash: ' + (e && e.message ? e.message : String(e)) };
    }
    var resultFrame = {
      type: 'tool_result',
      id: frame.id,
      tool: frame.tool,
      ok: !!res.ok,
      result: res.ok ? res.result : undefined,
      error: res.ok ? undefined : res.error,
    };
    try {
      await bridge.sendResult(resultFrame);
    } catch (e) {
      // Bridge is down; the caller already timed out server-side. Nothing
      // useful to do here — the next reconnect will resync.
    }
  }

  // Gemini content script reports finished answers here.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.from === 'yixiubridge-gemini' && msg.type === 'ask_result') {
      if (router) router.onAskResult(msg.taskId, msg.result);
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'yixiubridge-trusted-click') {
      // Content script wants a real (CDP) click on a thinking-level
      // item (v0.4.12). The adapter already opened the submenu. Attach
      // the debugger FIRST (the infobar shifts the viewport), wait for
      // the layout to settle, then ask the content script to measure the
      // item's centre, click it via CDP, and detach. Async — keep the
      // channel open (return true).
      var tabId = sender && sender.tab && sender.tab.id;
      if (!tabId) { sendResponse({ ok: false, error: 'trusted-click: no tab id' }); return false; }
      if (!debuggerMgr) { sendResponse({ ok: false, error: 'trusted-click: debugger manager not ready' }); return false; }
      (async function () {
        var attached = false;
        try {
          attached = await debuggerMgr.attach(tabId);
          if (!attached) { sendResponse({ ok: false, error: 'debugger attach failed — is DevTools open on this tab?' }); return; }
          await new Promise(function (r) { setTimeout(r, 150); });
          var measured = await chrome.tabs.sendMessage(tabId, { from: 'yixiubridge-sw', type: 'measure-thinking-item', levelText: msg.levelText });
          if (!measured || !measured.ok) { sendResponse({ ok: false, error: (measured && measured.error) || 'measure-thinking-item failed' }); return; }
          await debuggerMgr.trustedClick(tabId, measured.x, measured.y);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: 'trusted-click failed: ' + (e && e.message ? e.message : String(e)) });
        } finally {
          if (attached) {
            await new Promise(function (r) { setTimeout(r, 100); });
            await debuggerMgr.detach(tabId).catch(function () {});
          }
        }
      })();
      return true;
    }
    if (msg && msg.type === 'get_status') {
      sendResponse({
        ok: true,
        version: VERSION,
        profile: profile,
        bridge: bridge ? bridge.status() : { connected: false },
        controller: router ? router.controller : null,
        tools: (typeof YixiuBridgeTools !== 'undefined') ? YixiuBridgeTools.TOOL_NAMES : [],
      });
      return false;
    }
    if (msg && msg.type === 'set_profile_label') {
      setProfileLabel(msg.label).then(function () { sendResponse({ ok: true, profile: profile }); });
      return true;
    }
    if (msg && msg.type === 'open_pairing') {
      // The side panel handles pairing UI; nothing to do here.
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (debuggerMgr) debuggerMgr.detach(tabId).catch(function () {});
  });

  chrome.action.onClicked.addListener(function () {
    chrome.sidePanel.open({ windowId: undefined }).catch(function () {});
  });

  // Auto-update: once a minute, ask the bridge which version is on disk.
  // The disk version changes when 一键启动.bat downloads a newer ZIP over
  // the install folder. If the disk is newer than the running extension
  // and we have not already reloaded for that version, reload the
  // extension so the new code takes effect. Skipped while a task is
  // running (retried next minute), and never loops thanks to the stored
  // version. A failed fetch (bridge down) is silently skipped.
  async function checkForUpdate() {
    try {
      var C = globalThis.YixiuBridgeConstants;
      if (!C || !C.shouldAutoReload) return;
      var manifestVersion = chrome.runtime.getManifest().version;
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 5000);
      var res;
      try {
        res = await fetch('http://127.0.0.1:8765/status', { signal: ctrl.signal });
      } finally { clearTimeout(timer); }
      if (!res || !res.ok) return;
      var st = await res.json();
      var diskVersion = st && st.disk_version;
      var stored = await chrome.storage.local.get(UPDATE_CHECK_KEY);
      var lastReloaded = stored && stored[UPDATE_CHECK_KEY];
      if (!C.shouldAutoReload(manifestVersion, diskVersion, lastReloaded)) return;
      if (router) {
        var tasks = router.tasks ? Array.from(router.tasks.values()) : [];
        if (tasks.some(function (t) { return t && t.status === 'running'; })) return;
      }
      await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: diskVersion });
      chrome.runtime.reload();
    } catch (e) { /* bridge down or storage unavailable — try next minute */ }
  }

  // Keep-alive: wakes the worker at least once a minute so the SSE loop
  // resumes promptly after Chrome suspends it. The same tick also checks
  // for a newer version on disk (auto-update, see checkForUpdate).
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'yixiubridge-keepalive') {
      if (bridge && !bridge.connected) bridge.connect();
      checkForUpdate();
    }
  });

  chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.create('yixiubridge-keepalive', { periodInMinutes: 1 });
  });

  chrome.runtime.onStartup.addListener(function () {
    chrome.alarms.create('yixiubridge-keepalive', { periodInMinutes: 1 });
  });

  // Boot: make sure the keep-alive alarm exists even when the worker was
  // restarted by chrome.runtime.reload() (v0.3.7: onStartup does not
  // reliably fire after a reload, and without the alarm a suspended
  // worker never wakes to reconnect — the 2026-11-21 0.3.6 update left
  // the bridge with no extension for 12 minutes until the user opened
  // Chrome by hand). create() is idempotent; the alarm only wakes the
  // worker once a minute, it does not keep Chrome itself running.
  try { chrome.alarms.create('yixiubridge-keepalive', { periodInMinutes: 1 }); } catch (e) { /* alarms unavailable in tests */ }
  loadProfile().then(function () { startBridge(); });
})();
