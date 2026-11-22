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

test('streaming that never finishes ends at the hard cap with the partial answer (v0.4.17)', async () => {
  // Was: 'streaming that never finishes times out with the partial
  // answer'. The user ordered (2026-11-22) that the wait must NOT cut
  // off at a fixed time while Gemini is still working — a stop button
  // that never goes away used to end the ask at the 300ms deadline,
  // but the text is complete and stable, so the wait now extends and
  // the stuck-flag rule would complete it at stuckStreamingMs. The
  // only thing that still ends the wait is the hard cap: with
  // hardCapMs 400 (shorter than the 10s stuck threshold) the ask ends
  // there, and the error still carries the partial answer.
  const page = createMockGeminiPage({ chunks: ['partial…'], chunkMs: 10 });
  // Never remove the stop button: patch the send handler by adding a second
  // stop button that stays forever.
  const forever = new FakeElement('button', { 'aria-label': 'Stop generating' });
  page.doc.body.appendChild(forever);
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, timeoutMs: 300, activeGraceMs: 300, hardCapMs: 400 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not finish within timeout/);
  assert.match(res.error, /hard cap reached/);
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

test('ask extends past the fixed deadline while the stop button stays up, and returns the answer once the text holds still (v0.4.17)', async () => {
  // Was: 'timeout error names the streaming flag when the text is stable
  // but the flag is stuck'. The user ordered (2026-11-22) that the wait
  // must NOT cut off at a fixed time while Gemini is still working — so
  // a stuck stop button no longer ends the ask at the deadline. The
  // wait now extends while the flag is up, and the text-stability rule
  // (stuckStreamingMs) completes it.
  const page = createMockGeminiPage({ chunks: ['partial…'], chunkMs: 10 });
  const forever = new FakeElement('button', { 'aria-label': 'Stop generating' });
  page.doc.body.appendChild(forever);
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, stuckStreamingMs: 1000, sendCheckMs: 10, timeoutMs: 300 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true, 'expected the extended wait to return the answer, got: ' + JSON.stringify(res));
  assert.equal(res.answer, 'partial…');
  assert.equal(res.completedVia, 'stable-while-streaming');
});

test('ask extends past the fixed deadline while the text is still changing, and returns the full answer (v0.4.17)', async () => {
  // Was: 'timeout error says the text is still changing when it never
  // stabilises'. The user ordered (2026-11-22) that the wait must NOT
  // cut off at a fixed time while Gemini is still generating — a chunk
  // landing every 100ms is live generation, not a timeout. The wait
  // now extends while the text keeps changing and returns the answer
  // once it holds still. (The hard-cap error case moved to the test
  // below.)
  const page = createMockGeminiPage({ chunks: ['a', 'b', 'c', 'd', 'e'], chunkMs: 100 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, stuckStreamingMs: 1000, sendCheckMs: 10, timeoutMs: 250 });
  const started = Date.now();
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true, 'expected the extended wait to return the answer, got: ' + JSON.stringify(res));
  assert.equal(res.answer, 'abcde');
  assert.ok(res.elapsedMs > 250, 'the answer must arrive after the 250ms deadline proves the wait extended, elapsed ' + res.elapsedMs + 'ms');
  assert.ok(Date.now() - started < 5000);
});

test('the hard cap still ends the wait, and the error names the cap (v0.4.17)', async () => {
  // Same still-changing page as above, but the hard cap (400ms) fires
  // while the text is still changing — the flexible wait is not
  // unbounded, and the error must say which cap ended it.
  const page = createMockGeminiPage({ chunks: ['a', 'b', 'c', 'd', 'e'], chunkMs: 100 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, stuckStreamingMs: 1000, sendCheckMs: 10, timeoutMs: 250, activeGraceMs: 300, hardCapMs: 400 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /did not finish within timeout/);
  assert.match(res.error, /hard cap reached/);
});

test('ask extends while Gemini is still thinking with no text yet, and returns the answer (v0.4.17)', async () => {
  // The query is in the conversation and the thinking dots are showing,
  // but no text has streamed yet — the fixed deadline (300ms) must not
  // end the wait. The response only starts at 1500ms.
  const page = createMockGeminiPage({ chunks: ['OK'], chunkMs: 10, responseDelayMs: 1500 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, sendCheckMs: 10, timeoutMs: 300, activeGraceMs: 300, hardCapMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true, 'expected the thinking-phase wait to return the answer, got: ' + JSON.stringify(res));
  assert.equal(res.answer, 'OK');
  assert.ok(res.elapsedMs > 300, 'the answer must arrive after the 300ms deadline proves the wait extended, elapsed ' + res.elapsedMs + 'ms');
});

test('ask still fails at the deadline when nothing ever happens (v0.4.17)', async () => {
  // No chunks, no streaming, no thinking dots: no activity at all, so
  // the flexible wait has nothing to extend on and the ask fails at
  // the fixed deadline exactly as before.
  const page = createMockGeminiPage({ chunks: [], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, sendCheckMs: 10, timeoutMs: 300, activeGraceMs: 300, hardCapMs: 5000 });
  const started = Date.now();
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /no response appeared/);
  assert.ok(Date.now() - started < 2000, 'an idle page must fail near the deadline, not after the grace/hard cap, took ' + (Date.now() - started) + 'ms');
});

test('send is confirmed when the prompt appears as a new user-query turn even before streaming starts (v0.4.17)', async () => {
  // verify33 (2026-11-22): no send button on the page, Enter dispatched,
  // the prompt WAS in the conversation — but the adapter judged the
  // send a failure because the box had not cleared and streaming had
  // not started yet. The prompt appearing as a NEW user-query turn is
  // the send; the ask must proceed to wait for the answer instead of
  // failing. The response only starts at 1500ms (thinking phase), so
  // this also exercises the flexible wait.
  const page = createMockGeminiPage({ sendKind: 'icon-only', sendOnEnter: true, responseDelayMs: 1500, chunks: ['OK'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 10000, activeGraceMs: 300, hardCapMs: 5000 });
  const res = await adapter.ask('请只回复：OK');
  assert.equal(res.ok, true, 'expected the query-turn send check to proceed to the answer, got: ' + JSON.stringify(res));
  assert.equal(res.answer, 'OK');
  assert.equal(res.recovered, undefined, 'the answer must come from the normal path, not recovery');
});
