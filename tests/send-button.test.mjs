// YixiuBridge — send-button discovery tests (Node native runner, fake DOM).
// Proves the v0.3 layered discovery against the mock Gemini page:
//   (1) the real page shape — an Angular Material button with NO aria-label,
//       carrying a <mat-icon data-mat-icon-name="arrow_upward">;
//   (2) the classic aria-label shape; (3) broad fallbacks (title,
//       data-test-id, role=button, SVG arrow icon); (4) nearest-to-the-box
//       wins when several candidates match; (5) the not-found error dumps
//       the buttons near the prompt box so the next failure diagnoses itself.
// No real Chrome, no network, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMockGeminiPage } from './mock-gemini.mjs';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

test('ask finds the real mat-icon send button (no aria-label) and succeeds', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const found = adapter.findSendButton(page.box);
  assert.ok(found.el, 'send button must be found');
  assert.equal(found.el, page.send);
  assert.match(found.selector, /arrow_upward/);
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
});

test('ask finds the send button when the icon only has fonticon (no data-mat-icon-name)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'fonticon' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.answer, 'ok');
});

test('classic aria-label send button still works (regression)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'aria-label' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.answer, 'ok');
});

test('button labelled by title ("发送消息") is found', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'title' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
});

test('data-test-id send button is found', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'testid' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
});

test('inline SVG arrow icon inside a button is found', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'svg' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
});

test('div with role=button and send text is found', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, sendKind: 'role' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
});

test('when several buttons match, the one nearest the prompt box wins (not a far-away decoy)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  // A decoy "Send feedback" button far from the prompt box (in a header).
  const header = new FakeElement('div', { class: 'header' });
  const decoy = new FakeElement('button', { 'aria-label': 'Send feedback' });
  let decoyClicked = false;
  decoy.addEventListener('click', () => { decoyClicked = true; });
  header.appendChild(decoy);
  page.doc.body.appendChild(header);
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const found = adapter.findSendButton(page.box);
  assert.equal(found.el, page.send, 'the real send button next to the box must win');
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(decoyClicked, false, 'the decoy must never be clicked');
});

test('not-found error dumps the buttons near the prompt box (max 10, nearest first)', async () => {
  const page = createMockGeminiPage();
  page.send.remove();
  // 12 more buttons with distinct labels, all siblings of the prompt box.
  for (let i = 0; i < 12; i++) {
    const b = new FakeElement('button', { 'aria-label': 'b' + i });
    page.doc.body.appendChild(b);
  }
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
  assert.match(res.error, /13 total/); // picker + 12 added buttons
  assert.match(res.error, /aria-label="b0"/);
  assert.match(res.error, /aria-label="b8"/);
  assert.doesNotMatch(res.error, /aria-label="b10"/, 'dump is capped at 10 entries');
  assert.doesNotMatch(res.error, /aria-label="b11"/);
});

test('not-found error on a page with no buttons at all says so', async () => {
  const doc = new FakeDocument();
  const box = new FakeElement('div', { contenteditable: 'true', 'aria-label': 'Ask Gemini' });
  doc.body.appendChild(box);
  const adapter = Adapter.createAdapter(doc, { win: {}, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
  assert.match(res.error, /No buttons found in the page at all/);
});

test('ask with a model closes a menu left open by the selection and still sends', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, keepMenuOpenOnSelect: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Hydrogen' });
  assert.equal(res.ok, true);
  assert.equal(res.answer, 'ok');
  assert.equal(page.picker.textContent, 'Hydrogen 高');
  assert.equal(page.doc.querySelector('[role="menu"]'), null, 'menu must be closed after the ask');
});
