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
const MOCK_LEVELS = ['高', '中', '低'];

export function createMockGeminiPage({ chunks = ['4', ' is ', 'the answer.'], chunkMs = 10, boxKind = 'contenteditable', sendKind = 'mat-icon', keepMenuOpenOnSelect = false } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();

  const app = new FakeElement('div', { class: 'app' });
  doc.body.appendChild(app);

  // Model picker button (top of the page) + menu (present only while open).
  const models = MOCK_MODELS.map((m) => ({ ...m }));
  let currentLevel = '高';
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
    for (const lv of MOCK_LEVELS) {
      const item = new FakeElement('div', { role: 'menuitem', 'aria-checked': lv === currentLevel ? 'true' : 'false' });
      item.textContent = lv;
      item.addEventListener('click', () => {
        currentLevel = lv;
        picker.textContent = pickerText();
        closeMenu();
      });
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

  picker.addEventListener('click', () => {
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
  //   'svg' inline SVG arrow icon, 'role' div acting as a button.
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
  } else { // 'mat-icon' (default, real page shape)
    send = new FakeElement('button', { class: 'mat-mdc-icon-button' });
    const icon = new FakeElement('mat-icon', { 'data-mat-icon-name': 'arrow_upward', fonticon: 'arrow_upward', 'aria-hidden': 'true' });
    icon.textContent = 'arrow_upward';
    send.appendChild(icon);
  }
  app.appendChild(send);

  // Conversation container + response element (created on send).
  const convo = new FakeElement('div', { 'data-test-id': 'conversation' });
  app.appendChild(convo);

  let stopBtn = null;
  let responseEl = null;

  send.addEventListener('click', () => {
    responseEl = new FakeElement('div', { class: 'model-response-text' });
    convo.appendChild(responseEl);
    stopBtn = new FakeElement('button', { 'aria-label': 'Stop generating' });
    app.appendChild(stopBtn);
    let i = 0;
    const step = () => {
      if (i < chunks.length) {
        responseEl.textContent += chunks[i];
        i++;
        setTimeout(step, chunkMs);
      } else if (stopBtn) {
        stopBtn.remove();
        stopBtn = null;
      }
    };
    setTimeout(step, chunkMs);
  });

  return {
    doc, win, box, send, convo, picker,
    get menu() { return menu; },
    get responseEl() { return responseEl; },
    get stopBtn() { return stopBtn; },
  };
}
