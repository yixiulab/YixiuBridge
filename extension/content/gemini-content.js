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
  var CONTENT_VERSION = '0.4.15';

  function getAdapter() {
    if (adapter) return adapter;
    var factory = (typeof window !== 'undefined' && window.YixiuBridgeGeminiAdapter)
      ? window.YixiuBridgeGeminiAdapter
      : (typeof YixiuBridgeGeminiAdapter !== 'undefined' ? YixiuBridgeGeminiAdapter : null);
    if (!factory || !factory.createAdapter) return null;
    adapter = factory.createAdapter(document, { win: window, requestTrustedClick: requestTrustedClick, requestTrustedSendClick: requestTrustedSendClick });
    return adapter;
  }

  // Ask the background service worker for a real (CDP) trusted click
  // on a thinking-level item (v0.4.12). Resolves {ok} / {ok:false,
  // error}. Times out after 15s so a missing or dead background never
  // hangs an ask — the adapter then falls back to synthetic methods.
  function requestTrustedClick(levelText) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ ok: false, error: 'trusted-click timed out after 15s' }); }
      }, 15000);
      try {
        chrome.runtime.sendMessage({ type: 'yixiubridge-trusted-click', levelText: levelText }, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res && typeof res === 'object' ? res : { ok: false, error: 'no response from background' });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: 'trusted-click send failed: ' + (e && e.message ? e.message : String(e)) });
      }
    });
  }

  // Ask the background service worker for a real (CDP) trusted click
  // on the SEND button (v0.4.13, teacher-001): the adapter's plain
  // click + Enter both missed on the real page. Same 15s timeout as
  // the thinking-level trusted click, so a dead background never hangs
  // an ask — the adapter falls back to the pointer sequence.
  function requestTrustedSendClick() {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ ok: false, error: 'trusted-send-click timed out after 15s' }); }
      }, 15000);
      try {
        chrome.runtime.sendMessage({ type: 'yixiubridge-trusted-click', target: 'send' }, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res && typeof res === 'object' ? res : { ok: false, error: 'no response from background' });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: 'trusted-send-click send failed: ' + (e && e.message ? e.message : String(e)) });
      }
    });
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

    // Background (trusted-click flow, v0.4.12): measure a thinking-level
    // item's viewport centre AFTER the debugger is attached, so the
    // coordinates already account for the debug infobar's viewport
    // shift. The submenu must already be open — the adapter only reads.
    if (msg.type === 'measure-thinking-item') {
      var adMeasure = getAdapter();
      if (!adMeasure || typeof adMeasure.measureThinkingLevelItem !== 'function') {
        sendResponse({ ok: false, error: 'gemini adapter not loaded or measureThinkingLevelItem missing' });
        return false;
      }
      try {
        var measured = adMeasure.measureThinkingLevelItem(msg.levelText || '');
        sendResponse(measured && typeof measured === 'object' ? measured : { ok: false, error: 'measure returned nothing' });
      } catch (e) {
        sendResponse({ ok: false, error: 'measure failed: ' + (e && e.message ? e.message : String(e)) });
      }
      return false;
    }

    // Background (trusted-send-click flow, v0.4.13): measure the send
    // button's viewport centre AFTER the debugger is attached, so the
    // coordinates already account for the debug infobar's viewport
    // shift. Mirrors 'measure-thinking-item'.
    if (msg.type === 'measure-send-button') {
      var adSend = getAdapter();
      if (!adSend || typeof adSend.measureSendButton !== 'function') {
        sendResponse({ ok: false, error: 'gemini adapter not loaded or measureSendButton missing' });
        return false;
      }
      try {
        var measuredSend = adSend.measureSendButton();
        sendResponse(measuredSend && typeof measuredSend === 'object' ? measuredSend : { ok: false, error: 'measure returned nothing' });
      } catch (e) {
        sendResponse({ ok: false, error: 'measure failed: ' + (e && e.message ? e.message : String(e)) });
      }
      return false;
    }

    // Recovery read (v0.4.13): return the latest COMPLETE answer already
    // in the tab, without asking again. The adapter refuses when the
    // prompt never left the box, so a previous turn's answer is never
    // returned as this turn's. Synchronous read — answer on the channel.
    if (msg.tool === 'recover_last_answer') {
      var adRec = getAdapter();
      if (!adRec || typeof adRec.recoverLastAnswer !== 'function') {
        sendResponse({ ok: false, error: 'gemini adapter not loaded or recoverLastAnswer missing', adapter_version: getAdapterVersion() });
        return false;
      }
      try {
        var rec = adRec.recoverLastAnswer((msg.params && msg.params.prompt) || '');
        if (rec && rec.ok) {
          // v0.4.15: pass unmatched through — the answer is the latest
          // in the tab but was not verified against this prompt (the
          // prompt never left the box). The runner surfaces it as
          // recovered_unmatched so the reader knows.
          sendResponse({ ok: true, result: { answer: rec.answer, model: 'gemini-web', adapter_version: getAdapterVersion(), recovered: true, unmatched: !!rec.unmatched } });
        } else {
          sendResponse({ ok: false, error: (rec && rec.error) || 'recover_last_answer: no answer found in the current Gemini tab', adapter_version: getAdapterVersion() });
        }
      } catch (e) {
        sendResponse({ ok: false, error: 'recover failed: ' + (e && e.message ? e.message : String(e)), adapter_version: getAdapterVersion() });
      }
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
