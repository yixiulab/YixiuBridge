// YixiuBridge — shared protocol constants.
// Single source of truth for ports, timeouts and frame shapes.
// Used by the extension (service worker), the local bridge and the MCP server.
// UMD: works as an ES module import, a Node require, or a plain <script> global.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.YixiuBridgeConstants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Compare two "x.y.z" version strings: -1 if a<b, 0 if equal, 1 if a>b.
  // Missing parts count as 0; non-numeric suffixes are ignored.
  function compareSemver(a, b) {
    function parts(v) {
      return String(v || '').split('.').map(function (p) {
        var n = parseInt(p, 10);
        return isNaN(n) ? 0 : n;
      });
    }
    var pa = parts(a);
    var pb = parts(b);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }

  // Should the extension auto-reload? True only when the version on disk
  // is strictly newer than the running manifest version, and we have not
  // already reloaded for that disk version (prevents reload loops).
  function shouldAutoReload(manifestVersion, diskVersion, lastReloadedVersion) {
    if (!diskVersion) return false;
    if (compareSemver(diskVersion, manifestVersion) <= 0) return false;
    if (lastReloadedVersion && compareSemver(diskVersion, lastReloadedVersion) <= 0) return false;
    return true;
  }

  return {
    // Identity
    EXTENSION_NAME: 'YixiuBridge',
    EXTENSION_VERSION: '0.3.4',
    PROTOCOL_VERSION: '1.0.0',

    // Local bridge (binds 127.0.0.1 ONLY — never 0.0.0.0, never a public port)
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_PORT: 8765,
    BRIDGE_URL: 'http://127.0.0.1:8765',

    // Pairing: copying the connection prompt opens a 30-minute intake window.
    // The first unknown AI client to connect inside the window is trusted.
    INTAKE_WINDOW_MS: 30 * 60 * 1000,

    // Timeouts (ms)
    TOOL_CALL_TIMEOUT_MS: 300000, // hard ceiling for any one tool call
    ASK_GEMINI_DEFAULT_TIMEOUT_MS: 180000, // default wait for a Gemini answer
    ASK_GEMINI_POLL_MS: 500, // how often to check whether streaming ended
    ASK_GEMINI_STABLE_MS: 2000, // answer text unchanged this long = done
    EXTENSION_RECONNECT_BASE_MS: 1000,
    EXTENSION_RECONNECT_MAX_MS: 30000,

    // Targets
    GEMINI_URL: 'https://gemini.google.com/app',
    GEMINI_ORIGIN: 'https://gemini.google.com',

    // Frame types on the bridge SSE / POST channel
    FRAME_TOOL_CALL: 'tool_call',
    FRAME_TOOL_RESULT: 'tool_result',
    FRAME_TASK_UPDATE: 'task_update',
    FRAME_PING: 'ping',

    // Task states (ask_gemini long answers)
    TASK_RUNNING: 'running',
    TASK_DONE: 'done',
    TASK_FAILED: 'failed',

    // Version helpers (auto-update)
    compareSemver: compareSemver,
    shouldAutoReload: shouldAutoReload,
  };
});
