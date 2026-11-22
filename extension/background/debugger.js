// YixiuBridge — CDP debugger manager (service worker side, classic script).
// Attach on demand, detach as soon as the evaluation is done — never hold
// an attach across calls. Chrome shows a "YixiuBridge is debugging this
// browser" infobar while a tab is attached, so holding it would leave the
// banner up forever; with attach-on-demand it only flashes for the
// second(s) of a read_page call. Used only for read_page and generic page
// evaluation, which keep working even on pages with a strict CSP.
// ask_gemini never touches the debugger (content script only), so asking
// Gemini shows no banner at all.
// Exposes globalThis.YixiuBridgeDebuggerManager.
(function () {
  'use strict';

  function DebuggerManager() {
    this.attached = new Set(); // tabIds with a live debugger session
    this._attaching = new Map(); // tabId -> in-flight attach promise
    this._inUse = new Map(); // tabId -> number of in-flight evaluations
  }

  DebuggerManager.prototype.isAttached = function (tabId) {
    return this.attached.has(tabId);
  };

  DebuggerManager.prototype.attach = function (tabId) {
    var self = this;
    if (this.attached.has(tabId)) return Promise.resolve(true);
    if (this._attaching.has(tabId)) return this._attaching.get(tabId);
    var p = (async function () {
      try {
        await chrome.debugger.attach({ tabId: tabId }, '1.3');
        self.attached.add(tabId);
        return true;
      } catch (e) {
        return false;
      } finally {
        self._attaching.delete(tabId);
      }
    })();
    this._attaching.set(tabId, p);
    return p;
  };

  DebuggerManager.prototype.detach = async function (tabId) {
    if (!this.attached.has(tabId)) return;
    try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) { /* already gone */ }
    this.attached.delete(tabId);
  };

  DebuggerManager.prototype.detachAll = function () {
    var self = this;
    return Promise.all(Array.from(this.attached).map(function (id) { return self.detach(id); }));
  };

  // Evaluate JS in the page via CDP. Returns the raw result value.
  // Attaches, evaluates, then detaches again — the tab is only attached
  // for the duration of this call, so Chrome's debugging infobar only
  // shows briefly. Concurrent evaluations on the same tab share one
  // attach; the detach happens when the last one finishes.
  DebuggerManager.prototype.evaluate = async function (tabId, expression) {
    var count = (this._inUse.get(tabId) || 0) + 1;
    this._inUse.set(tabId, count);
    try {
      var ok = await this.attach(tabId);
      if (!ok) throw new Error('debugger attach failed for tab ' + tabId + ' — is the tab a Chrome internal page?');
      var res;
      try {
        res = await chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
          expression: expression,
          returnByValue: true,
          awaitPromise: true,
        });
      } catch (e) {
        // The tab may have navigated away and killed the session; detach
        // for real (not just bookkeeping) and retry once, so no orphaned
        // session is left behind keeping Chrome's infobar up.
        await this.detach(tabId);
        var ok2 = await this.attach(tabId);
        if (!ok2) throw new Error('debugger re-attach failed for tab ' + tabId);
        res = await chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
          expression: expression,
          returnByValue: true,
          awaitPromise: true,
        });
      }
      if (res.exceptionDetails) {
        var desc = res.exceptionDetails.exception && res.exceptionDetails.exception.description || '';
        throw new Error('page evaluation failed: ' + (res.exceptionDetails.text || '') + ' ' + desc);
      }
      return res.result ? res.result.value : undefined;
    } finally {
      var left = (this._inUse.get(tabId) || 1) - 1;
      if (left <= 0) {
        this._inUse.delete(tabId);
        await this.detach(tabId);
      } else {
        this._inUse.set(tabId, left);
      }
    }
  };

  // Trusted click via CDP Input.dispatchMouseEvent: a real, trusted
  // (isTrusted === true) click at viewport CSS pixels. Assumes the tab
  // is already attached — the caller attaches first (so the debug
  // infobar's viewport shift has already happened) and detaches after.
  // Sequence (teacher's answer, 2026-11-22): mouseMoved (hover /
  // activeItem) -> mousePressed -> mouseReleased. Blink generates the
  // full mouseup + click from the release. Used for the Gemini
  // thinking-level submenu items, which ignore every synthetic event
  // (verify15-19) but accept a real trusted click.
  DebuggerManager.prototype.trustedClick = async function (tabId, x, y) {
    var target = { tabId: tabId };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var send = function (type, button, buttons, clickCount) {
      var params = { type: type, x: x, y: y, button: button, buttons: buttons };
      if (clickCount) params.clickCount = clickCount;
      return chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params);
    };
    await send('mouseMoved', 'none', 0);
    await sleep(40);
    await send('mousePressed', 'left', 1, 1);
    await sleep(40);
    await send('mouseReleased', 'left', 0, 1);
  };

  // Lightweight page snapshot: title, URL, text excerpt. No screenshots.
  DebuggerManager.prototype.snapshot = async function (tabId) {
    var data = await this.evaluate(tabId, '(() => {'
      + 'const t = (document.body && document.body.innerText) || "";'
      + 'return { title: document.title || "", url: location.href, textExcerpt: t.slice(0, 4000), textLength: t.length };'
      + '})()');
    return data || { title: '', url: '', textExcerpt: '', textLength: 0 };
  };

  globalThis.YixiuBridgeDebuggerManager = DebuggerManager;
})();
