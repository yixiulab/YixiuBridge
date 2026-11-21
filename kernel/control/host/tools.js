// YixiuBridge — MCP tool catalog.
// SINGLE SOURCE OF TRUTH for the tool list: the extension service worker and
// the MCP server both read this file, so the two sides can never drift apart.
// Add a tool here and both sides offer it; remove it here and both sides drop it.
// UMD: Node (require), ES import, or plain <script> global.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.YixiuBridgeTools = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Every tool: MCP-compatible { name, description, inputSchema }.
  // `browser` (optional, every browser tool): route to a Chrome profile by
  // exact id, exact label, or unambiguous substring match.
  var TOOLS = [
    {
      name: 'ping',
      description: 'Check that the YixiuBridge bridge and extension are alive. Never takes the task lock.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'tabs_context',
      description: 'List open tabs (id, title, url, active) in the target Chrome profile.',
      inputSchema: {
        type: 'object',
        properties: { browser: { type: 'string', description: 'Chrome profile id/label (optional)' } },
        required: [],
      },
    },
    {
      name: 'navigate',
      description: 'Open a URL in a new tab, or navigate the active tab. Read-only navigation only — it never submits forms or pays for anything.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to open' },
          browser: { type: 'string', description: 'Chrome profile id/label (optional)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'read_page',
      description: 'Read the current tab: title, URL and a text excerpt of the page. No screenshots, no full DOM dump.',
      inputSchema: {
        type: 'object',
        properties: { browser: { type: 'string', description: 'Chrome profile id/label (optional)' } },
        required: [],
      },
    },
    {
      name: 'ask_gemini',
      description: 'Ask the Gemini web chat a question in the real logged-in Chrome and wait for the answer to finish. Returns {answer, model, elapsed_ms}. If the answer is still streaming when timeout_s runs out it returns {status:"pending", task_id} — poll get_answer for the result.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The question/task to send to Gemini web' },
          profile: { type: 'string', description: 'Chrome profile id/label (optional, same as browser)' },
          browser: { type: 'string', description: 'Chrome profile id/label (optional)' },
          timeout_s: { type: 'number', description: 'Max seconds to wait for the answer (default 180, max 600)' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'get_answer',
      description: 'Retrieve the result of a previous ask_gemini call by task_id: {status: running|done|failed, answer?, error?}.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task id returned by an earlier ask_gemini call' } },
        required: ['task_id'],
      },
    },
  ];

  function getTool(name) {
    for (var i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].name === name) return TOOLS[i];
    }
    return null;
  }

  return {
    TOOLS: TOOLS,
    TOOL_NAMES: TOOLS.map(function (t) { return t.name; }),
    getTool: getTool,
  };
});
