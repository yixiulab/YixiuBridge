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
// - Send verification: after clicking Send, the adapter checks the message
//   actually left the box — STRONG evidence only: streaming started, the
//   box cleared, or a NEW genuine model response appeared (new/changed vs
//   the pre-fill baseline, inside a real response container, never
//   home-screen text — v0.3.3, task -006: the old "any text changed"
//   heuristic counted a re-rendered home screen as "sent", and the
//   home-screen greeting was then returned as the "answer"). The live-text
//   branch also covers short answers whose streaming already finished
//   inside sendCheckMs. If not sent, it retries with an Enter keydown,
//   then fails fast with a clear error instead of waiting out the full
//   timeout for a message that was never sent.
// - Home-screen guard (v0.3.3, task -006): getLatestResponseText reads
//   ONLY genuine model-response containers (scoped to the conversation
//   container when it exists) and never returns home-screen text (the
//   hero greeting / suggestion chips are filtered out). waitForCompletion
//   compares against a baseline captured before the prompt was filled, so
//   pre-existing page text can never be mistaken for this turn's answer,
//   and fails with a clear "no response appeared" error when no NEW model
//   text ever shows up.
// - Response detection (v0.3.6, task -009): structural, not single-
//   selector. Each model turn is a <model-response> custom element inside
//   a div.conversation-container; its rendered markdown is
//   structured-content-container.model-response-text >
//   .markdown.markdown-main-panel. The response query is scoped to the
//   REAL history container (infinite-scroller.chat-history or
//   [data-test-id="chat-history-container"]) — NEVER
//   [data-test-id="conversation"], which on the real page matches the
//   SIDEBAR conversation-list links: the 0.3.3–0.3.5 scope bug made every
//   response query run inside a sidebar link, so ask_gemini failed with
//   "no response appeared" while the answer was rendered on the page.
//   A "no response appeared" failure now carries a structural dump of
//   the conversation area (element counts, scope, last turns) so the
//   next miss is diagnosable from the failed-task file alone.
// - Send-button discovery (v0.3, ground truth from the user's real page,
//   2026-11-21): the real Send button is an Angular Material button with
//   NO usable aria-label — it carries a <mat-icon
//   data-mat-icon-name="arrow_upward" fonticon="arrow_upward">. The 7
//   aria-label selectors all missed it and ask_gemini failed with "send
//   button not found" even though the blue arrow was visible on screen.
//   Discovery is now layered: (1) the arrow_upward icon -> closest
//   button; (2) the original aria-label / data-test-id / class selectors;
//   (3) broad fallbacks (title substrings, data-test-id*="send",
//   class*="send", role="button" with send-like text, an SVG arrow icon
//   inside a button). When several match, the button nearest the prompt
//   box in the DOM tree wins. If nothing is found, the error now dumps
//   the buttons near the prompt box (tag, aria-label, title, class,
//   data-test-id, icon, text) so the next failure is self-diagnosing.
// - Enter fallback (v0.3.2, ground truth from task -005, 2026-11-21):
//   the new adapter was confirmed running ([adapter_version: 0.3.1] in
//   the error) yet every layer missed and the 26-button dump had no send
//   control at all — the visible blue arrow is NOT a <button> (probably
//   a div/custom element with a click handler, or inside a shadow root).
//   So when no button is found, ask() now presses Enter on the prompt
//   box first and verifies the message left, exactly as after a click.
//   Only when Enter also fails does it report "not found", with the
//   nearby-buttons dump PLUS the arrow icon's ancestor chain (icon +
//   4 levels up: tag/class/role), so the next failure names the real
//   control element instead of guessing.
// - Model selection (v0.2, built from the user's real screenshot of the
//   Gemini web model menu, Chinese UI):
//     自动 / 根据需求调整回答
//     日常帮助 / 4 Hydrogen
//     更深入的分析 / 4 Neon        <- currently selected (checkmark)
//     代码和复杂工作 / 4 Carbon     <- LOCKED (lock icon, needs a paid plan?)
//   plus a 思考等级 (thinking level) submenu. The picker button at the top
//   shows the current model, e.g. "Neon 高" (model name + thinking level),
//   so selection is verified by SUBSTRING match on the button text, never
//   by exact equality. A locked model is never clicked: selectModel fails
//   fast with a clear error naming the unlocked alternatives. Switching
//   models may start a new chat in Gemini web; ask_gemini asks one
//   self-contained question per call, so it does not depend on history.

