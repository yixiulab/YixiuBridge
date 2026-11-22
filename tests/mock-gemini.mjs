// YixiuBridge — mock Gemini page (fake DOM) for adapter + protocol tests.
// Mirrors the DOM shape the adapter expects: a contenteditable prompt box,
// a Send button, and a streaming model response that finishes (stop button
// disappears). Streaming is simulated with real timers so the adapter's
// polling/completion logic is exercised for real.
//
// The model picker mirrors the real Gemini web menu (Nov 2026, Chinese UI,
// from the user's screenshot):
//   自动 / 根据需求调整回答
//   日常帮助 / 4 Hydrogen
//   更深入的分析 / 4 Neon        (selected, checkmark)
//   代码和复杂工作 / 4 Carbon     (locked — aria-disabled + lock icon)
// plus a 思考等级 submenu (高 / 中 / 低). The picker button shows the
// current model + thinking level, e.g. "Neon 高".
//
// Usage:
//   const page = createMockGeminiPage({ chunks, chunkMs });
//   const adapter = createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40 });
//   await adapter.ask('hello');
import { FakeDocument, FakeElement, FakeWindow } from './fake-dom.mjs';

const MOCK_MODELS = [
  { label: '自动', description: '根据需求调整回答', codename: null, selected: false, locked: false },
  { label: '日常帮助', description: '', codename: 'Hydrogen', selected: false, locked: false },
  { label: '更深入的分析', description: '', codename: 'Neon', selected: true, locked: false },
  { label: '代码和复杂工作', description: '', codename: 'Carbon', selected: false, locked: true },
];
const MOCK_LEVELS = ['低', '中', '高'];
// Real submenu descriptions (browser inspection, 2026-11-22): the level
// name is followed by a description, and "高" is a substring of "高效"
// in 低's description — so a substring match for "高" hits 低 first.
// The mock MUST carry the descriptions, or the adapter's matching bug
// (v0.4.12) is invisible in tests.
const MOCK_LEVEL_DESCS = { '低': '快速、高效', '中': '深度适中', '高': '超级详尽' };

