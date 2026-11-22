// YixiuBridge — home-screen false-positive tests (v0.3.3, task -006).
// Ground truth 2026-11-21: the 0.3.2 adapter "answered" a task with the
// Gemini HOME SCREEN text ("需要我为你做些什么？ / 考考我莎士比亚的知识
// …") — the message was never sent. The Enter fallback's confirmSent()
// counted a changed response text as proof of sending, and the Enter
// keypress had re-rendered the home screen. These tests prove the three
// layers that now stop it: (1) confirmSent needs strong evidence only
// (streaming, or the box cleared); (2) getLatestResponseText never
// returns home-screen text; (3) waitForCompletion fails with "no response
// appeared" when no NEW model text ever shows up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMockGeminiHomePage, HOME_SCREEN_TEXT } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

test('home-screen text is never returned as an answer (hero outside and inside the conversation)', () => {
  for (const inside of [false, true]) {
    const page = createMockGeminiHomePage({ homeHeroInsideConvo: inside });
    const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
    assert.deepEqual(adapter.getAllResponses(), [], 'hero inside convo: ' + inside + ' — no responses at all');
    assert.equal(adapter.getLatestResponseText(), '', 'hero inside convo: ' + inside + ' — latest text is empty, never the suggestions');
  }
});

test('Enter fallback where Enter does NOT submit fails fast, never returns home-screen text', async () => {
  const page = createMockGeminiHomePage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 60000 });
  const started = Date.now();
  const res = await adapter.ask('写一个番茄钟网页');
  assert.equal(res.ok, false);
  assert.match(res.error, /Enter fallback also did not send/);
  assert.equal(res.answer, undefined, 'no answer at all — certainly not the home screen');
  assert.doesNotMatch(res.error, /需要我为你做些什么/, 'the error must not carry home-screen text either');
  assert.ok(Date.now() - started < 5000, 'should fail fast, not wait out the 60s timeout');
});

test('confirmSent with only a text change and no streaming/box-clear returns false (the -006 re-render trap)', async () => {
  const page = createMockGeminiHomePage({ enterRerendersHome: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('写一个番茄钟网页');
  // The trap was armed: Enter replaced the hero with DIFFERENT text, so
  // the old "response text changed" heuristic would have called this sent.
  assert.notEqual(page.hero.textContent, HOME_SCREEN_TEXT, 'the home text really did change under Enter');
  assert.equal(res.ok, false, 'a text change alone must never count as sent');
  assert.match(res.error, /Enter fallback also did not send/);
  assert.doesNotMatch(res.error, /需要我为你做些什么/);
});

test('Enter fallback where Enter DOES submit succeeds end-to-end (and the answer is not home-screen text)', async () => {
  const page = createMockGeminiHomePage({ sendOnEnter: true, chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.doesNotMatch(res.answer, /需要我为你做些什么/);
  assert.equal(res.model, 'gemini-web');
});

test('box clears but no response ever appears fails with "no response appeared" (never home-screen text)', async () => {
  const page = createMockGeminiHomePage({ enterClearsBox: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 400 });
  const res = await adapter.ask('写一个番茄钟网页');
  assert.equal(res.ok, false, 'confirmSent passed (box cleared) but no model text ever appeared — must fail, not return the home screen');
  assert.match(res.error, /no response appeared/);
  assert.match(res.error, /adapter_version: 0\.4.4/);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
  assert.equal(res.partial, '', 'partial must be empty, never home-screen text');
  assert.doesNotMatch(res.error, /需要我为你做些什么/);
});

test('dispatchEnter focuses the editable element and dispatches a full Enter sequence with proper properties', () => {
  const page = createMockGeminiHomePage();
  const seen = [];
  page.box.addEventListener('keydown', (ev) => seen.push(['keydown', ev]));
  page.box.addEventListener('keypress', (ev) => seen.push(['keypress', ev]));
  page.box.addEventListener('keyup', (ev) => seen.push(['keyup', ev]));
  Adapter.dispatchEnter(page.box, page.win);
  assert.equal(page.box._focused, true, 'the editable element must be focused first');
  assert.deepEqual(seen.map((s) => s[0]), ['keydown', 'keypress', 'keyup']);
  for (const [type, ev] of seen) {
    assert.equal(ev.key, 'Enter', type + ': key');
    assert.equal(ev.code, 'Enter', type + ': code');
    assert.equal(ev.keyCode, 13, type + ': keyCode');
    assert.equal(ev.bubbles, true, type + ': bubbles');
    assert.equal(ev.cancelable, true, type + ': cancelable');
  }
});
