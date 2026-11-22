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

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

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
  // Let the click land and streaming start. 20ms, not 30ms: the mock
  // removes the stop button at ~30ms (2 chunks x 10ms + the final step),
  // so checking at 30ms races the removal and flakes. At 20ms streaming
  // is definitely still up.
  await new Promise((r) => setTimeout(r, 20));
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

test('click that does not submit falls back to Enter and still succeeds', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  // The send button's click does nothing on this page variant...
  const origClicks = (page.send._listeners.click || []).slice();
  page.send._listeners.click = [];
  // ...but Enter in the prompt box submits.
  page.box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') origClicks.forEach((fn) => fn.call(page.send));
  });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
});

test('click and Enter both failing returns a fast, clear error instead of timing out', async () => {
  const page = createMockGeminiPage();
  // Neither the button nor Enter submits anything on this page variant.
  page.send._listeners.click = [];
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 60000 });
  const started = Date.now();
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not register/);
  assert.match(res.error, /still in the input box/);
  assert.ok(Date.now() - started < 5000, 'should fail fast, not wait out the 60s timeout');
});

// ---------- stuck streaming flag (v0.4.16, teacher-005) ----------
// teacher-005 (2026-11-22): the answer text was complete and stable for
// ~15 minutes while the stop button / thinking dots stayed up. The old
// wait loop reset the stability clock on every poll while streaming, so
// it burned the whole 240s timeout and the answer was only retrieved by
// the 5-minute recovery poll. Now text stable for stuckStreamingMs
// counts as done even with the flag still up.

test('ask returns the answer when the text is done but the stop button stays up (stuck flag)', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, stopBtnStuck: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, stuckStreamingMs: 100, timeoutMs: 5000 });
  const started = Date.now();
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.completedVia, 'stable-while-streaming');
  assert.equal(res.streamingFlagStuck, true);
  // A completed answer must come back promptly — not after the timeout.
  assert.ok(Date.now() - started < 2000, 'stuck-flag answer must return within ~2s, took ' + (Date.now() - started) + 'ms');
  assert.equal(adapter.isStreaming(), true, 'the flag is still up — the text, not the flag, completed this ask');
});

test('ask still reports the fast path when the flag clears normally', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, stuckStreamingMs: 100, timeoutMs: 5000 });
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.completedVia, 'stable');
  assert.equal(res.streamingFlagStuck, undefined);
});

test('timeout error names the streaming flag when the text is stable but the flag is stuck', async () => {
  const page = createMockGeminiPage({ chunks: ['partial…'], chunkMs: 10 });
  // The mock's own stop button goes away when the chunks finish; add a
  // second one that stays forever, so the flag is stuck while the text
  // is stable — but the stuck threshold (1000ms) is longer than the
  // 300ms timeout, so this ask must still time out, with a reason.
  const forever = new FakeElement('button', { 'aria-label': 'Stop generating' });
  page.doc.body.appendChild(forever);
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, stuckStreamingMs: 1000, sendCheckMs: 10, timeoutMs: 300 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not finish within timeout/);
  assert.match(res.error, /still streaming/);
  assert.match(res.error, /stuck-flag rule/);
  assert.equal(res.partial, 'partial…');
});

test('timeout error says the text is still changing when it never stabilises', async () => {
  // A chunk lands every 100ms, so the text is never stable for the
  // 1000ms stuck threshold (or the 40ms stable window — the flag is up
  // the whole time, so only the stuck rule applies). sendCheckMs is
  // FAST so the wait starts on time; without it the 1000ms default
  // send check would eat the whole 250ms timeout before the wait even
  // starts, and the error would describe a deadline already passed
  // instead of a text still changing.
  const page = createMockGeminiPage({ chunks: ['a', 'b', 'c', 'd', 'e'], chunkMs: 100 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, stuckStreamingMs: 1000, sendCheckMs: 10, timeoutMs: 250 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not finish within timeout/);
  assert.match(res.error, /text still changing/);
  assert.equal(res.partial, 'ab');
});
