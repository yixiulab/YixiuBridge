// YixiuBridge — tool router (service worker side, classic script).
// Dispatches tool_call frames from the bridge to chrome.* APIs and the
// Gemini content script. Every handler resolves to a structured result;
// errors are returned as { ok:false, error } — never thrown across the
// bridge boundary uncaught.
// Exposes globalThis.YixiuBridgeRouter.
(function () {
  'use strict';

  var C = (typeof YixiuBridgeConstants !== 'undefined')
    ? YixiuBridgeConstants
    : { GEMINI_URL: 'https://gemini.google.com/app' };

  function Router(opts) {
    this.bridge = opts.bridge; // BridgeClient (for task updates)
    this.debugger = opts.debugger; // DebuggerManager
    this.profile = opts.profile; // { id, label }
    this.version = opts.version || '0.3.0';
    this.controller = null; // clientId of the current controller (from bridge)
    this.tasks = new Map(); // taskId -> { status, answer?, error?, startedAt, finishedAt }
    this._waiters = new Map(); // taskId -> [resolve...]
  }

  Router.prototype._newTaskId = function () {
    return 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  Router.prototype._setTask = function (taskId, patch) {
    var t = this.tasks.get(taskId) || { status: 'running', startedAt: Date.now() };
    Object.assign(t, patch);
    if (patch.status === 'done' || patch.status === 'failed') t.finishedAt = Date.now();
    this.tasks.set(taskId, t);
    var waiters = this._waiters.get(taskId) || [];
    if (t.status !== 'running') {
      this._waiters.delete(taskId);
      waiters.forEach(function (r) { r(t); });
    }
    return t;
  };

  // Called by the service worker when the Gemini content script reports back.
  Router.prototype.onAskResult = function (taskId, result) {
    var self = this;
    if (result && result.ok) {
      this._setTask(taskId, { status: 'done', answer: result.answer, model: result.model, elapsedMs: result.elapsedMs });
    } else {
      this._setTask(taskId, { status: 'failed', error: (result && result.error) || 'unknown gemini error' });
    }
    // Tell the bridge so get_answer works even after the original call timed out.
    var t = this.tasks.get(taskId);
    if (this.bridge && this.bridge.sendTaskUpdate) {
      this.bridge.sendTaskUpdate({ type: 'task_update', taskId: taskId, task: t }).catch(function () { /* bridge down — best effort */ });
    }
  };

  Router.prototype._waitForTask = function (taskId, timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      var t = self.tasks.get(taskId);
      if (t && t.status !== 'running') { resolve(t); return; }
      var list = self._waiters.get(taskId) || [];
      list.push(resolve);
      self._waiters.set(taskId, list);
      setTimeout(function () {
        var waiters = self._waiters.get(taskId) || [];
        var i = waiters.indexOf(resolve);
        if (i !== -1) waiters.splice(i, 1);
        var cur = self.tasks.get(taskId) || { status: 'running' };
        resolve(cur);
      }, timeoutMs);
    });
  };

  Router.prototype.handle = async function (frame) {
    var tool = frame.tool;
    var params = frame.params || {};
    if (frame.controller) this.controller = frame.controller;
    try {
      switch (tool) {
        case 'ping': return { ok: true, result: { ok: true, bridge: 'connected', version: this.version, profile: this.profile } };
        case 'tabs_context': return { ok: true, result: await this._tabsContext() };
        case 'navigate': return { ok: true, result: await this._navigate(params) };
        case 'read_page': return { ok: true, result: await this._readPage() };
        case 'list_models': return { ok: true, result: await this._listModels() };
        case 'ask_gemini': return { ok: true, result: await this._askGemini(params) };
        case 'get_answer': return { ok: true, result: this._getAnswer(params) };
        default: return { ok: false, error: 'unknown tool: ' + tool };
      }
    } catch (e) {
      return { ok: false, error: (tool || 'tool') + ' failed: ' + (e && e.message ? e.message : String(e)) };
    }
  };

  Router.prototype._tabsContext = async function () {
    var tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map(function (t) {
        return { id: t.id, title: t.title || '', url: t.url || '', active: !!t.active };
      }),
    };
  };

  Router.prototype._navigate = async function (params) {
    var url = params.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new Error('navigate: a full http(s) URL is required');
    }
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { url: url });
      return { navigated: tabs[0].id, url: url };
    }
    var tab = await chrome.tabs.create({ url: url });
    return { navigated: tab.id, url: url };
  };

  Router.prototype._readPage = async function () {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) throw new Error('read_page: no active tab');
    var tab = tabs[0];
    if (/^chrome:\/\//.test(tab.url || '')) {
      return { title: tab.title || '', url: tab.url || '', textExcerpt: '', textLength: 0, note: 'Chrome internal pages cannot be read' };
    }
    // Prefer the content script when the tab has one (Gemini tabs do): it
    // reads the page without the debugger, so Chrome shows no debugging
    // infobar at all. Other pages have no content script, so fall back to
    // a brief debugger attach (attach -> read -> detach). This keeps the
    // bridge on the Gemini browser only: ask_gemini never touches the
    // debugger, and read_page only ever attaches to the one tab being read.
    try {
      var res = await chrome.tabs.sendMessage(tab.id, { from: 'yixiubridge-sw', tool: 'read_page' });
      if (res && res.ok && res.snapshot) return res.snapshot;
    } catch (e) { /* no content script in this tab — use the debugger */ }
    var snap = await this.debugger.snapshot(tab.id);
    return snap;
  };

  Router.prototype._findGeminiTab = async function () {
    var tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs && tabs.length) return tabs[0];
    return null;
  };

  Router.prototype._waitForTabReady = async function (tabId, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        var tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete') return true;
      } catch (e) { /* tab closed */ return false; }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return false;
  };

  Router.prototype._pingContentScript = async function (tabId, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        var res = await chrome.tabs.sendMessage(tabId, { from: 'yixiubridge-sw', tool: 'ping' });
        if (res && res.ok) {
          // A missing version means the tab still runs the content script
          // from before the extension was updated (Chrome does not
          // re-inject content scripts on extension reload).
          if (!res.version || res.version !== this.version) return 'stale';
          return 'ok';
        }
      } catch (e) { /* content script not ready yet */ }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return false;
  };

  // Find a Gemini tab (open one if needed) and wait until its content
  // script answers. Shared by ask_gemini and list_models.
  Router.prototype._ensureGeminiTab = async function () {
    var tab = await this._findGeminiTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: C.GEMINI_URL, active: false });
    }
    var ready = await this._waitForTabReady(tab.id, 30000);
    if (!ready) throw new Error('Gemini tab did not finish loading within 30s');
    var cs = await this._pingContentScript(tab.id, 30000);
    if (cs === 'stale') {
      // The tab still runs the old content script (see _pingContentScript).
      // Reload the tab once so the new adapter loads, then ping again.
      await chrome.tabs.reload(tab.id);
      ready = await this._waitForTabReady(tab.id, 30000);
      if (!ready) throw new Error('Gemini tab did not finish loading within 30s');
      cs = await this._pingContentScript(tab.id, 30000);
      if (cs === 'stale') {
        throw new Error('Gemini content script is still an old version after reloading the tab — reload the extension in chrome://extensions (it should show ' + this.version + ') and try again');
      }
    }
    if (cs !== 'ok') {
      throw new Error('Gemini content script did not answer — are you logged in to gemini.google.com in this Chrome profile?');
    }
    return tab;
  };

  Router.prototype._listModels = async function () {
    var tab = await this._ensureGeminiTab();
    var res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { from: 'yixiubridge-sw', tool: 'list_models' });
    } catch (e) {
      throw new Error('list_models: could not reach the Gemini content script: ' + e.message);
    }
    if (!res || !res.ok) throw new Error('list_models: ' + ((res && res.error) || 'content script returned no result'));
    return res.result;
  };

  Router.prototype._askGemini = async function (params) {
    var prompt = params.prompt;
    if (!prompt || !String(prompt).trim()) throw new Error('ask_gemini: prompt is empty');
    var timeoutS = params.timeout_s || 180;
    if (timeoutS > 600) timeoutS = 600;
    if (timeoutS < 5) timeoutS = 5;
    var timeoutMs = timeoutS * 1000;

    var tab = await this._ensureGeminiTab();

    var taskId = this._newTaskId();
    this.tasks.set(taskId, { status: 'running', startedAt: Date.now() });
    try {
      await chrome.tabs.sendMessage(tab.id, {
        from: 'yixiubridge-sw', tool: 'ask_gemini', taskId: taskId,
        params: { prompt: String(prompt), timeout_s: timeoutS, model: params.model || undefined, thinking: params.thinking || undefined },
      });
    } catch (e) {
      this._setTask(taskId, { status: 'failed', error: 'could not start ask in Gemini tab: ' + e.message });
      throw new Error('ask_gemini: could not start ask in Gemini tab: ' + e.message);
    }

    var finished = await this._waitForTask(taskId, timeoutMs);
    if (finished.status === 'done') {
      return { answer: finished.answer, model: finished.model || 'gemini-web', elapsed_ms: finished.elapsedMs, task_id: taskId };
    }
    if (finished.status === 'failed') {
      throw new Error('ask_gemini: ' + (finished.error || 'Gemini answer failed'));
    }
    // Still running after timeout: return pending; the task keeps running and
    // the bridge is notified via task_update when it finishes.
    return { status: 'pending', task_id: taskId, note: 'answer still streaming — poll get_answer with this task_id' };
  };

  Router.prototype._getAnswer = function (params) {
    var t = this.tasks.get(params.task_id);
    if (!t) return { status: 'unknown', error: 'no such task: ' + params.task_id };
    return t;
  };

  globalThis.YixiuBridgeRouter = Router;
})();
