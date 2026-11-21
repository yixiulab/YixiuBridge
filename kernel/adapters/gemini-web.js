// YixiuBridge — Gemini web site adapter.
// ONE FILE PER MODEL. If gemini.google.com changes its UI, only this file
// needs updating; every other model adapter keeps working untouched.
//
// The adapter is written against a `doc` (document-like) object so it can be
// unit-tested in Node against a fake DOM. In the extension the real
// `document` is passed in by the content script.
//
// HONEST LIMIT: these selectors are best-effort reconstructions of the Gemini
// web UI (rich-text prompt box, Send/Stop buttons, markdown response blocks).
// They have NOT been verified against the live site in this environment
// (no logged-in Gemini account here). Each selector group has fallbacks and
// every failure returns a clear error string naming the missing element, so
// a UI change is diagnosed in one line instead of failing silently.
//
// Design notes:
// - React-controlled inputs need the native value setter + an 'input' event,
//   otherwise the app never sees the text. contenteditable boxes need
//   textContent + an 'input' event instead.
// - Completion detection: the Stop button is gone AND the latest response
//   text is unchanged for ASK_GEMINI_STABLE_MS (default 2s). Either signal
//   alone is not enough: the stop button can flicker, and text can pause
//   mid-stream.
// - The adapter NEVER throws a bare error from ask(): it returns a structured
//   { ok:false, error } object, and the tool handler turns that into an MCP
//   error string. Timeouts are explicit, never silent.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.YixiuBridgeGeminiAdapter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Selector groups, tried in order. First match wins.
  var SELECTORS = {
    // The box the user types into. Gemini uses a contenteditable rich text
    // area; older layouts used a plain textarea. Last resort: any textarea.
    PROMPT_BOX: [
      'div[contenteditable="true"][aria-label*="Ask Gemini"]',
      'div[contenteditable="true"][aria-label*="Gemini"]',
      'textarea[aria-label*="Ask Gemini"]',
      'textarea[placeholder*="Ask Gemini"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    // Send button. aria-labels vary by locale; the data-test-id and the
    // "send" icon button are the stable fallbacks.
    SEND_BUTTON: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'button[data-test-id="send-button"]',
      'button[aria-label*="send"]',
    ],
    // Shown while the model is streaming; disappears when it is done.
    STOP_BUTTON: [
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop"]',
      'button[data-test-id="stop-button"]',
    ],
    // Model response blocks, newest last. Markdown containers first, then
    // generic response wrappers, then any long text block in the conversation.
    RESPONSE_TEXT: [
      '.model-response-text',
      '[class*="response-content"]',
      '[class*="markdown"]',
      'message-content',
    ],
    // The conversation scroll container (used to scope "latest response").
    CONVERSATION: [
      '[data-test-id="conversation"]',
      'main',
      'body',
    ],
  };

  var DEFAULTS = {
    timeoutMs: 180000,
    pollMs: 500,
    stableMs: 2000,
    model: 'gemini-web',
  };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function queryFirst(doc, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = doc.querySelector(selectors[i]);
        if (el) return { el: el, selector: selectors[i] };
      } catch (e) { /* invalid selector for this DOM — try the next one */ }
    }
    return { el: null, selector: null };
  }

  function queryAll(doc, selectors) {
    var out = [];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var list = doc.querySelectorAll(selectors[i]);
        for (var j = 0; j < list.length; j++) out.push(list[j]);
      } catch (e) { /* skip */ }
    }
    return out;
  }

  function textOf(el) {
    if (!el) return '';
    // innerText respects visibility; textContent is the fallback.
    var t = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : (el.textContent || '');
    return String(t).replace(/\s+\n/g, '\n').trim();
  }

  // Fill a prompt box the way the page's own framework expects.
  function fillPromptBox(box, text, win) {
    var W = win || (typeof window !== 'undefined' ? window : globalThis);
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      try {
        var proto = box.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement : W.HTMLInputElement;
        var setter = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
        if (setter && setter.set) setter.set.call(box, text);
        else box.value = text;
      } catch (e) { box.value = text; }
    } else {
      // contenteditable rich text area
      box.textContent = text;
    }
    try {
      var ev = typeof W.Event === 'function'
        ? new W.Event('input', { bubbles: true })
        : { type: 'input', bubbles: true };
      box.dispatchEvent(ev);
    } catch (e) { /* event dispatch is best-effort */ }
  }

  function createAdapter(doc, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULTS.timeoutMs;
    var pollMs = opts.pollMs || DEFAULTS.pollMs;
    var stableMs = opts.stableMs || DEFAULTS.stableMs;
    var win = opts.win || (typeof window !== 'undefined' ? window : globalThis);

    function findPromptBox() {
      return queryFirst(doc, SELECTORS.PROMPT_BOX);
    }

    function findSendButton() {
      return queryFirst(doc, SELECTORS.SEND_BUTTON);
    }

    function isStreaming() {
      var stop = queryFirst(doc, SELECTORS.STOP_BUTTON);
      return !!stop.el;
    }

    function getAllResponses() {
      var els = queryAll(doc, SELECTORS.RESPONSE_TEXT);
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (t) out.push(t);
      }
      return out;
    }

    function getLatestResponseText() {
      var all = getAllResponses();
      return all.length ? all[all.length - 1] : '';
    }

    // Wait until streaming ends: stop button gone AND text stable for stableMs.
    async function waitForCompletion(startedAt, deadline) {
      var lastText = '';
      var stableSince = null;
      var polls = 0;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        polls++;
        var streaming = isStreaming();
        var text = getLatestResponseText();
        if (!streaming) {
          if (text && text === lastText) {
            if (stableSince === null) stableSince = Date.now();
            if (Date.now() - stableSince >= stableMs) {
              return { ok: true, answer: text, polls: polls, elapsedMs: Date.now() - startedAt };
            }
          } else {
            lastText = text;
            stableSince = null;
          }
        } else {
          lastText = text;
          stableSince = null;
        }
      }
      return {
        ok: false,
        error: 'gemini answer did not finish within timeout (' + Math.round((deadline - startedAt) / 1000) + 's) — still streaming or page changed',
        partial: getLatestResponseText(),
        polls: polls,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Full ask flow: find box -> fill -> send -> wait -> extract.
    // Always resolves to a structured result; never throws.
    async function ask(prompt, askOpts) {
      var startedAt = Date.now();
      askOpts = askOpts || {};
      var limit = askOpts.timeoutMs || timeoutMs;
      var deadline = startedAt + limit;
      try {
        if (!prompt || !String(prompt).trim()) {
          return { ok: false, error: 'ask_gemini: prompt is empty' };
        }
        var box = findPromptBox();
        if (!box.el) {
          return { ok: false, error: 'gemini prompt box not found — UI may have changed (tried: ' + SELECTORS.PROMPT_BOX.join(' | ') + ')' };
        }
        fillPromptBox(box.el, String(prompt), win);
        var send = findSendButton();
        if (!send.el) {
          return { ok: false, error: 'gemini send button not found — UI may have changed (tried: ' + SELECTORS.SEND_BUTTON.join(' | ') + ')' };
        }
        if (send.el.disabled) {
          return { ok: false, error: 'gemini send button is disabled — the prompt may not have registered, or a previous answer is still running' };
        }
        try { send.el.click(); } catch (e) {
          return { ok: false, error: 'gemini send button click failed: ' + (e && e.message ? e.message : String(e)) };
        }
        var done = await waitForCompletion(startedAt, deadline);
        if (!done.ok) return done;
        if (!done.answer) {
          return { ok: false, error: 'gemini answer finished but no response text could be extracted — UI may have changed', polls: done.polls, elapsedMs: done.elapsedMs };
        }
        return { ok: true, answer: done.answer, model: DEFAULTS.model, elapsedMs: done.elapsedMs, polls: done.polls };
      } catch (e) {
        return { ok: false, error: 'gemini adapter error: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    return {
      SELECTORS: SELECTORS,
      findPromptBox: findPromptBox,
      findSendButton: findSendButton,
      isStreaming: isStreaming,
      getAllResponses: getAllResponses,
      getLatestResponseText: getLatestResponseText,
      waitForCompletion: waitForCompletion,
      ask: ask,
    };
  }

  return { createAdapter: createAdapter, SELECTORS: SELECTORS, DEFAULTS: DEFAULTS };
});