export function createMockGeminiPage({ chunks = ['4', ' is ', 'the answer.'], chunkMs = 10, boxKind = 'contenteditable', sendKind = 'mat-icon', keepMenuOpenOnSelect = false, sendOnEnter = false, realStructure = false, priorTurn = null, levelSticks = true, levelClicksToStick = 1, levelRadioInside = false, levelClickDead = false, initialLevel = '高', menuOpensOnClick = 1, sendNeedsPointerSequence = false, sendStartsOnTrustedClick = false, sendStartsLateMs = 0, stopBtnStuck = false } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();

  const app = new FakeElement('div', { class: 'app' });

  // Real page structure (v0.3.6, task -009): the sidebar conversation list
  // uses a[data-test-id="conversation"] — the selector the 0.3.3–0.3.5
  // adapter WRONGLY treated as the chat container. The sidebar links must
  // come first in document order so a scope bug shows up in tests.
  let sidebar = null;
  if (realStructure) {
    sidebar = new FakeElement('div', { class: 'sidebar' });
    for (const title of ['黑洞的定义', '光合作用定义']) {
      const link = new FakeElement('a', { 'data-test-id': 'conversation' });
      const t = new FakeElement('span', { class: 'conversation-title' });
      t.textContent = title;
      link.appendChild(t);
      sidebar.appendChild(link);
    }
    doc.body.appendChild(sidebar);
  }
  doc.body.appendChild(app);

  // Model picker button (top of the page) + menu (present only while open).
  const models = MOCK_MODELS.map((m) => ({ ...m }));
  let currentLevel = initialLevel;
  const levelClickCounts = {};
  let menu = null;
  let submenu = null;

  const currentModel = () => models.find((m) => m.selected) || models[0];
  const pickerText = () => (currentModel().codename || currentModel().label) + ' ' + currentLevel;

  const picker = new FakeElement('button', { 'data-test-id': 'model-switcher', 'aria-label': '选择模型' });
  picker.textContent = pickerText();
  app.appendChild(picker);

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    if (submenu) { submenu.remove(); submenu = null; }
  }

  function openSubmenu() {
    if (submenu) return;
    submenu = new FakeElement('div', { role: 'menu' });
    // Arrow-key navigation (v0.4.10): the submenu's keyboard focus
    // starts on the checked level; ArrowDown/ArrowUp move it, Enter
    // applies the focused level. Shared across the items because the
    // mock does not bubble keydown events to the menu container.
    let focusedIdx = Math.max(0, MOCK_LEVELS.indexOf(currentLevel));
    const applyLevelFor = (lv) => {
      levelClickCounts[lv] = (levelClickCounts[lv] || 0) + 1;
      if (levelSticks && levelClickCounts[lv] >= levelClicksToStick) {
        currentLevel = lv;
        picker.textContent = pickerText();
      }
      closeMenu();
    };
    const onLevelKey = (ev) => {
      if (ev.key === 'ArrowDown') { focusedIdx = Math.min(focusedIdx + 1, MOCK_LEVELS.length - 1); }
      else if (ev.key === 'ArrowUp') { focusedIdx = Math.max(focusedIdx - 1, 0); }
      else if (ev.key === 'Enter' || ev.key === ' ') { applyLevelFor(MOCK_LEVELS[focusedIdx]); }
    };
    for (const lv of MOCK_LEVELS) {
      // Real page: level items are menuitemradio with text "<level>
      // <description>" (e.g. "高 超级详尽"), aria-checked for the
      // selected one. Unselected items have no children at all.
      const item = new FakeElement('div', { role: 'menuitemradio', 'aria-checked': lv === currentLevel ? 'true' : 'false' });
      // levelRadioInside: the selectable radio lives INSIDE the menu item
      // and only a click on the radio applies the level — a click on the
      // container does nothing (v0.4.8: verify16 proved 3 full pointer
      // sequences on the container leave the level on 低).
      // levelClickDead: mouse clicks on the level items do nothing
      // (simulates the real page, verify15/16) — only keyboard Enter /
      // Space activates the level (v0.4.9).
      const applyLevel = () => applyLevelFor(lv);
      if (levelRadioInside) {
        const radio = new FakeElement('span', { role: 'radio' });
        radio.textContent = lv + ' ' + MOCK_LEVEL_DESCS[lv];
        radio.addEventListener('click', () => { if (!levelClickDead) applyLevel(); });
        radio.addEventListener('keydown', onLevelKey);
        item.appendChild(radio);
      } else {
        item.textContent = lv + ' ' + MOCK_LEVEL_DESCS[lv];
        item.addEventListener('click', () => { if (!levelClickDead) applyLevel(); });
      }
      // Arrow-key navigation (v0.4.10) is dispatched on the level item
      // itself, so the item always carries the key handler (the radio
      // carries it too for the focus+Enter path).
      item.addEventListener('keydown', onLevelKey);
      // __trustedClick (v0.4.11): simulates a real CDP trusted click
      // (Input.dispatchMouseEvent, isTrusted true). It applies the level
      // directly, bypassing the levelSticks / levelClickDead gates that
      // make synthetic clicks and keys fail — exactly the real page's
      // behaviour (verify15-19): synthetic events never move the level,
      // only a real trusted click does.
      item.__trustedClick = () => {
        currentLevel = lv;
        picker.textContent = pickerText();
        closeMenu();
      };
      submenu.appendChild(item);
    }
    doc.body.appendChild(submenu);
  }

  function buildMenu() {
    menu = new FakeElement('div', { role: 'menu' });
    for (const m of models) {
      const item = new FakeElement('div', { role: 'menuitemradio', 'aria-checked': m.selected ? 'true' : 'false' });
      if (m.locked) item.setAttribute('aria-disabled', 'true');
      const title = new FakeElement('span');
      title.textContent = m.label + ' ';
      item.appendChild(title);
      if (m.description) {
        const d = new FakeElement('span');
        d.textContent = m.description + ' ';
        item.appendChild(d);
      }
      if (m.codename) {
        const n = new FakeElement('span');
        n.textContent = '4 ' + m.codename;
        item.appendChild(n);
      }
      if (m.selected) {
        const check = new FakeElement('span', { class: 'check-mark' });
        check.textContent = '✓';
        item.appendChild(check);
      }
      if (m.locked) {
        const lock = new FakeElement('span', { class: 'lock-icon', 'aria-label': '需要订阅' });
        lock.textContent = '🔒';
        item.appendChild(lock);
      }
      item.addEventListener('click', () => {
        if (m.locked) return; // locked items do nothing
        for (const mm of models) mm.selected = (mm === m);
        picker.textContent = pickerText();
        if (!keepMenuOpenOnSelect) closeMenu();
      });
      menu.appendChild(item);
    }
    // Thinking-level submenu trigger.
    const trigger = new FakeElement('div', { role: 'menuitem' });
    const tt = new FakeElement('span');
    tt.textContent = '思考等级 ';
    trigger.appendChild(tt);
    trigger.addEventListener('click', () => { openSubmenu(); });
    menu.appendChild(trigger);
    return menu;
  }

  // menuOpensOnClick: 2 simulates the real page (2026-11-22 verify3/verify4)
  // where the first picker click is swallowed (cold tab) and the menu only
  // opens on the second click (v0.4.2: openModelMenu polls and retries).
  let pickerClicks = 0;
  picker.addEventListener('click', () => {
    pickerClicks++;
    if (pickerClicks < menuOpensOnClick) return;
    if (menu) closeMenu();
    else doc.body.appendChild(buildMenu());
  });
  doc.body.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });

  // Prompt box.
  let box;
  if (boxKind === 'contenteditable') {
    box = new FakeElement('div', { contenteditable: 'true', 'aria-label': 'Ask Gemini' });
  } else {
    box = new FakeElement('textarea', { 'aria-label': 'Ask Gemini', placeholder: 'Ask Gemini' });
  }
  app.appendChild(box);

  // Send button: clicking starts the simulated streaming response.
  // Default shape mirrors the REAL Gemini page (Nov 2026, user's inspect):
  // an Angular Material button with NO aria-label, carrying a <mat-icon
  // data-mat-icon-name="arrow_upward">. Other sendKind values build the
  // classic/fallback shapes the adapter must also find:
  //   'aria-label' classic button, 'fonticon' icon with fonticon only,
  //   'title' button labelled by title, 'testid' data-test-id button,
  //   'svg' inline SVG arrow icon, 'role' div acting as a button,
  //   'icon-only' bare icon inside a plain div — the -005 shape (the blue
  //   arrow is visible but is NOT a <button>, so no layer can find it).
  let send;
  if (sendKind === 'aria-label') {
    send = new FakeElement('button', { 'aria-label': 'Send message' });
  } else if (sendKind === 'fonticon') {
    send = new FakeElement('button', { class: 'mat-mdc-icon-button' });
    const icon = new FakeElement('mat-icon', { fonticon: 'arrow_upward', 'aria-hidden': 'true' });
    icon.textContent = 'arrow_upward';
    send.appendChild(icon);
  } else if (sendKind === 'title') {
    send = new FakeElement('button', { title: '发送消息' });
  } else if (sendKind === 'testid') {
    send = new FakeElement('button', { 'data-test-id': 'send-btn' });
  } else if (sendKind === 'svg') {
    send = new FakeElement('button', { class: 'icon-btn' });
    const svg = new FakeElement('svg', { class: 'arrow-up-icon', 'aria-label': 'arrow upward' });
    send.appendChild(svg);
  } else if (sendKind === 'role') {
    send = new FakeElement('div', { role: 'button', 'aria-label': '发送' });
  } else if (sendKind === 'icon-only') {
    send = new FakeElement('div', { class: 'send-wrap' });
    const icon = new FakeElement('mat-icon', { 'data-mat-icon-name': 'arrow_upward', fonticon: 'arrow_upward', 'aria-hidden': 'true' });
    icon.textContent = 'arrow_upward';
    send.appendChild(icon);
  } else { // 'mat-icon' (default, real page shape)
    send = new FakeElement('button', { class: 'mat-mdc-icon-button' });
    const icon = new FakeElement('mat-icon', { 'data-mat-icon-name': 'arrow_upward', fonticon: 'arrow_upward', 'aria-hidden': 'true' });
    icon.textContent = 'arrow_upward';
    send.appendChild(icon);
  }
  app.appendChild(send);

  // Conversation container + response element (created on send).
  // Default shape: the mock's own div[data-test-id="conversation"].
  // realStructure: the REAL Gemini page (Nov 2026, confirmed by
  // independent DOM analyses Apr–Jul 2026 and by the -009 failure):
  //   infinite-scroller.chat-history
  //     div.conversation-container            // one per turn
  //       user-query > .query-text > p.query-text-line
  //       model-response
  //         structured-content-container.model-response-text
  //           > .markdown.markdown-main-panel
  // plus one pre-existing turn, so the baseline is non-empty (as on the
  // real -009 tab, which already held earlier pomodoro answers).
  const convo = realStructure
    ? new FakeElement('infinite-scroller', { class: 'chat-history' })
    : new FakeElement('div', { 'data-test-id': 'conversation' });
  app.appendChild(convo);

  function buildTurn(question, answer) {
    const turn = new FakeElement('div', { class: 'conversation-container' });
    const uq = new FakeElement('user-query');
    const qt = new FakeElement('div', { class: 'query-text' });
    const line = new FakeElement('p', { class: 'query-text-line' });
    line.textContent = question;
    qt.appendChild(line);
    uq.appendChild(qt);
    turn.appendChild(uq);
    const mr = new FakeElement('model-response');
    const scc = new FakeElement('structured-content-container', { class: 'model-response-text' });
    const md = new FakeElement('div', { class: 'markdown markdown-main-panel' });
    md.textContent = answer;
    scc.appendChild(md);
    mr.appendChild(scc);
    turn.appendChild(mr);
    return { turn, markdown: md };
  }
  // A home page has no turns at all; a conversation page (the default
  // here) has one pre-existing turn, so the baseline is non-empty (as on
  // the real -009 tab, which already held earlier pomodoro answers).
  if (realStructure && priorTurn !== false) {
    const old = buildTurn('用一句话解释什么是黑洞，回答里必须包含‘意大利面’这个词', '黑洞是宇宙中引力极强的时空区域，强到连光都无法逃脱，任何靠近它的物体都会被其巨大的潮汐力像拉扯意大利面一样拉长并吞噬。');
    convo.appendChild(old.turn);
  }

  let stopBtn = null;
  let responseEl = null;

  // Shared by the send-button click and (when sendOnEnter is set) an Enter
  // keydown on the prompt box — the real Gemini page submits on Enter too,
  // which is what the adapter falls back to when no button is found.
  function startStreaming() {
    if (stopBtn) return; // already streaming
    if (realStructure) {
      const fresh = buildTurn(box.textContent || box.value || '', '');
      convo.appendChild(fresh.turn);
      responseEl = fresh.markdown;
    } else {
      // Mirror the real page: the sent prompt becomes a user-query turn
      // before the model response, so recoverLastAnswer can prove the
      // prompt left the box by matching the latest user query (v0.4.13).
      const uq = new FakeElement('user-query');
      const line = new FakeElement('p', { class: 'query-text-line' });
      line.textContent = box.textContent || box.value || '';
      uq.appendChild(line);
      convo.appendChild(uq);
      responseEl = new FakeElement('div', { class: 'model-response-text' });
      convo.appendChild(responseEl);
    }
    stopBtn = new FakeElement('button', { 'aria-label': 'Stop generating' });
    app.appendChild(stopBtn);
    let i = 0;
    const step = () => {
      if (i < chunks.length) {
        responseEl.textContent += chunks[i];
        i++;
        setTimeout(step, chunkMs);
      } else if (stopBtn && !stopBtnStuck) {
        // stopBtnStuck (v0.4.16, teacher-005): the text finishes but the
        // stop button / thinking indicator stays up forever — the
        // streaming flag is stuck, and only the text-stability rule may
        // complete the answer. Without it the stop button is removed
        // when the last chunk lands (the normal page behaviour).
        stopBtn.remove();
        stopBtn = null;
      }
    };
    setTimeout(step, chunkMs);
  }

  // Send failure modes (v0.4.13, teacher-001):
  // - sendNeedsPointerSequence: a bare 'click' (el.click()) is ignored;
  //   only a full pointer sequence (pointerdown ... click) starts the
  //   answer — the real page's behaviour that made click+Enter miss.
  // - sendStartsOnTrustedClick: only a CDP trusted click
  //   (send.__trustedClick) starts streaming.
  // - sendStartsLateMs: the click schedules streaming after a delay, so
  //   the send checks misjudge and recovery must find the late answer.
  let pointerDownSeen = false;
  send.addEventListener('pointerdown', () => { pointerDownSeen = true; });
  send.addEventListener('click', () => {
    if (sendStartsOnTrustedClick) return;
    if (sendNeedsPointerSequence && !pointerDownSeen) return;
    pointerDownSeen = false;
    if (sendStartsLateMs) {
      if (stopBtn) return;
      setTimeout(() => { startStreaming(); }, sendStartsLateMs);
      return;
    }
    startStreaming();
  });
  if (sendStartsOnTrustedClick) {
    send.__trustedClick = () => { startStreaming(); };
  }

  if (sendOnEnter) {
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') startStreaming();
    });
  }

  return {
    doc, win, box, send, convo, picker, sidebar,
    get menu() { return menu; },
    get responseEl() { return responseEl; },
    get stopBtn() { return stopBtn; },
  };
}

