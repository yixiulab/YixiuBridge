// YixiuBridge — Gemini web content script (runs in the page's isolated world).
// Listens for tool messages from the service worker, runs the Gemini adapter
// against the real document, and posts the result back with a separate
// runtime message (no long-lived message channel — the answer can take
// minutes). It never talks to the bridge directly and never contacts any
// remote host.
//
// The adapter file (kernel/adapters/gemini-web.js) is loaded before this
// script via manifest content_scripts, so YixiuBridgeGeminiAdapter is global.
(function () {
  'use strict';

  var adapter = null;

  // Content-script version. The service worker compares this with the
  // running extension version: after the extension is updated, a Gemini
  // tab opened earlier still runs the OLD content script (Chrome does not
  // re-inject on extension reload), so the router reloads the tab once
  // when this version is stale or missing.
  var CONTENT_VERSION = '0.3.4';

  function getAdapter() {
    if (adapter) return adapter;
    var factory = (typeof window !== 'undefined' && window.YixiuBridgeGeminiAdapter)
      ? window.YixiuBridgeGeminiAdapter
      : (typeof YixiuBridgeGeminiAdapter !== 'undefined' ? YixiuBridgeGeminiAdapter : null);
    if (!factory || !factory.createAdapter) return null;
    adapter = factory.createAdapter(document, { win: window });
    return adapter;
  }

  function getAdapterVersion() {
    // The adapter file is loaded before this script (manifest
    // content_scripts), so its factory global carries ADAPTER_VERSION.
    // null = the adapter file did not load — the router treats that as
    // stale and reloads the tab once.
    try {
      var f = (typeof window !== 'undefined' && window.YixiuBridgeGeminiAdapter)
        ? window.YixiuBridgeGeminiAdapter
        : (typeof YixiuBridgeGeminiAdapter !== 'undefined' ? YixiuBridgeGeminiAdapter : null);
      return (f && f.ADAPTER_VERSION) ? String(f.ADAPTER_VERSION) : null;
    } catch (e) { return null; }
  }

  function pageSnapshot() {
    var text = (document.body && document.body.innerText) || '';
    return {
      title: document.title || '',
      url: location.href,
      textExcerpt: text.slice(0, 4000),
      textLength: text.length,
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.from !== 'yixiubridge-sw') return false;

    if (msg.tool === 'ping') {
      // Both versions: the content script AND the adapter are separate
      // files, and a tab opened before an extension update can run a stale
      // copy of either. The router reloads the tab once when they differ
      // from the running extension version.
      sendResponse({ ok: true, page: 'gemini', url: location.href, version: CONTENT_VERSION, adapter_version: getAdapterVersion() });
      return false;
    }

    if (msg.tool === 'read_page') {
      sendResponse({ ok: true, snapshot: pageSnapshot() });
      return false;
    }

    if (msg.tool === 'list_models') {
      // Quick (1-2s): answer on the same channel. Return true to keep it
      // open until the async adapter call finishes.
      var adList = getAdapter();
      if (!adList) {
        sendResponse({ ok: false, error: 'gemini adapter not loaded in this page — extension files may be out of sync', adapter_version: getAdapterVersion() });
        return false;
      }
      adList.listModels().then(function (res) {
        if (res && res.ok) {
          sendResponse({ ok: true, result: { current: res.current, buttonText: res.buttonText, models: res.models, adapter_version: res.adapter_version } });
        } else {
          sendResponse({ ok: false, error: (res && res.error) || 'list_models failed', adapter_version: (res && res.adapter_version) || getAdapterVersion() });
        }
      }).catch(function (e) {
        sendResponse({ ok: false, error: 'gemini content script error: ' + (e && e.message ? e.message : String(e)), adapter_version: getAdapterVersion() });
      });
      return true;
    }

    if (msg.tool === 'ask_gemini') {
      // Start the ask in the background; report back via a separate message
      // so the original channel is not held open for minutes.
      var taskId = msg.taskId || ('task_' + Date.now().toString(36));
      var ad = getAdapter();
      if (!ad) {
        chrome.runtime.sendMessage({
          from: 'yixiubridge-gemini', type: 'ask_result', taskId: taskId,
          result: { ok: false, error: 'gemini adapter not loaded in this page — extension files may be out of sync', adapter_version: getAdapterVersion() },
        });
        sendResponse({ ok: true, started: true, taskId: taskId });
        return false;
      }
      var prompt = (msg.params && msg.params.prompt) || '';
      var timeoutMs = ((msg.params && msg.params.timeout_s) || 180) * 1000;
      ad.ask(prompt, {
        timeoutMs: timeoutMs,
        model: (msg.params && msg.params.model) || undefined,
        thinking: (msg.params && msg.params.thinking) || undefined,
      }).then(function (res) {
        chrome.runtime.sendMessage({ from: 'yixiubridge-gemini', type: 'ask_result', taskId: taskId, result: res });
      }).catch(function (e) {
        chrome.runtime.sendMessage({
          from: 'yixiubridge-gemini', type: 'ask_result', taskId: taskId,
          result: { ok: false, error: 'gemini content script error: ' + (e && e.message ? e.message : String(e)), adapter_version: getAdapterVersion() },
        });
      });
      sendResponse({ ok: true, started: true, taskId: taskId });
      return false;
    }

    sendResponse({ ok: false, error: 'unknown tool for gemini content script: ' + msg.tool });
    return false;
  });

  // Debug handle (page context only, no data leaves the browser).
  window.__YixiuBridge = { version: CONTENT_VERSION, page: 'gemini' };
})();
