// YixiuBridge — Gemini adapter tests (Node native runner, fake DOM).
// Proves ask -> wait -> extract works end-to-end at the adapter level
// against a mock Gemini page. No real Chrome, no network, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMockGeminiPage } from './mock-gemini.mjs';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40 };

test('ask fills the prompt box, sends, waits for streaming to end, returns the full answer', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.model, 'gemini-web');
  assert.ok(res.elapsedMs >= 0);
  assert.equal(page.box.textContent, 'What is 2+2?');
});

test('ask works with a plain textarea prompt box (fallback selector)', async () => {
  const page = createMockGeminiPage({ boxKind: 'textarea' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(page.box.value, 'hello');
});

test('missing prompt box returns a clear error naming the element', async () => {
  const doc = new FakeDocument();
  const adapter = Adapter.createAdapter(doc, { win: {}, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /prompt box not found/);
  assert.match(res.error, /UI may have changed/);
});

test('missing send button returns a clear error', async () => {
  const page = createMockGeminiPage();
  page.send.remove();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
});

test('disabled send button returns a clear error', async () => {
  const page = createMockGeminiPage();
  page.send.disabled = true;
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /disabled/);
});

test('empty prompt is rejected without touching the page', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST });
  const res = await adapter.ask('   ');
  assert.equal(res.ok, false);
  assert.match(res.error, /prompt is empty/);
});

test('streaming that never finishes times out with the partial answer', async () => {
  const page = createMockGeminiPage({ chunks: ['partial…'], chunkMs: 10 });
  // Never remove the stop button: patch the send handler by adding a second
  // stop button that stays forever.
  const forever = new FakeElement('button', { 'aria-label': 'Stop generating' });
  page.doc.body.appendChild(forever);
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, timeoutMs: 300 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not finish within timeout/);
  assert.equal(res.partial, 'partial…');
});

test('isStreaming reflects the stop button, getLatestResponseText returns the newest block', async () => {
  const page = createMockGeminiPage({ chunks: ['one', ' two'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  assert.equal(adapter.isStreaming(), false);
  const p = adapter.ask('hello');
  // Let the click land and streaming start.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(adapter.isStreaming(), true);
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(adapter.isStreaming(), false);
  assert.equal(adapter.getLatestResponseText(), 'one two');
});

test('filling a contenteditable box dispatches an input event', async () => {
  const page = createMockGeminiPage();
  let inputEvents = 0;
  page.box.addEventListener('input', () => { inputEvents++; });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  await adapter.ask('event test');
  assert.equal(inputEvents, 1);
});
