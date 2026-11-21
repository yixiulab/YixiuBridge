// YixiuBridge — CDP debugger manager (service worker side, classic script).
// One persistent chrome.debugger attach per tab (attach once, reuse for every
// action — never attach/detach per call). Used for read_page and generic page
// evaluation, which keep working even on pages with a strict CSP.
// NOTE: Chrome shows a "YixiuBridge is debugging this browser" infobar while
// a tab is attached. That is by design and visible to the user.
// Exposes globalThis.YixiuBridgeDebuggerManager.
(function () {
  'use strict';

  function DebuggerManager() {
    this.attached = new Set(); // tabIds with a live debugger session
    this._attaching = new Map(); // tabId -> in-flight attach promise
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
  DebuggerManager.prototype.evaluate = async function (tabId, expression) {
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
      // The tab may have navigated away and killed the session; retry once.
      this.attached.delete(tabId);
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
