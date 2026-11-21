// YixiuBridge — bridge client (service worker side, classic script).
// Connects to the local bridge over SSE (server push, no polling) and posts
// tool results back over HTTP. Reconnects with backoff when the bridge
// restarts. Talks ONLY to 127.0.0.1:8765 — never to any remote host.
// Loaded via importScripts after kernel/shared/constants.js; exposes
// globalThis.YixiuBridgeBridgeClient.
(function () {
  'use strict';

  var C = (typeof YixiuBridgeConstants !== 'undefined')
    ? YixiuBridgeConstants
    : { BRIDGE_URL: 'http://127.0.0.1:8765', EXTENSION_RECONNECT_MAX_MS: 30000 };

  function BridgeClient(opts) {
    this.profile = opts.profile; // { id, label }
    this.onToolCall = opts.onToolCall;
    this.onStatus = opts.onStatus || function () {};
    this.connected = false;
    this.lastSeen = 0;
    this._abort = null;
    this._reconnectDelay = 1000;
    this._stopped = false;
  }

  BridgeClient.prototype.status = function () {
    return { connected: this.connected, lastSeen: this.lastSeen, profile: this.profile };
  };

  BridgeClient.prototype.connect = async function () {
    this._stopped = false;
    while (!this._stopped) {
      try {
        await this._runStream();
      } catch (e) {
        this.connected = false;
        this.onStatus(this.status());
      }
      if (this._stopped) break;
      await new Promise(function (r) { setTimeout(r, this._reconnectDelay); }.bind(this));
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, C.EXTENSION_RECONNECT_MAX_MS);
    }
  };

  BridgeClient.prototype.stop = function () {
    this._stopped = true;
    if (this._abort) { try { this._abort.abort(); } catch (e) { /* ignore */ } }
  };

  BridgeClient.prototype._runStream = async function () {
    var self = this;
    this._abort = new AbortController();
    var url = C.BRIDGE_URL + '/events?profile=' + encodeURIComponent(this.profile.id)
      + '&label=' + encodeURIComponent(this.profile.label);
    var res = await fetch(url, { signal: this._abort.signal });
    if (!res.ok || !res.body) throw new Error('bridge SSE connect failed: HTTP ' + res.status);
    this.connected = true;
    this.lastSeen = Date.now();
    this._reconnectDelay = 1000;
    this.onStatus(this.status());

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          self._handleSseBlock(raw);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
    throw new Error('bridge SSE stream closed');
  };

  BridgeClient.prototype._handleSseBlock = function (raw) {
    var lines = raw.split('\n');
    var data = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) data += line.slice(5).trim();
      else if (line.charAt(0) === ':') this.lastSeen = Date.now(); // heartbeat
    }
    if (!data) return;
    this.lastSeen = Date.now();
    var frame;
    try { frame = JSON.parse(data); } catch (e) { return; }
    if (frame && frame.type === 'tool_call' && this.onToolCall) {
      this.onToolCall(frame).catch(function () { /* router reports via result frames */ });
    }
  };

  BridgeClient.prototype.post = async function (path, body) {
    var res = await fetch(C.BRIDGE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('bridge POST ' + path + ' failed: HTTP ' + res.status);
    return res.json().catch(function () { return {}; });
  };

  BridgeClient.prototype.sendResult = function (frame) {
    return this.post('/result', frame);
  };

  BridgeClient.prototype.sendTaskUpdate = function (frame) {
    return this.post('/task-update', frame);
  };

  globalThis.YixiuBridgeBridgeClient = BridgeClient;
})();