// The Gemini home screen, exactly as task -006 saw it (2026-11-21):
// hero greeting + suggestion chips, NO send button (the visible arrow is
// a plain div, not a <button>), NO model response yet. The hero text sits
// in a `.markdown` container — the shape the 0.3.2 adapter mistook for an
// answer. Built on createMockGeminiPage with sendKind 'icon-only'.
// Options (on top of createMockGeminiPage's):
//   homeHeroInsideConvo (default false): put the hero container inside the
//     conversation element (worst case: scoping alone cannot exclude it,
//     the hero filter must).
//   sendOnEnter: Enter in the prompt box submits (starts streaming).
//   enterClearsBox: Enter clears the box WITHOUT submitting (the
//     box-cleared-without-submit edge: confirmSent passes, but no model
//     text ever appears).
//   enterRerendersHome: Enter replaces the hero container with a fresh
//     element carrying slightly DIFFERENT home-screen text (the -006
//     re-render trap: the response text "changed", which the old
//     "text changed" heuristic read as proof the message was sent).
// Returns the createMockGeminiPage shape, plus `hero`.
export const HOME_SCREEN_TEXT = '需要我为你做些什么？\n考考我莎士比亚的知识\n规划一条附近 3 英里的平坦慢跑路线\n总结会议记录';
const HOME_SCREEN_TEXT_RERENDERED = '需要我为你做些什么？\n考考我莎士比亚的知识\n规划一条附近 3 英里的平坦慢跑路线\n总结会议记录\n再想一个点子';
export function createMockGeminiHomePage(opts = {}) {
  const page = createMockGeminiPage({ sendKind: 'icon-only', priorTurn: false, ...opts });
  const hero = new FakeElement('div', { class: 'home-greeting markdown' });
  hero.textContent = HOME_SCREEN_TEXT;
  const parent = opts.homeHeroInsideConvo ? page.convo : page.doc.body;
  parent.appendChild(hero);
  page.hero = hero;
  if (opts.enterClearsBox) {
    page.box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') page.box.textContent = '';
    });
  }
  if (opts.enterRerendersHome) {
    page.box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const fresh = new FakeElement('div', { class: 'home-greeting markdown' });
      fresh.textContent = HOME_SCREEN_TEXT_RERENDERED;
      const p = page.hero.parent || page.doc.body;
      page.hero.remove();
      p.appendChild(fresh);
      page.hero = fresh;
    });
  }
  return page;
}
