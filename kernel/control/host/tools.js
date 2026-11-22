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
      name: 'list_models',
      description: 'List the models in the Gemini web model picker (does not change the selection). Returns {current, buttonText, models: [{label, codename, description, selected, locked}]}. Labels are Chinese (自动 / 日常帮助 / 更深入的分析 / 代码和复杂工作), codenames are Hydrogen / Neon / Carbon. Locked models (e.g. Carbon on a free account) cannot be selected.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Chrome profile id/label (optional, same as browser)' },
          browser: { type: 'string', description: 'Chrome profile id/label (optional)' },
        },
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
          model: { type: 'string', description: 'Gemini model to use, by codename or Chinese label, e.g. "Neon", "Hydrogen", "日常帮助". If omitted, uses the model currently selected in the Gemini web UI. Recommended high model: Neon. Locked models (e.g. Carbon on a free account) fail fast with a clear error.' },
          thinking: { type: 'string', description: 'Thinking level from the 思考等级 submenu, e.g. "高" / "中" / "低" (best-effort). Omit to keep the current level.' },
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
    {
      name: 'recover_last_answer',
      description: 'Read the latest COMPLETE answer already in the Gemini tab, without asking again. Recovery path for a call whose fetch was aborted or whose send check misjudged while Gemini had already answered (2026-11-22 teacher-testpc saga). Returns {answer, model, recovered: true} or an error when the prompt never left the input box or no answer is in the tab. Never takes the task lock.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt that was asked, so the tab can prove it was actually sent (the latest user-query turn must carry it)' },
          browser: { type: 'string', description: 'Chrome profile id/label (optional)' },
        },
        required: [],
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
