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

  var VERSION = '0.1.0';
  var PROFILE_KEY = 'yixiubridge.profile';

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

  // Keep-alive: wakes the worker at least once a minute so the SSE loop
  // resumes promptly after Chrome suspends it.
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'yixiubridge-keepalive' && bridge && !bridge.connected) {
      bridge.connect();
    }
  });

  chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.create('yixiubridge-keepalive', { periodInMinutes: 1 });
  });

  chrome.runtime.onStartup.addListener(function () {
    chrome.alarms.create('yixiubridge-keepalive', { periodInMinutes: 1 });
  });

  // Boot.
  loadProfile().then(function () { startBridge(); });
})();