// - Version self-check (v0.3.1): every ask/listModels result and error
//   carries adapter_version (ADAPTER_VERSION, same as the release
//   version). The router verifies it in the ping handshake before every
//   ask, and the runner logs it next to the bridge version — a stale
//   adapter in an old tab is now diagnosed from the result alone.
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
    // "send" icon button are the stable fallbacks. Chinese UI labels
    // included: the page the user actually sees is localised.
    SEND_BUTTON: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'button[data-test-id="send-button"]',
      'button[aria-label*="send"]',
      'button[aria-label="发送消息"]',
      'button[aria-label*="发送"]',
      'button.send-button',
    ],
    // Broad send-button fallbacks (v0.3). Tried only after the icon lookup
    // and the original selectors above. Title variants included because
    // some layouts label the button via title instead of aria-label.
    SEND_BUTTON_BROAD: [
      'button[title*="发送"]',
      'button[title*="Send"]',
      'button[title*="提交"]',
      'button[title*="Submit"]',
      'button[aria-label*="提交"]',
      'button[aria-label*="Submit"]',
      'button[data-test-id*="send"]',
      'button[data-test-id*="Send"]',
      'button[class*="send"]',
      'button[class*="Send"]',
    ],
    // Shown while the model is streaming; disappears when it is done.
    STOP_BUTTON: [
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop"]',
      'button[data-test-id="stop-button"]',
    ],
    // Model turns on the real Gemini page (v0.3.6, task -009). Structure
    // confirmed by independent DOM analyses (Apr–Jul 2026) and by the -009
    // failure itself: each exchange is a div.conversation-container; the
    // model turn is a <model-response> custom element whose rendered
    // markdown is structured-content-container.model-response-text >
    // .markdown.markdown-main-panel. Layer 1 is tried before the legacy
    // selectors below; leaf-most filtering (getResponseEls) drops a turn
    // element whenever its inner markdown is also present, so one turn
    // yields exactly one text.
    RESPONSE_TURNS: [
      'model-response .markdown',
      'model-response structured-content-container.model-response-text',
      'model-response',
    ],
    // Model response blocks, newest last. Legacy layouts / other builds:
    // the old Bard-era .model-response-text, generic response wrappers,
    // markdown containers, and the message-content custom element.
    RESPONSE_TEXT: [
      '.model-response-text',
      '[class*="response-content"]',
      '[class*="markdown"]',
      'message-content',
    ],
    // The conversation scroll container (used to scope "latest response").
    // REAL history containers only. NEVER [data-test-id="conversation"]:
    // on the real page that selector matches the SIDEBAR conversation-list
    // links (a[data-test-id="conversation"], one per saved chat) — the
    // 0.3.3–0.3.5 scope bug (task -009): responseScope() returned the
    // first sidebar link, so every response query ran inside a 20-character
    // link title and found nothing, while the answer was rendered on the
    // page. The mock page had invented [data-test-id="conversation"] as
    // the chat container, so no test ever saw it.
    CONVERSATION: [
      'infinite-scroller.chat-history',
      '[data-test-id="chat-history-container"]',
      'main',
      'body',
    ],
    // The model switcher button at the top of the Gemini page. It shows the
    // current model, e.g. "Neon 高" (model name + thinking level). The
    // data-test-id / aria-label entries are best-effort; the text scan in
    // findModelPickerButton() is the fallback (the button always shows a
    // model name). NOTE: no generic [aria-haspopup="menu"] fallback here —
    // too broad, it could open the wrong menu.
    MODEL_PICKER_BUTTON: [
      'button[data-test-id="model-switcher"]',
      'button[aria-label*="模型"]',
      'button[aria-label*="model"]',
      'button[aria-label*="Model"]',
      '[data-test-id="model-picker"]',
    ],
    // Menu items: one per model. role=menuitemradio is the most likely shape
    // (a single-choice list); menuitem/option are the fallbacks. The
    // 思考等级 (thinking level) submenu items match these too and are
    // filtered out by parseModelItem / selectThinkingLevel.
    MODEL_MENU_ITEMS: [
      '[role="menuitemradio"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[data-test-id*="model-option"]',
    ],
  };

  // Model codenames seen in the real Gemini web menu (Nov 2026). The "4"
  // badge in the UI ("4 Hydrogen") is a version mark, not part of the name.
  var KNOWN_MODELS = ['Hydrogen', 'Neon', 'Carbon'];
  // Chinese labels of the same menu items, in menu order.
  var MODEL_LABELS = ['自动', '日常帮助', '更深入的分析', '代码和复杂工作'];
  // Recommended high model: the highest unlocked item on the user's account.
  var RECOMMENDED_MODEL = 'Neon';

  var DEFAULTS = {
    timeoutMs: 180000,
    pollMs: 500,
    stableMs: 2000,
    sendCheckMs: 1000,
    model: 'gemini-web',
  };

  // Adapter version — stamped into EVERY ask/listModels result and error.
  // It MUST match the release version (manifest, package.json, service
  // worker, content script). The router compares it with the running
  // extension version before every ask: a Gemini tab opened before an
  // extension update still runs the OLD adapter, and without this stamp
  // the failure looks identical to a UI change (this bit us on 2026-11-21:
  // task -003 failed with the 0.2.0 error text while the panel showed
  // 0.3.0). Bump this together with the release version, everywhere.
  var ADAPTER_VERSION = '0.4.13';

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

  // Fallback submit: an Enter keypress on the prompt box, the way a user
  // submits. Some layouts only wire Enter, or the clicked button turns out
  // to be a decoy (e.g. a "Send feedback" button that also matches).
  // Hardened (v0.3.3): focus the editable element first, then dispatch a
  // full keydown + keypress + keyup sequence with a proper Enter event
  // (key/code 'Enter', keyCode 13, bubbles, cancelable) on the element
  // itself — not on a wrapper. Some pages only listen for keydown, others
  // for keyup; sending the whole sequence covers both. keyCode/which are
  // set in the init dict and, where the event object allows it, re-applied
  // with defineProperty (the KeyboardEvent constructor ignores keyCode in
  // its init dict in real browsers). A listener throwing must not break
  // the sequence.
  function dispatchEnter(box, win) {
    var el = box && box.el ? box.el : box;
    if (!el || typeof el.dispatchEvent !== 'function') return;
    var W = win || (typeof window !== 'undefined' ? window : globalThis);
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) { /* focus is best-effort */ }
    var types = ['keydown', 'keypress', 'keyup'];
    for (var i = 0; i < types.length; i++) {
      var ev = null;
      try {
        if (typeof W.KeyboardEvent === 'function') {
          ev = new W.KeyboardEvent(types[i], { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        }
      } catch (e) { ev = null; }
      if (!ev && typeof W.Event === 'function') {
        try {
          ev = new W.Event(types[i], { bubbles: true, cancelable: true });
          ev.key = 'Enter'; ev.code = 'Enter'; ev.keyCode = 13; ev.which = 13;
        } catch (e2) { ev = null; }
      }
      if (!ev) continue;
      try { Object.defineProperty(ev, 'keyCode', { value: 13 }); } catch (e) { /* already set */ }
      try { Object.defineProperty(ev, 'which', { value: 13 }); } catch (e) { /* already set */ }
      try { el.dispatchEvent(ev); } catch (e) { /* a listener throwing must not break the sequence */ }
    }
  }

  function createAdapter(doc, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULTS.timeoutMs;
    var pollMs = opts.pollMs || DEFAULTS.pollMs;
    var stableMs = opts.stableMs || DEFAULTS.stableMs;
    var sendCheckMs = (opts.sendCheckMs !== undefined) ? opts.sendCheckMs : DEFAULTS.sendCheckMs;
    var win = opts.win || (typeof window !== 'undefined' ? window : globalThis);
    // requestTrustedClick(levelText) -> Promise<{ok} | {ok:false, error}>.
    // Injected by the content script (v0.4.12): asks the background
    // service worker for a real CDP trusted click on a thinking-level
    // item. Absent in tests and when the background cannot do CDP — the
    // adapter then falls back to the synthetic chain.
    var requestTrustedClick = opts.requestTrustedClick || null;
    // requestTrustedSendClick() -> Promise<{ok} | {ok:false, error}>.
    // Same CDP trusted-click path, aimed at the SEND button instead
    // (v0.4.13, teacher-001: click + Enter both missed on the real
    // page). Injected by the content script; absent in tests.
    var requestTrustedSendClick = opts.requestTrustedSendClick || null;
    // The most recent ask's prompt + response baseline, for
    // recoverLastAnswer: it proves whether anything NEW appeared since
    // this ask started, so a previous turn's answer is never returned
    // as this turn's.
    var lastAsk = null;

    function findPromptBox() {
      return queryFirst(doc, SELECTORS.PROMPT_BOX);
    }

    function attrOf(el, name) {
      try {
        var v = el && el.getAttribute ? el.getAttribute(name) : null;
        return (v === null || v === undefined) ? '' : String(v);
      } catch (e) { return ''; }
    }

    // A real <button>, or an element acting as one (role="button"). The
    // Gemini page uses real buttons, but a role=button div is clickable the
    // same way and must not be dropped by the discovery below.
    function isClickableButton(el) {
      if (!el) return false;
      if (el.tagName === 'BUTTON') return true;
      try {
        return el.getAttribute ? el.getAttribute('role') === 'button' : false;
      } catch (e) { return false; }
    }

    // Nearest <button> (or role=button) ancestor of an element — the icon
    // inside the send button has no button semantics of its own. Uses native
    // closest() when available, falls back to walking the parent chain
    // (fake DOM in tests).
    function closestButton(el) {
      if (!el) return null;
      try {
        if (typeof el.closest === 'function') {
          var b = el.closest('button, [role="button"]');
          if (b) return b;
        }
      } catch (e) { /* fall through to the parent walk */ }
      var n = el;
      while (n) {
        if (isClickableButton(n)) return n;
        n = n.parent || n.parentNode || null;
      }
      return null;
    }

    // Does this element look like a send/submit control? Checks aria-label,
    // title, data-test-id, data-tooltip and visible text, Chinese + English.
    function looksLikeSend(el) {
      var hay = [
        attrOf(el, 'aria-label'), attrOf(el, 'title'),
        attrOf(el, 'data-test-id'), attrOf(el, 'data-tooltip'),
        textOf(el),
      ].join(' ').toLowerCase();
      return hay.indexOf('发送') !== -1 || hay.indexOf('提交') !== -1
        || hay.indexOf('send') !== -1 || hay.indexOf('submit') !== -1;
    }

    function ancestorsOf(el) {
      var out = [];
      var n = el;
      while (n) { out.push(n); n = n.parent || n.parentNode || null; }
      return out;
    }

    // DOM-tree distance between two elements: steps up to their lowest common
    // ancestor, from both sides. Used to prefer the send button nearest the
    // prompt box when several candidates match.
    function domDistance(a, b) {
      if (!a || !b) return 1e9;
      var ancA = ancestorsOf(a);
      var ancB = ancestorsOf(b);
      for (var i = 0; i < ancA.length; i++) {
        var j = ancB.indexOf(ancA[i]);
        if (j !== -1) return i + j;
      }
      return 1e9;
    }

    // One-line description of a button for diagnostics: tag, aria-label,
    // title, class, data-test-id, role, icon name, visible text.
    function describeButton(el) {
      var parts = [];
      parts.push(el.tagName ? el.tagName.toLowerCase() : 'element');
      var label = attrOf(el, 'aria-label');
      if (label) parts.push('aria-label="' + label.slice(0, 60) + '"');
      var title = attrOf(el, 'title');
      if (title) parts.push('title="' + title.slice(0, 60) + '"');
      var cls = attrOf(el, 'class');
      if (cls) parts.push('class="' + cls.slice(0, 80) + '"');
      var dtid = attrOf(el, 'data-test-id');
      if (dtid) parts.push('data-test-id="' + dtid + '"');
      var role = attrOf(el, 'role');
      if (role) parts.push('role="' + role + '"');
      try {
        var iconEl = el.querySelector ? el.querySelector('[data-mat-icon-name]') : null;
        if (iconEl) {
          var iname = attrOf(iconEl, 'data-mat-icon-name') || attrOf(iconEl, 'fonticon');
          if (iname) parts.push('icon="' + iname + '"');
        }
      } catch (e) { /* ignore */ }
      var t = textOf(el);
      if (t) parts.push('text="' + t.slice(0, 40) + '"');
      if (el.disabled) parts.push('[disabled]');
      return parts.join(' ');
    }

    // Buttons near the prompt box, nearest first, max 10. Used in the
    // not-found error so the next failure is self-diagnosing.
    function nearbyButtonsDump(boxEl) {
      var all = queryAll(doc, ['button', '[role="button"]']);
      all.sort(function (a, b) { return domDistance(a, boxEl) - domDistance(b, boxEl); });
      var lines = [];
      var total = all.length;
      for (var i = 0; i < all.length && lines.length < 10; i++) {
        lines.push(describeButton(all[i]));
      }
      return { total: total, lines: lines };
    }

    // One-line description of one ancestor in the icon chain: tag, up to 3
    // classes, role, aria-label, and the icon name when the node is an icon.
    function describeAncestor(el) {
      var s = el.tagName ? el.tagName.toLowerCase() : 'element';
      var cls = attrOf(el, 'class');
      if (cls) s += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.');
      var role = attrOf(el, 'role');
      if (role) s += '[role=' + role + ']';
      var label = attrOf(el, 'aria-label');
      if (label) s += '[aria-label="' + label.slice(0, 40) + '"]';
      var iname = attrOf(el, 'data-mat-icon-name') || attrOf(el, 'fonticon');
      if (iname) s += ' icon="' + iname + '"';
      return s;
    }

    // Ancestor chain of the send-arrow icon, for the not-found error: the
    // arrow is visible in the UI but matched no <button>, so the error
    // must say what element actually carries it (a div? a custom element?
    // a shadow host?). The icon itself + 4 levels up, describeButton-style.
    // 'No arrow_upward icon found in the page.' when the icon is gone too
    // (page re-rendered without it, or it lives in a shadow root the
    // content script cannot see into).
    function iconAncestorChain() {
      var icons = queryAll(doc, ['[data-mat-icon-name*="arrow_up"]', '[fonticon*="arrow_up"]']);
      if (!icons.length) return 'No arrow_upward icon found in the page.';
      var parts = [];
      var n = icons[0];
      for (var i = 0; i < 5 && n; i++) {
        parts.push(describeAncestor(n));
        n = n.parent || n.parentNode || null;
      }
      return parts.join(' > ');
    }

    // Layered send-button discovery. Returns { el, selector, candidates }.
    // `selector` names how the winner was found (for error messages);
    // `candidates` is the full ranked list (for diagnostics).
    function findSendButton(boxEl) {
      var cands = [];
      var seen = [];
      function add(el, via) {
        if (!isClickableButton(el)) return;
        if (seen.indexOf(el) !== -1) return;
        seen.push(el);
        cands.push({ el: el, via: via });
      }
      // Layer 1 — the real Gemini button (ground truth, 2026-11-21): an
      // Angular Material button whose <mat-icon data-mat-icon-name=
      // "arrow_upward" (fonticon="arrow_upward") carries no aria-label.
      var icons = queryAll(doc, ['[data-mat-icon-name*="arrow_up"]', '[fonticon*="arrow_up"]']);
      for (var i = 0; i < icons.length; i++) {
        add(closestButton(icons[i]), 'icon[data-mat-icon-name="arrow_upward"] -> closest button');
      }
      // Layer 2 — the original aria-label / data-test-id / class selectors.
      var orig = queryAll(doc, SELECTORS.SEND_BUTTON);
      for (var j = 0; j < orig.length; j++) {
        add(orig[j], 'selector match');
      }
      // Layer 3 — broad fallbacks.
      var broad = queryAll(doc, SELECTORS.SEND_BUTTON_BROAD);
      for (var k = 0; k < broad.length; k++) {
        add(broad[k], 'broad fallback selector');
      }
      // role="button" elements with send-like text/labels.
      var roleBtns = queryAll(doc, ['[role="button"]']);
      for (var r = 0; r < roleBtns.length; r++) {
        if (looksLikeSend(roleBtns[r])) add(closestButton(roleBtns[r]), 'role=button + send-like text');
      }
      // An inline SVG arrow icon inside a button (other icon sets).
      var svgs = queryAll(doc, ['button svg']);
      for (var g = 0; g < svgs.length; g++) {
        var svgHay = (attrOf(svgs[g], 'class') + ' ' + attrOf(svgs[g], 'aria-label')).toLowerCase();
        if (svgHay.indexOf('arrow') !== -1 || svgHay.indexOf('upward') !== -1 || svgHay.indexOf('send') !== -1) {
          add(closestButton(svgs[g]), 'svg arrow icon inside button');
        }
      }
      if (!cands.length) return { el: null, selector: null, candidates: [] };
      // Rank: visible + enabled first, then nearest to the prompt box.
      // A disabled button is still returned when it is the only candidate,
      // so ask() can report "disabled" instead of "not found".
      cands.sort(function (a, b) {
        var va = isVisible(a.el) ? 0 : 1;
        var vb = isVisible(b.el) ? 0 : 1;
        if (va !== vb) return va - vb;
        var da = a.el.disabled ? 1 : 0;
        var db = b.el.disabled ? 1 : 0;
        if (da !== db) return da - db;
        return domDistance(a.el, boxEl) - domDistance(b.el, boxEl);
      });
      return { el: cands[0].el, selector: cands[0].via, candidates: cands };
    }

    function isStreaming() {
      var stop = queryFirst(doc, SELECTORS.STOP_BUTTON);
      return !!stop.el;
    }

    // Start-of-text prefixes of the Gemini home screen (hero greeting), in
    // the languages the page shows. A genuine model answer essentially
    // never STARTS with one of these; the home screen always does.
    // Normalised (lowercase, whitespace-collapsed) before comparing, and
    // only a prefix match counts — an answer that merely mentions one of
    // these phrases mid-text is unaffected.
    var HOME_HERO_PREFIXES = [
      '需要我为你做些什么',
      '有什么可以帮你',
      '我能帮你做什么',
      'what can i help with',
      'how can i help you',
      'how can i help',
    ];
    function isHomeScreenText(t) {
      if (!t) return false;
      var low = String(t).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!low) return false;
      for (var i = 0; i < HOME_HERO_PREFIXES.length; i++) {
        if (low.indexOf(HOME_HERO_PREFIXES[i]) === 0) return true;
      }
      return false;
    }

    // The container a real model turn renders into. On the home screen
    // there is no turn yet, so the container is empty (or absent) — scoping
    // the response query to it keeps the hero greeting and the suggestion
    // chips (which live outside the conversation) out of the answer.
    // Falls back to the whole document when no conversation container
    // exists; the home-screen filter below still applies there.
    function responseScope() {
      var c = queryFirst(doc, SELECTORS.CONVERSATION);
      return c.el || doc;
    }

    // Element children, as a plain array. Works on the real DOM
    // (HTMLCollection) and the fake DOM (plain array) alike.
    function childElements(el) {
      var out = [];
      if (!el || !el.children) return out;
      var c = el.children;
      for (var i = 0; i < c.length; i++) out.push(c[i]);
      return out;
    }

    function isAncestorOf(a, b) {
      var n = b && (b.parent || b.parentNode);
      while (n) {
        if (n === a) return true;
        n = n.parent || n.parentNode;
      }
      return false;
    }

    // Drop any candidate that is an ancestor of another candidate: the
    // model turn (<model-response>) and its inner markdown both match,
    // but only the innermost text is the answer — keeping both would
    // return the same answer twice (once with the action-button labels).
    function leafMost(els) {
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var dominated = false;
        for (var j = 0; j < els.length; j++) {
          if (i !== j && isAncestorOf(els[i], els[j])) { dominated = true; break; }
        }
        if (!dominated) out.push(els[i]);
      }
      return out;
    }

    // Candidates in document order. queryAll concatenates per-selector
    // results, so a legacy element from an old turn could sort after a
    // structural element from the newest turn; getLatestResponseText
    // takes the last one, so order must be real document order, not
    // selector-group order.
    function documentOrder(els) {
      var set = [];
      for (var i = 0; i < els.length; i++) {
        if (set.indexOf(els[i]) === -1) set.push(els[i]);
      }
      var ordered = [];
      var root = (doc && doc.documentElement) || doc;
      (function walk(node) {
        if (!node) return;
        if (set.indexOf(node) !== -1) ordered.push(node);
        var kids = childElements(node);
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
      })(root);
      return ordered;
    }

    // All model-response elements, leaf-most, in document order:
    // Layer 1 — structural turns on the real page (<model-response> and
    // its inner markdown); Layer 2 — legacy selectors for old layouts.
    // The sidebar links (a[data-test-id="conversation"]) match none of
    // these, so sidebar titles can never be read as an answer.
    function getResponseEls() {
      var scope = responseScope();
      var els = [];
      var seen = [];
      function add(list) {
        for (var i = 0; i < list.length; i++) {
          if (seen.indexOf(list[i]) === -1) { seen.push(list[i]); els.push(list[i]); }
        }
      }
      add(queryAll(scope, SELECTORS.RESPONSE_TURNS));
      add(queryAll(scope, SELECTORS.RESPONSE_TEXT));
      return documentOrder(leafMost(els));
    }

    // One-line structural description of an element: tag, up to 3 classes,
    // data-test-id, role. No text — see describeTurn for the snippet.
    function describeEl(el) {
      var s = el.tagName ? el.tagName.toLowerCase() : 'element';
      var cls = attrOf(el, 'class');
      if (cls) s += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.');
      var dtid = attrOf(el, 'data-test-id');
      if (dtid) s += '[data-test-id="' + dtid.slice(0, 40) + '"]';
      var role = attrOf(el, 'role');
      if (role) s += '[role=' + role + ']';
      return s;
    }

    // One turn in the dump: its own shape, its child tags, and the first
    // ~60 chars of its text (a snippet for identification, never the
    // answer itself). Home-screen text is never included: the hero
    // greeting / suggestion chips must not leak into an error string,
    // the same rule as for answers (task -006).
    function describeTurn(el) {
      var s = describeEl(el);
      var kids = childElements(el);
      if (kids.length) {
        var tags = [];
        for (var i = 0; i < kids.length && tags.length < 6; i++) {
          tags.push(kids[i].tagName ? kids[i].tagName.toLowerCase() : '?');
        }
        s += ' > [' + tags.join(', ') + ']';
      }
      var full = textOf(el).replace(/\s+/g, ' ').trim();
      if (full && !isHomeScreenText(full)) {
        s += ' text="' + full.slice(0, 60) + '"';
      }
      return s;
    }

    // Structural dump of the conversation area, for the "no response
    // appeared" error: counts of the response-shaped elements found
    // document-wide, the scope in use, and the last up to 3 turns.
    // Structural only — counts, tags, classes, short snippets. Never the
    // full page text or the answer itself. Capped at ~2000 chars so the
    // failed-task file stays readable.
    function conversationStructureDump() {
      var counts = {
        'model-response': queryAll(doc, ['model-response']).length,
        'user-query': queryAll(doc, ['user-query']).length,
        'div.conversation-container': queryAll(doc, ['div.conversation-container']).length,
        '.markdown': queryAll(doc, ['.markdown']).length,
        '.model-response-text': queryAll(doc, ['.model-response-text']).length,
        'message-content': queryAll(doc, ['message-content']).length,
      };
      var parts = [];
      for (var k in counts) parts.push(k + '=' + counts[k]);
      var lines = ['elements found: ' + parts.join(', ')];
      lines.push('scope: ' + describeEl(responseScope()));
      var turns = queryAll(doc, ['div.conversation-container']);
      if (!turns.length) turns = childElements(responseScope());
      var start = Math.max(0, turns.length - 3);
      for (var i = start; i < turns.length; i++) {
        lines.push('turn[' + i + ']: ' + describeTurn(turns[i]));
      }
      return lines.join(' | ').slice(0, 2000);
    }

    // Genuine model-response texts only: scoped to the conversation
    // container, and home-screen text (hero greeting / suggestion chips)
    // is filtered out. On the home screen with no conversation this
    // returns [] — never the suggestions (task -006).
    function getAllResponses() {
      var els = getResponseEls();
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (t && !isHomeScreenText(t)) out.push(t);
      }
      return out;
    }

    function getLatestResponseText() {
      var all = getAllResponses();
      return all.length ? all[all.length - 1] : '';
    }

    // Snapshot of the response elements (and their text) BEFORE the prompt
    // is filled. waitForCompletion only accepts text that is NEW or
    // CHANGED against this baseline — text that was already on the page
    // (the home screen, a previous turn) can never be reported as this
    // turn's answer.
    function captureResponseBaseline() {
      var out = [];
      var els = getResponseEls();
      for (var i = 0; i < els.length; i++) out.push({ el: els[i], text: textOf(els[i]) });
      return out;
    }

    // Response texts that are new or changed since the baseline (and not
    // home-screen text). Empty when nothing new appeared — the signal
    // waitForCompletion uses to fail with "no response appeared" instead
    // of returning pre-existing page text as an answer.
    function getLiveResponses(baseline) {
      var out = [];
      var els = getResponseEls();
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (!t || isHomeScreenText(t)) continue;
        var found = false;
        var baseText = null;
        for (var j = 0; j < baseline.length; j++) {
          if (baseline[j].el === els[i]) { found = true; baseText = baseline[j].text; break; }
        }
        if (!found || baseText !== t) out.push(t);
      }
      return out;
    }

    // All user-query turns on the page, in document order (real page:
    // <user-query> per turn; fallback to the inner query-text lines).
    // Used by recoverLastAnswer to prove the prompt really left the box.
    function getUserQueryTexts() {
      var els = queryAll(doc, ['user-query']);
      if (!els.length) els = queryAll(doc, ['.query-text-line']);
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var t = textOf(els[i]);
        if (t) out.push(t);
      }
      return out;
    }

    // Read the latest COMPLETE answer already in the tab, without asking
    // again (v0.4.13). This is the recovery path for the 2026-11-22
    // teacher-testpc saga: Gemini had answered in the tab, but the
    // runner's fetch aborted (or the send check misjudged) and the
    // answer was thrown away as a failed file. It only returns an
    // answer when the prompt genuinely left the box:
    //   - with a baseline (the normal case: this adapter instance just
    //     ran the ask), the answer must be NEW or CHANGED since the
    //     baseline captured before the prompt was filled — a previous
    //     turn's text can never qualify;
    //   - without a baseline, the latest user-query turn must carry the
    //     prompt text.
    // A still-streaming answer is refused (it is not complete yet; the
    // in-flight ask will deliver it via the task store). Returns
    // { ok:true, answer, recovered:true } or { ok:false, error }.
    // NOTE: a verbatim repeat of the immediately previous prompt is
    // ambiguous — the latest user query matches, so the previous turn's
    // answer could be returned. The baseline path (the one the runner
    // actually uses) is not affected: a repeat ask creates a NEW
    // response element, so only the new turn counts as live.
    function recoverLastAnswer(prompt, baseline) {
      var p = String(prompt || '').trim();
      var base = baseline || (lastAsk && lastAsk.prompt === p ? lastAsk.baseline : null);
      if (base) {
        // Streaming first: a stream that just started has no text yet,
        // so the live check alone would misreport "no new response"
        // instead of "still streaming".
        if (isStreaming()) return { ok: false, error: 'recover: answer still streaming' };
        var live = getLiveResponses(base);
        if (!live.length) return { ok: false, error: 'recover: no new response appeared since the ask started' };
        return { ok: true, answer: live[live.length - 1], recovered: true };
      }
      var queries = getUserQueryTexts();
      var q = queries.length ? queries[queries.length - 1] : '';
      if (!p || !q || q.indexOf(p.slice(0, 60)) === -1) {
        return { ok: false, error: 'recover: no user query matching the prompt — the prompt was never sent' };
      }
      if (isStreaming()) return { ok: false, error: 'recover: answer still streaming' };
      var latest = getLatestResponseText();
      if (!latest) return { ok: false, error: 'recover: no model answer in the tab' };
      return { ok: true, answer: latest, recovered: true };
    }

    // Poll recoverLastAnswer for up to budgetMs: a slow page may start
    // streaming just after the send checks gave up. Returns the first
    // successful recovery, or the last failure.
    async function pollRecover(prompt, baseline, budgetMs) {
      var deadline = Date.now() + (budgetMs || 1000);
      var last = recoverLastAnswer(prompt, baseline);
      while (!last.ok && Date.now() < deadline) {
        await sleep(200);
        last = recoverLastAnswer(prompt, baseline);
      }
      return last;
    }

    // Measure the send button's viewport centre (CSS pixels) for a CDP
    // trusted click (v0.4.13, same pattern as measureThinkingLevelItem).
    // The background attaches the debugger first, so the coordinates
    // already account for the debug infobar's viewport shift.
    function measureSendButton() {
      var box = findPromptBox();
      if (!box.el) return { ok: false, error: 'measure-send-button: prompt box not found' };
      var send = findSendButton(box.el);
      if (!send.el) return { ok: false, error: 'measure-send-button: send button not found' };
      var r = null;
      try { r = (typeof send.el.getBoundingClientRect === 'function') ? send.el.getBoundingClientRect() : null; } catch (e) { r = null; }
      if (!r) return { ok: false, error: 'measure-send-button: send button has no bounding rect' };
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // ---------- model selection (v0.2) ----------

    // Visible on screen? Real DOM: getClientRects() is empty for
    // display:none. Fake DOM (tests): no getClientRects/offsetParent, so
    // anything present in the document counts as visible.
    function isVisible(el) {
      if (!el) return false;
      try {
        if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
      } catch (e) { /* fall through */ }
      if (typeof el.offsetParent !== 'undefined') return el.offsetParent !== null;
      return true;
    }

    function modelCodenameIn(text) {
      var m = /Hydrogen|Neon|Carbon/i.exec(text || '');
      if (!m) return null;
      var c = m[0].toLowerCase();
      return c.charAt(0).toUpperCase() + c.slice(1);
    }

    // Parse one menu item element into { label, codename, description,
    // selected, locked }. Item text looks like "日常帮助 4 Hydrogen",
    // "自动 根据需求调整回答", or "更深入的分析 4 Neon ✓".
    function parseModelItem(el) {
      var text = textOf(el);
      var codename = modelCodenameIn(text);
      var cleaned = text.replace(/4?\s*(Hydrogen|Neon|Carbon)/i, ' ').replace(/[✓✔🔒]/g, ' ');
      var tokens = cleaned.split(/[\s\n]+/).filter(function (t) { return !!t; });
      var label = tokens.length ? tokens[0] : '';
      var description = tokens.slice(1).join(' ');
      var selected = el.getAttribute('aria-checked') === 'true'
        || el.getAttribute('aria-selected') === 'true'
        || (el.classList && el.classList.contains && el.classList.contains('selected'))
        || (el.querySelector && !!el.querySelector('[class*="check"], [aria-label*="check"], [aria-label*="已选"]'))
        || text.indexOf('✓') !== -1 || text.indexOf('✔') !== -1;
      var locked = el.getAttribute('aria-disabled') === 'true'
        || (el.classList && el.classList.contains && el.classList.contains('locked'))
        || (el.querySelector && !!el.querySelector('[class*="lock"], [aria-label*="lock"], [aria-label*="锁定"]'))
        || text.indexOf('🔒') !== -1;
      return { label: label, codename: codename, description: description, selected: selected, locked: locked, _el: el };
    }

    // The thinking-level names, in the order the real submenu lists them
    // (low, medium, high). Extract a level item's name EXACTLY — never by
    // substring. The real items carry a description after the name
    // ("低 快速、高效" / "中 深度适中" / "高 超级详尽"), and "高" is a
    // substring of "高效" in 低's description, so indexOf("高") matches
    // 低 first. That is the root cause of every version since 0.4.4
    // clicking 低 when asked for 高 on the real page (verify23/24), while
    // the mock — whose items had no descriptions — never caught it
    // (v0.4.12). Returns the level name or null.
    var LEVEL_NAMES = ['低', '中', '高'];
    function levelLabelOf(el) {
      if (!el) return null;
      var text = textOf(el);
      var tokens = String(text || '').split(/[\s\n]+/).filter(function (t) { return !!t; });
      for (var i = 0; i < tokens.length; i++) {
        var tok = tokens[i].replace(/[✓✔]/g, '');
        if (LEVEL_NAMES.indexOf(tok) !== -1) return tok;
      }
      return null;
    }

    function findModelPickerButton() {
      var found = queryFirst(doc, SELECTORS.MODEL_PICKER_BUTTON);
      if (found.el) return found;
      // Fallback: scan buttons for one whose visible text names a model —
      // the picker always shows the current model, e.g. "Neon 高".
      var cands = queryAll(doc, ['button', '[role="button"]']);
      for (var i = 0; i < cands.length; i++) {
        if (!isVisible(cands[i])) continue;
        var t = textOf(cands[i]);
        if (!t) continue;
        if (modelCodenameIn(t) || t.indexOf('自动') !== -1) {
          return { el: cands[i], selector: 'button(text:' + t.slice(0, 20) + ')' };
        }
      }
      return { el: null, selector: null };
    }

    function getCurrentModelText() {
      var btn = findModelPickerButton();
      return btn.el ? textOf(btn.el) : '';
    }

    // All visible model-menu items right now (document-wide: the menu may
    // live in a portal, and the thinking-level submenu is a second menu).
    function readModelMenuItems() {
      var els = queryAll(doc, SELECTORS.MODEL_MENU_ITEMS);
      var seen = [];
      var out = [];
      for (var i = 0; i < els.length; i++) {
        if (seen.indexOf(els[i]) !== -1) continue;
        seen.push(els[i]);
        if (!isVisible(els[i])) continue;
        out.push(els[i]);
      }
      return out;
    }

    async function openModelMenu() {
      var btn = findModelPickerButton();
      if (!btn.el) {
        return { ok: false, error: 'gemini model picker button not found — UI may have changed (tried: ' + SELECTORS.MODEL_PICKER_BUTTON.join(' | ') + ', plus buttons showing a model name)' };
      }
      // The menu sometimes needs a moment (cold tab, slow render) or
      // swallows the first click: poll for it, click once more, poll
      // again. Two consecutive real-machine failures (2026-11-22 verify3
      // and verify4) died here on a single click + one 400ms read.
      for (var attempt = 0; attempt < 2; attempt++) {
        try { btn.el.click(); } catch (e) {
          return { ok: false, error: 'gemini model picker click failed: ' + (e && e.message ? e.message : String(e)) };
        }
        for (var i = 0; i < 10; i++) {
          await sleep(200);
          var items = readModelMenuItems();
          if (items.length) return { ok: true, button: btn, items: items };
        }
      }
      return { ok: false, error: 'gemini model menu did not open — the picker button may be wrong, or the UI changed' };
    }

    async function closeModelMenu() {
      // Escape first (real page closes menus on Escape), then toggle the
      // picker if the menu is still open.
      try {
        var ev;
        if (typeof win.KeyboardEvent === 'function') {
          ev = new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
        } else if (typeof win.Event === 'function') {
          ev = new win.Event('keydown', { bubbles: true, cancelable: true });
          ev.key = 'Escape';
        }
        if (ev) {
          if (doc.body && doc.body.dispatchEvent) doc.body.dispatchEvent(ev);
          else if (doc.documentElement && doc.documentElement.dispatchEvent) doc.documentElement.dispatchEvent(ev);
        }
      } catch (e) { /* best effort */ }
      await sleep(200);
      if (readModelMenuItems().length) {
        var btn = findModelPickerButton();
        if (btn.el) {
          try { btn.el.click(); } catch (e) { /* ignore */ }
          await sleep(200);
        }
      }
    }

    // Open the picker, read the menu, close it again. Never changes the
    // selection. Returns { ok, current, buttonText, models: [...] }.
    async function listModelsImpl() {
      try {
        var opened = await openModelMenu();
        if (!opened.ok) return opened;
        var models = modelItemsFrom(opened.items).map(function (m) {
          return { label: m.label, codename: m.codename, description: m.description, selected: m.selected, locked: m.locked };
        });
        var current = null;
        for (var i = 0; i < models.length; i++) {
          if (models[i].selected) { current = models[i].codename || models[i].label; break; }
        }
        var buttonText = textOf(opened.button.el);
        await closeModelMenu();
        return { ok: true, current: current, buttonText: buttonText, models: models };
      } catch (e) {
        try { await closeModelMenu(); } catch (e2) { /* ignore */ }
        return { ok: false, error: 'gemini list_models error: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    // Every list_models result — success or failure — carries the adapter
    // version, so a stale adapter in an old tab is diagnosed from the
    // result alone instead of looking like a UI change.
    async function listModels() {
      var res = await listModelsImpl();
      if (res && typeof res === 'object') res.adapter_version = ADAPTER_VERSION;
      return res;
    }

    function describeModels(items) {
      return items.map(function (m) {
        return m.label + (m.codename ? ' (' + m.codename + ')' : '')
          + (m.locked ? ' [locked]' : '') + (m.selected ? ' [current]' : '');
      }).join(', ');
    }

    // A menu item is a model if it carries a codename, or its label is one
    // of the known Chinese model labels. Anything else (e.g. the 思考等级
    // submenu trigger) is not a model and must not be listed or selected.
    function isModelItem(m) {
      return !!m.codename || MODEL_LABELS.indexOf(m.label) !== -1;
    }

    function modelItemsFrom(els) {
      return els.map(parseModelItem).filter(isModelItem);
    }

    // Select a model by codename ("Neon") or Chinese label ("日常帮助").
    // Locked models are never clicked. Verifies via the picker button text,
    // which also carries the thinking level ("Neon 高") — substring match
    // only, never exact equality.
    async function selectModel(want) {
      var wantNorm = String(want || '').trim();
      if (!wantNorm) return { ok: false, error: 'gemini model name is empty' };
      var opened = await openModelMenu();
      if (!opened.ok) return opened;
      var items = modelItemsFrom(opened.items);
      var previous = null;
      for (var p = 0; p < items.length; p++) {
        if (items[p].selected) { previous = items[p].codename || items[p].label; break; }
      }
      var wantLower = wantNorm.toLowerCase();
      var match = null;
      var i;
      for (i = 0; i < items.length; i++) {
        if (items[i].codename && items[i].codename.toLowerCase() === wantLower) { match = items[i]; break; }
      }
      if (!match) {
        for (i = 0; i < items.length; i++) {
          if (items[i].label && items[i].label === wantNorm) { match = items[i]; break; }
        }
      }
      if (!match) {
        for (i = 0; i < items.length; i++) {
          if (items[i].codename && items[i].codename.toLowerCase().indexOf(wantLower) !== -1) { match = items[i]; break; }
          if (items[i].label && items[i].label.indexOf(wantNorm) !== -1) { match = items[i]; break; }
        }
      }
      if (!match) {
        await closeModelMenu();
        return { ok: false, error: 'gemini model "' + wantNorm + '" not found — available models: ' + describeModels(items) };
      }
      if (match.locked) {
        await closeModelMenu();
        return { ok: false, error: 'gemini model "' + (match.codename || match.label) + '" is locked (not unlocked on this account — it may need a paid plan). Pick an unlocked model: ' + describeModels(items) };
      }
      if (match.selected) {
        await closeModelMenu();
        return { ok: true, model: match.codename || match.label, alreadySelected: true, previous: previous };
      }
      try { match._el.click(); } catch (e) {
        await closeModelMenu();
        return { ok: false, error: 'gemini model click failed for "' + (match.codename || match.label) + '": ' + (e && e.message ? e.message : String(e)) };
      }
      await sleep(500);
      var btnText = getCurrentModelText();
      var verified = false;
      if (match.codename) {
        verified = !!btnText && btnText.toLowerCase().indexOf(match.codename.toLowerCase()) !== -1;
      } else {
        // "自动" has no codename; the picker may show 自动, or the model
        // Auto resolved to. Accept either.
        verified = !!btnText && (btnText.indexOf(match.label) !== -1
          || KNOWN_MODELS.some(function (c) { return btnText.indexOf(c) !== -1; }));
      }
      if (!verified) {
        await closeModelMenu();
        return { ok: false, error: 'gemini model selection did not stick — picker still shows "' + (btnText || '') + '" after choosing ' + (match.codename || match.label) };
      }
      return { ok: true, model: match.codename || match.label, previous: previous };
    }

    // Read which thinking level is actually selected right now (ground
    // truth): re-open the model menu, open the 思考等级 submenu, and
    // read the item with the checkmark (parseModelItem.selected:
    // aria-checked / checkmark). The picker button text is NOT ground
    // truth — on the real page it often shows just the model name
    // ("Neon") even when a level is set, and it can briefly show a
    // level that never stuck (2026-11-22: verify11 reported 高 with no
    // warning, but the submenu showed 低). Returns { ok, level } with
    // level null when it cannot be read.
    async function readSelectedThinkingLevel() {
      var opened = await openModelMenu();
      if (!opened.ok) return { ok: false, level: null, error: opened.error };
      var trigger = null;
      for (var i = 0; i < opened.items.length; i++) {
        if (textOf(opened.items[i]).indexOf('思考') !== -1) { trigger = opened.items[i]; break; }
      }
      if (!trigger) {
        await closeModelMenu();
        return { ok: false, level: null, error: 'thinking-level submenu not found' };
      }
      try { trigger.click(); } catch (e) {
        await closeModelMenu();
        return { ok: false, level: null, error: 'thinking-level submenu click failed' };
      }
      await sleep(400);
      var levelItems = readModelMenuItems();
      var selected = null;
      for (var j = 0; j < levelItems.length; j++) {
        var m = parseModelItem(levelItems[j]);
        if (m.codename) continue; // a model item, not a level
        if (MODEL_LABELS.indexOf(m.label) !== -1) continue; // a model item
        var t = textOf(levelItems[j]).trim();
        if (t.indexOf('思考') !== -1) continue; // the trigger itself
        if (m.selected) { selected = levelLabelOf(levelItems[j]); break; }
      }
      await closeModelMenu();
      return { ok: true, level: selected };
    }

    // Click an element the way a real user does: a full pointer/mouse
    // event sequence (pointerdown, mousedown, pointerup, mouseup, click).
    // A bare el.click() only dispatches 'click'; the thinking-level
    // submenu items ignore it — verify15 proved 3 plain clicks leave
    // the checkmark on 低 (v0.4.10 retry did not help). Falls back to
    // el.click() when the window has no MouseEvent (tests).
    function clickElement(el) {
      if (!el) return false;
      try {
        if (typeof win.MouseEvent === 'function') {
          var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
          for (var i = 0; i < types.length; i++) {
            var Ctor = (types[i].indexOf('pointer') === 0 && typeof win.PointerEvent === 'function') ? win.PointerEvent : win.MouseEvent;
            el.dispatchEvent(new Ctor(types[i], { bubbles: true, cancelable: true, view: win, button: 0 }));
          }
          return true;
        }
      } catch (e) { /* fall through to .click() */ }
      try { el.click(); return true; } catch (e2) { return false; }
    }

    // Find the element inside a level menu item that actually receives
    // the selection. The selectable control (radio) lives inside the
    // menu item, and a click on the container never reaches it (events
    // bubble up, not down) — verify16 proved 3 full pointer sequences
    // on the container leave the checkmark on 低. Order: inner radio,
    // deepest element holding the level text (usually inside the radio's
    // label, which activates the radio when clicked), the item itself.
    function findLevelClickTarget(item, want) {
      if (!item) return item;
      if (typeof item.querySelector === 'function') {
        try {
          var inner = item.querySelector('input[type="radio"], [role="radio"], mat-radio-button');
          if (inner) return inner;
        } catch (e) { /* fall through */ }
      }
      var best = null;
      var walk = function (el) {
        var kids = el.children || [];
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (levelLabelOf(kid) === want) { best = kid; walk(kid); }
        }
      };
      try { walk(item); } catch (e) { /* fall through */ }
      return best || item;
    }

    // Activate a level item by keyboard instead of a mouse click: focus
    // the target, then dispatch Enter (menu item) or Space (radio). The
    // real page ignores synthetic mouse clicks on the level items
    // (verify15/16: 3 container clicks and 3 full pointer sequences left
    // the checkmark on 低) — but the submenu DOES open on screen, so the
    // UI is alive; keyboard activation is a different input path that
    // Angular Material menus honour. Returns false when the window has
    // no KeyboardEvent.
    function activateLevelByKeyboard(target) {
      if (!target) return false;
      try {
        if (typeof target.focus === 'function') target.focus();
      } catch (e) { /* focus is best-effort */ }
      var isRadio = false;
      try {
        var tag = (target.tagName || '').toLowerCase();
        var role = (typeof target.getAttribute === 'function' && target.getAttribute('role')) || '';
        isRadio = tag === 'input' || role === 'radio' || tag === 'mat-radio-button';
      } catch (e) { isRadio = false; }
      var key = isRadio ? ' ' : 'Enter';
      var code = isRadio ? 'Space' : 'Enter';
      try {
        if (typeof win.KeyboardEvent === 'function') {
          target.dispatchEvent(new win.KeyboardEvent('keydown', { key: key, code: code, bubbles: true, cancelable: true }));
          target.dispatchEvent(new win.KeyboardEvent('keyup', { key: key, code: code, bubbles: true, cancelable: true }));
          return true;
        }
      } catch (e) { /* fall through */ }
      return false;
    }

    // Navigate to a level with the arrow keys, the way a keyboard user
    // does: focus the currently-checked item, press ArrowDown/ArrowUp to
    // walk to the wanted item, press Enter. The user pointed out the
    // submenu defaults to the first item and 高 is two downs away —
    // arrow-key navigation uses the menu's own focus movement instead of
    // trying to click or focus a specific element. The item order is
    // read from the live DOM (levels[]), not assumed, so it works
    // whatever order the page lists the levels in. Returns false when
    // the window has no KeyboardEvent.
    function navigateToLevelByArrows(levels, wantIdx) {
      if (!levels || !levels.length || wantIdx < 0 || wantIdx >= levels.length) return false;
      if (typeof win.KeyboardEvent !== 'function') return false;
      var startIdx = 0;
      for (var i = 0; i < levels.length; i++) {
        if (levels[i].selected) { startIdx = i; break; }
      }
      var startEl = levels[startIdx].el;
      try {
        if (typeof startEl.focus === 'function') startEl.focus();
      } catch (e) { /* focus is best-effort */ }
      var steps = wantIdx - startIdx;
      var key = steps >= 0 ? 'ArrowDown' : 'ArrowUp';
      var n = Math.abs(steps);
      try {
        for (var s = 0; s < n; s++) {
          startEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: key, code: key, bubbles: true, cancelable: true }));
          startEl.dispatchEvent(new win.KeyboardEvent('keyup', { key: key, code: key, bubbles: true, cancelable: true }));
        }
        startEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        startEl.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return true;
      } catch (e) { return false; }
    }

    // Measure a thinking-level item's viewport centre (CSS pixels) for
    // a CDP trusted click. The submenu must already be open — this only
    // reads, it never opens or closes anything. Returns { ok, x, y } or
    // { ok:false, error }. The background calls this AFTER attaching the
    // debugger, so the coordinates already account for the debug
    // infobar's viewport shift (teacher's answer, 2026-11-22).
    function measureThinkingLevelItem(want) {
      var items = readModelMenuItems();
      for (var i = 0; i < items.length; i++) {
        var m = parseModelItem(items[i]);
        if (m.codename) continue;
        if (MODEL_LABELS.indexOf(m.label) !== -1) continue;
        var t = textOf(items[i]).trim();
        if (t.indexOf('思考') !== -1) continue;
        if (levelLabelOf(items[i]) === want) {
          var el = items[i];
          if (!el || typeof el.getBoundingClientRect !== 'function') {
            return { ok: false, error: 'thinking level item has no getBoundingClientRect' };
          }
          var r = el.getBoundingClientRect();
          return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return { ok: false, error: 'thinking level "' + want + '" not found in the open submenu' };
    }

    // Open the model menu, open the 思考等级 submenu, click the given
    // level item. Returns { ok: true } or an error object (invalid-level
    // when the level is not in the menu, apply-failed otherwise).
    async function clickThinkingLevelItem(want, attempt) {
      var opened = await openModelMenu();
      if (!opened.ok) return opened;
      var trigger = null;
      for (var i = 0; i < opened.items.length; i++) {
        if (textOf(opened.items[i]).indexOf('思考') !== -1) { trigger = opened.items[i]; break; }
      }
      if (!trigger) {
        await closeModelMenu();
        return { ok: false, code: 'apply-failed', error: 'gemini thinking-level submenu not found in the model menu — the UI may have changed' };
      }
      try { trigger.click(); } catch (e) {
        await closeModelMenu();
        return { ok: false, code: 'apply-failed', error: 'gemini thinking-level submenu click failed: ' + (e && e.message ? e.message : String(e)) };
      }
      await sleep(400);
      var levelItems = readModelMenuItems();
      var foundLevels = [];
      var levels = [];
      var match = null;
      var wantIdx = -1;
      for (var j = 0; j < levelItems.length; j++) {
        var m = parseModelItem(levelItems[j]);
        if (m.codename) continue; // a model item, not a level
        if (MODEL_LABELS.indexOf(m.label) !== -1) continue; // a model item
        var t = textOf(levelItems[j]).trim();
        if (t.indexOf('思考') !== -1) continue; // the trigger itself
        var lvLabel = levelLabelOf(levelItems[j]);
        if (!lvLabel) continue; // not a level item (no 低/中/高 name)
        foundLevels.push(t);
        levels.push({ el: levelItems[j], label: lvLabel, selected: !!m.selected });
        if (!match && lvLabel === want) { match = levelItems[j]; wantIdx = levels.length - 1; }
      }
      if (!match) {
        await closeModelMenu();
        return { ok: false, code: 'invalid-level', error: 'gemini thinking level "' + want + '" not found — available levels: ' + (foundLevels.join(', ') || 'none') };
      }
      var target = findLevelClickTarget(match, want);
      // Trusted (CDP) click first — the teacher's answer (2026-11-22):
      // synthetic events fail on these items (ISOLATED-world instanceof
      // checks / isTrusted), but a CDP Input.dispatchMouseEvent is a
      // real trusted click. The background attaches the debugger,
      // re-measures the item (the debug infobar shifts the viewport),
      // clicks, and detaches. Falls back to the synthetic chain when no
      // background messenger is injected (tests) or the trusted click
      // fails (e.g. DevTools open on the tab).
      if (requestTrustedClick) {
        try {
          var tc = await requestTrustedClick(want);
          if (tc && tc.ok) return { ok: true };
        } catch (e) { /* fall through to the synthetic chain */ }
      }
      // Activation alternates by attempt: 1st and 3rd walk the menu with
      // the arrow keys (the user's method — the submenu defaults to the
      // first item, 高 is two downs away), 2nd focuses the item and
      // presses Enter (v0.4.10), mouse click kept as a last fallback.
      var activated;
      if ((attempt || 0) % 2 === 0) {
        activated = navigateToLevelByArrows(levels, wantIdx);
        if (!activated) activated = activateLevelByKeyboard(target);
        if (!activated) activated = clickElement(target);
      } else {
        activated = activateLevelByKeyboard(target);
        if (!activated) activated = clickElement(target);
      }
      if (!activated) {
        await closeModelMenu();
        return { ok: false, code: 'apply-failed', error: 'gemini thinking level activation failed' };
      }
      return { ok: true };
    }

    // Select a thinking level (e.g. "高" / "中" / "低") from the 思考等级
    // submenu. The LEVEL itself is validated strictly (an unknown level
    // is a caller error, code 'invalid-level'). Everything about APPLYING
    // it is best-effort (code 'apply-failed'): the submenu may be
    // missing, a click may miss, or the level may not stick — askImpl
    // treats those as a warning and asks anyway instead of failing the
    // whole task (v0.4.2: the real page left the button on "Neon" after
    // choosing 高, which failed every ask until this was non-fatal).
    // Verification (v0.4.4) reads the submenu's checked item via
    // readSelectedThinkingLevel — never the picker button text, which
    // misreported 高 in verify11 while the submenu showed 低.
    // Retry (v0.4.10): the real page sometimes swallows the first click
    // on a submenu item (same quirk as the model menu's first click,
    // v0.4.2) — verify14 proved a single click leaves the checkmark on
    // 低. So click, verify, and retry up to 3 times before giving up.
    async function selectThinkingLevel(level) {
      var want = String(level || '').trim();
      if (!want) return { ok: false, code: 'invalid-level', error: 'gemini thinking level is empty' };
      var lastApplied = null;
      var lastError = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        var clicked = await clickThinkingLevelItem(want, attempt);
        if (!clicked.ok) return clicked;
        await sleep(300);
        var check = await readSelectedThinkingLevel();
        if (check.ok && check.level === want) return { ok: true, thinking: want, applied: want };
        if (check.ok && check.level) lastApplied = check.level;
        if (check.error) lastError = check.error;
      }
      await closeModelMenu();
      if (lastApplied) {
        return { ok: false, code: 'apply-failed', applied: lastApplied, error: 'gemini thinking level did not stick after 3 attempts — selected level is "' + lastApplied + '" after choosing "' + want + '"' };
      }
      return { ok: false, code: 'apply-failed', applied: null, error: 'gemini thinking level could not be confirmed after choosing "' + want + '"' + (lastError ? ' (' + lastError + ')' : '') };
    }

    // ---------- /model selection ----------

    // Wait until streaming ends: stop button gone AND the NEW response
    // text stable for stableMs. `baseline` (from captureResponseBaseline,
    // taken before the prompt was filled) is what makes this safe: only
    // text that is new or changed since the baseline counts. When no NEW
    // model text ever appears — e.g. the prompt was never really sent and
    // the page is still on the home screen — this FAILS with a clear
    // "no response appeared" error instead of returning pre-existing page
    // text as an answer (task -006). When new text appeared but never
    // stabilised, the old timeout error (with the partial answer) is kept.
    async function waitForCompletion(startedAt, deadline, baseline) {
      baseline = baseline || [];
      var lastLive = '';
      var stableSince = null;
      var polls = 0;
      var everLive = false;
      // Evaluate once up front: the caller may have spent the whole
      // timeout budget on send verification (sendCheckMs), so the deadline
      // can already be past when we get here — without this, the loop
      // would never run and a real partial answer would be misreported as
      // "no response appeared".
      var firstLive = getLiveResponses(baseline);
      if (firstLive.length) {
        everLive = true;
        lastLive = firstLive[firstLive.length - 1];
      }
      while (Date.now() < deadline) {
        await sleep(pollMs);
        polls++;
        var streaming = isStreaming();
        var live = getLiveResponses(baseline);
        var text = live.length ? live[live.length - 1] : '';
        if (text) everLive = true;
        if (!streaming && text) {
          if (text === lastLive) {
            if (stableSince === null) stableSince = Date.now();
            if (Date.now() - stableSince >= stableMs) {
              return { ok: true, answer: text, polls: polls, elapsedMs: Date.now() - startedAt };
            }
          } else {
            lastLive = text;
            stableSince = null;
          }
        } else {
          // Still streaming, or nothing new yet: keep the newest text as
          // the partial answer, but never finish while the stop button is
          // up, and never carry a stale "stable" across a gap with no
          // live text.
          lastLive = text || '';
          stableSince = null;
        }
      }
      if (!everLive) {
        return {
          ok: false,
          error: 'gemini no response appeared — the prompt may not have been sent, or the page never rendered a model response (still on the home screen?) [adapter_version: ' + ADAPTER_VERSION + '] Conversation structure: ' + conversationStructureDump(),
          partial: '',
          polls: polls,
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        ok: false,
        error: 'gemini answer did not finish within timeout (' + Math.round((deadline - startedAt) / 1000) + 's) — still streaming or page changed',
        partial: lastLive,
        polls: polls,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Full ask flow: find box -> fill -> send -> wait -> extract.
    // Always resolves to a structured result; never throws.
    async function askImpl(prompt, askOpts) {
      var startedAt = Date.now();
      askOpts = askOpts || {};
      var limit = askOpts.timeoutMs || timeoutMs;
      var deadline = startedAt + limit;
      try {
        if (!prompt || !String(prompt).trim()) {
          return { ok: false, error: 'ask_gemini: prompt is empty' };
        }
        // Model selection happens BEFORE the prompt box is touched: a
        // failed selection must not leave a half-filled question behind.
        // No model given = use whatever the user already selected in the UI.
        var selectedModel = null;
        if (askOpts.model) {
          var sel = await selectModel(askOpts.model);
          if (!sel.ok) return sel;
          selectedModel = sel.model;
        }
        // Thinking level: an invalid level is a caller error and fails
        // fast; a failure to APPLY it only warns (v0.4.2) — the answer
        // is the deliverable, the level is best-effort. The result
        // carries the ACTUALLY applied level (v0.4.10: read from the
        // submenu checkmark, never the button text) so the done file
        // reports what was really used, not just what was requested.
        var thinkingWarning = null;
        var appliedThinking = null;
        if (askOpts.thinking) {
          var th = await selectThinkingLevel(askOpts.thinking);
          if (!th.ok) {
            if (th.code === 'invalid-level') return th;
            thinkingWarning = th.error;
            appliedThinking = th.applied || null;
          } else {
            appliedThinking = th.applied || askOpts.thinking;
          }
        }
        // The model switch can re-render the input area and can leave the
        // menu open; close it and let the DOM settle before looking for
        // the prompt box / send button.
        if (askOpts.model || askOpts.thinking) {
          await closeModelMenu();
          await sleep(300);
        }
        var box = findPromptBox();
        if (!box.el) {
          return { ok: false, error: 'gemini prompt box not found — UI may have changed (tried: ' + SELECTORS.PROMPT_BOX.join(' | ') + ')' };
        }
        // Baseline of the response area BEFORE the prompt is filled:
        // waitForCompletion only accepts text that is new or changed
        // against this, so pre-existing page text (home screen, previous
        // turn) can never be reported as this turn's answer (task -006).
        var baseline = captureResponseBaseline();
        // Remember this ask for recoverLastAnswer: the baseline is the
        // proof of what is new, so a previous turn's answer can never
        // be returned as this turn's (v0.4.13).
        lastAsk = { prompt: String(prompt), baseline: baseline };
        fillPromptBox(box.el, String(prompt), win);
        // A menu left open (e.g. by model/thinking selection) can cover
        // the send button or swallow the click — close it and let the
        // DOM settle before looking for the button (v0.4.13).
        if (readModelMenuItems().length) {
          await closeModelMenu();
          await sleep(300);
        }
        // Verify the message actually left the box: a click can land on a
        // decoy button, or the page can ignore it. Sent = streaming
        // started, or the box cleared, or a NEW genuine model response
        // appeared since the prompt was filled. STRONG evidence only
        // (v0.3.3): the third branch is NOT the old "any text changed"
        // heuristic — getLiveResponses() only counts text that is new or
        // changed against the pre-fill baseline, inside a real response
        // container, and never home-screen text. That keeps the -006 false
        // positive out (a re-rendered home screen is baseline text or
        // hero text, never live) while still covering short answers whose
        // streaming already finished inside sendCheckMs (stop button gone,
        // box not yet cleared in some layouts).
        var confirmSent = async function () {
          await sleep(sendCheckMs);
          if (isStreaming()) return true;
          if (!textOf(box.el)) return true;
          if (getLiveResponses(baseline).length) return true;
          return false;
        };
        // Send attempts, in order, each verified with confirmSent
        // (v0.4.13, teacher-testpc-001): a single click + Enter is NOT
        // enough — on the real page both missed and the prompt sat in
        // the box, yet the bridge reported the failure while the answer
        // was already in the tab. So: focus the box first, then try
        // plain click, Enter, a CDP trusted click on the send button,
        // and a full pointer sequence — and only then, before failing,
        // poll recoverLastAnswer briefly, in case the send actually
        // worked while confirmSent misjudged a slow page.
        var send = findSendButton(box.el);
        var recoveredOut = null;
        if (!send.el) {
          // No button matched at all. The visible blue arrow may be a
          // div/custom element or live in a shadow root (task -005: the
          // 26-button dump had no send control). Try Enter on the prompt
          // box before giving up — a successful Enter send is
          // indistinguishable from a button click once the answer streams.
          dispatchEnter(box.el, win);
          if (!(await confirmSent())) {
            var rec = await pollRecover(prompt, baseline, 1000);
            if (rec.ok) {
              recoveredOut = { ok: true, answer: rec.answer, model: selectedModel || DEFAULTS.model, elapsedMs: Date.now() - startedAt, recovered: true };
            } else {
              var dump = nearbyButtonsDump(box.el);
              var tried = 'icon [data-mat-icon-name*="arrow_up"] -> closest button'
                + ' | ' + SELECTORS.SEND_BUTTON.join(' | ')
                + ' | ' + SELECTORS.SEND_BUTTON_BROAD.join(' | ')
                + ' | role=button + send-like text | button svg arrow icon';
              var err = 'gemini send button not found — Enter fallback also did not send the prompt (tried: ' + tried + ')';
              if (dump.total) {
                err += ' Buttons near the prompt box (' + dump.total + ' total, nearest first): ' + dump.lines.join(' | ');
              } else {
                err += ' No buttons found in the page at all.';
              }
              err += ' Send-arrow icon ancestors: ' + iconAncestorChain();
              err += ' Recovery checked the tab and found no new answer (' + rec.error + ').';
              return { ok: false, error: err };
            }
          }
        } else {
          if (send.el.disabled) {
            return { ok: false, error: 'gemini send button is disabled — the prompt may not have registered, or a previous answer is still running' };
          }
          // The input box must hold focus before sending: a click that
          // lands while the box is unfocused can be swallowed. Focus
          // itself is synchronous — no settle sleep: the send checks
          // below already wait sendCheckMs, and a sleep here would
          // delay the first click past the streaming start.
          try { if (typeof box.el.focus === 'function') box.el.focus(); } catch (e) { /* focus is best-effort */ }
          var sent = false;
          try { send.el.click(); } catch (e) {
            return { ok: false, error: 'gemini send button click failed: ' + (e && e.message ? e.message : String(e)) };
          }
          sent = await confirmSent();
          if (!sent) {
            dispatchEnter(box.el, win);
            sent = await confirmSent();
          }
          if (!sent && requestTrustedSendClick) {
            // CDP trusted click (Input.dispatchMouseEvent, isTrusted):
            // the same real-click path that fixed the thinking-level
            // items (v0.4.11) — synthetic events are ignored by this
            // page, a trusted click is not.
            try {
              var tc = await requestTrustedSendClick();
              if (tc && tc.ok) sent = await confirmSent();
            } catch (e) { /* trusted click unavailable — fall through */ }
          }
          if (!sent) {
            // Full pointer sequence (pointerdown ... click): the page
            // honours a user-like sequence where a bare click is ignored
            // (same lesson as the thinking-level items, verify15).
            clickElement(send.el);
            sent = await confirmSent();
          }
          if (!sent) {
            var rec2 = await pollRecover(prompt, baseline, 1000);
            if (rec2.ok) {
              recoveredOut = { ok: true, answer: rec2.answer, model: selectedModel || DEFAULTS.model, elapsedMs: Date.now() - startedAt, recovered: true };
            } else {
              return { ok: false, error: 'gemini send did not register — the prompt is still in the input box after click + Enter + trusted click + pointer sequence (send button matched: ' + (send.selector || 'unknown') + '). The UI may have changed. Recovery checked the tab and found no new answer (' + rec2.error + ').' };
            }
          }
        }
        if (recoveredOut) {
          if (appliedThinking) recoveredOut.appliedThinking = appliedThinking;
          if (thinkingWarning) recoveredOut.thinkingWarning = thinkingWarning;
          return recoveredOut;
        }
        var done = await waitForCompletion(startedAt, deadline, baseline);
        if (!done.ok) return done;
        if (!done.answer) {
          return { ok: false, error: 'gemini answer finished but no response text could be extracted — UI may have changed', polls: done.polls, elapsedMs: done.elapsedMs };
        }
        var out = { ok: true, answer: done.answer, model: selectedModel || DEFAULTS.model, elapsedMs: done.elapsedMs, polls: done.polls };
        if (appliedThinking) out.appliedThinking = appliedThinking;
        if (thinkingWarning) out.thinkingWarning = thinkingWarning;
        return out;
      } catch (e) {
        return { ok: false, error: 'gemini adapter error: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    // Every ask result — success, failure, timeout — carries the adapter
    // version. The runner logs it next to the bridge version and flags a
    // mismatch, so the next stale-tab failure needs no guessing.
    async function ask(prompt, askOpts) {
      var res = await askImpl(prompt, askOpts);
      if (res && typeof res === 'object') res.adapter_version = ADAPTER_VERSION;
      return res;
    }

    return {
      ADAPTER_VERSION: ADAPTER_VERSION,
      SELECTORS: SELECTORS,
      KNOWN_MODELS: KNOWN_MODELS,
      MODEL_LABELS: MODEL_LABELS,
      RECOMMENDED_MODEL: RECOMMENDED_MODEL,
      findPromptBox: findPromptBox,
      findSendButton: findSendButton,
      isStreaming: isStreaming,
      getAllResponses: getAllResponses,
      getLatestResponseText: getLatestResponseText,
      getCurrentModelText: getCurrentModelText,
      listModels: listModels,
      selectModel: selectModel,
      selectThinkingLevel: selectThinkingLevel,
      measureThinkingLevelItem: measureThinkingLevelItem,
      measureSendButton: measureSendButton,
      recoverLastAnswer: recoverLastAnswer,
      waitForCompletion: waitForCompletion,
      ask: ask,
    };
  }

  return { createAdapter: createAdapter, ADAPTER_VERSION: ADAPTER_VERSION, SELECTORS: SELECTORS, DEFAULTS: DEFAULTS, RECOMMENDED_MODEL: RECOMMENDED_MODEL, dispatchEnter: dispatchEnter };
});
