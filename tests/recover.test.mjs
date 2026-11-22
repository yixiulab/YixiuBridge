// YixiuBridge — answer-recovery tests (v0.4.13, Node native runner).
// Proves the fix for the 2026-11-22 teacher-testpc saga: Gemini had
// answered in the tab, but the runner's fetch aborted ("This operation
// was aborted", no task_id) and the send check misjudged, so the answer
// was thrown away as a failed file. The recovery path reads the latest
// COMPLETE answer already in the tab — adapter, router, and bridge
// levels — without asking again, and refuses when the prompt never
// left the box, so a previous turn's answer is never returned as this
// turn's. No real Chrome, no network, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createMockGeminiPage } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

// ---------- adapter: recoverLastAnswer ----------

test('recoverLastAnswer returns the latest answer after a successful ask', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  const rec = adapter.recoverLastAnswer('What is 2+2?');
  assert.equal(rec.ok, true);
  assert.equal(rec.answer, '4 is the answer.');
  assert.equal(rec.recovered, true);
});

test('recoverLastAnswer refuses when the prompt was never sent (stale previous answer)', async () => {
  // realStructure pages start with a prior turn already answered, so a
  // naive "latest response" read would return that old answer.
  const page = createMockGeminiPage({ chunks: ['new'], chunkMs: 10, realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const rec = adapter.recoverLastAnswer('a brand new question nobody asked');
  assert.equal(rec.ok, false);
  assert.match(rec.error, /never sent/);
});

test('recoverLastAnswer refuses after a send failure — nothing new appeared', async () => {
  const page = createMockGeminiPage({ realStructure: true });
  page.send.remove();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
  const rec = adapter.recoverLastAnswer('hello');
  assert.equal(rec.ok, false);
  assert.match(rec.error, /no new response appeared/);
});

test('recoverLastAnswer refuses a still-streaming answer', async () => {
  const page = createMockGeminiPage({ chunks: ['s', 'l', 'o', 'w'], chunkMs: 50, realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const p = adapter.ask('slow one');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(adapter.isStreaming(), true, 'must still be streaming when recovery is attempted');
  const rec = adapter.recoverLastAnswer('slow one');
  assert.equal(rec.ok, false);
  assert.match(rec.error, /still streaming/);
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.answer, 'slow');
});

test('recoverLastAnswer without a stored ask falls back to the user-query match', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, realStructure: true });
  const asker = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await asker.ask('What is 2+2?');
  assert.equal(res.ok, true);
  // A fresh adapter instance never ran the ask, so it has no baseline —
  // it must prove the prompt was sent from the latest user-query turn.
  const fresh = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const rec = fresh.recoverLastAnswer('What is 2+2?');
  assert.equal(rec.ok, true);
  assert.equal(rec.answer, '4 is the answer.');
  const miss = fresh.recoverLastAnswer('a question nobody asked');
  assert.equal(miss.ok, false);
  assert.match(miss.error, /never sent/);
});

// ---------- prompt rendering tolerance (v0.4.14) ----------
// Background: teacher-testpc-004 (2026-11-22 18:15) missed recovery
// while the prompt WAS in the tab — the v0.4.13 check wanted the
// prompt's first 60 chars verbatim in the latest user-query turn, and
// whatever the page did to the rendering broke that. The match is now
// tolerant of a front prefix, a cut head and a cut tail, while a
// genuinely different question still misses.

const LONG_PROMPT = '请把老师关于 Windows 测试电脑一键安装脚本的那份完整回答再发一遍，包括 .bat 和 .ps1 的模板、提权写法和 winget 的三个坑，一个字都不要少，我要直接复制使用。';

function latestQueryLine(page) {
  const lines = page.doc.querySelectorAll('.query-text-line');
  assert.ok(lines.length > 0, 'the mock page must have a user-query line');
  return lines[lines.length - 1];
}

test('recoverLastAnswer matches when the query carries a front prefix and a cut head', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, realStructure: true });
  const asker = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await asker.ask(LONG_PROMPT);
  assert.equal(res.ok, true);
  // The page shows the prompt with a short prefix in front and the
  // first 30 chars cut — the strict head-60 check fails, the tail-40
  // check must still match.
  latestQueryLine(page).textContent = '你说：' + LONG_PROMPT.slice(30);
  const fresh = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const rec = fresh.recoverLastAnswer(LONG_PROMPT);
  assert.equal(rec.ok, true, 'expected a tail match, got: ' + JSON.stringify(rec));
  assert.equal(rec.answer, '4 is the answer.');
});

test('recoverLastAnswer matches when the page shows only the first 40 chars of the prompt', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, realStructure: true });
  const asker = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await asker.ask(LONG_PROMPT);
  assert.equal(res.ok, true);
  // Truncated tail: the strict head-60 check fails (the shown text is
  // shorter than 60 chars), the reverse containment must still match.
  latestQueryLine(page).textContent = LONG_PROMPT.slice(0, 40);
  const fresh = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const rec = fresh.recoverLastAnswer(LONG_PROMPT);
  assert.equal(rec.ok, true, 'expected a truncated-display match, got: ' + JSON.stringify(rec));
  assert.equal(rec.answer, '4 is the answer.');
});

test('recoverLastAnswer still refuses a different question after rendering changes', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10, realStructure: true });
  const asker = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await asker.ask(LONG_PROMPT);
  assert.equal(res.ok, true);
  // Same rendering quirks, but the latest turn is a different question:
  // the tolerant checks must not conjure a match out of it.
  latestQueryLine(page).textContent = '你说：请把老师关于意大利小镇故事的那份选题清单再发一遍，包括庞贝和古罗马人的一天。';
  const fresh = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const rec = fresh.recoverLastAnswer(LONG_PROMPT);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /never sent/);
});

test('ask recovers the late answer when the send checks misjudge a slow page', async () => {
  // The click schedules streaming 150ms later, so every send check
  // (sendCheckMs 10ms) misjudges — the answer is already in the tab
  // by the time recovery polls, and must come back as a recovered
  // success instead of a "send did not register" failure.
  const page = createMockGeminiPage({ chunks: ['late', ' answer'], chunkMs: 10, sendStartsLateMs: 150, realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('late one');
  assert.equal(res.ok, true, 'expected a recovered answer, got: ' + JSON.stringify(res));
  assert.equal(res.answer, 'late answer');
  assert.equal(res.recovered, true);
});

test('measureSendButton returns the send button centre', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST });
  const m = adapter.measureSendButton();
  assert.equal(m.ok, true);
  // FakeElement.getBoundingClientRect is a fixed rect (centre 160,218).
  assert.equal(m.x, 160);
  assert.equal(m.y, 218);
});

// ---------- router: recover_last_answer ----------

function loadRouter(fakeChrome) {
  const src = fs.readFileSync(new URL('../extension/background/router.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({ chrome: fakeChrome, setTimeout, clearTimeout });
  vm.runInContext(src, ctx);
  return ctx.YixiuBridgeRouter;
}

function makeGeminiRouter({ sendMessageImpl }) {
  const tab = { id: 7, title: 'Gemini', url: 'https://gemini.google.com/app', active: true, status: 'complete' };
  const reloads = [];
  const fakeChrome = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      create: async () => tab,
      reload: async (tabId) => { reloads.push(tabId); },
      sendMessage: (tabId, msg) => sendMessageImpl(tabId, msg),
    },
  };
  const Router = loadRouter(fakeChrome);
  const router = new Router({
    bridge: { sendTaskUpdate: async () => {} },
    debugger: { snapshot: async () => ({}) },
    profile: { id: 'Profile-test', label: 'test' },
    version: '0.4.13-test',
  });
  router._testReloads = reloads;
  return router;
}

test('router recover_last_answer returns the tab answer without reloading the tab', async () => {
  const seen = [];
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      seen.push(msg);
      assert.equal(msg.tool, 'recover_last_answer');
      assert.equal(msg.params.prompt, 'What is 2+2?');
      return { ok: true, result: { answer: '4 is the answer.', model: 'gemini-web', adapter_version: '0.4.13', recovered: true } };
    },
  });
  const res = await router.handle({ tool: 'recover_last_answer', params: { prompt: 'What is 2+2?' } });
  assert.equal(res.ok, true);
  assert.equal(res.result.answer, '4 is the answer.');
  assert.equal(res.result.recovered, true);
  assert.deepEqual(router._testReloads, [], 'recovery must never reload the tab — the reload would destroy the answer');
});

test('router recover_last_answer reports no answer instead of asking again', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async () => ({ ok: false, error: 'recover: no new response appeared since the ask started', adapter_version: '0.4.13' }),
  });
  const res = await router.handle({ tool: 'recover_last_answer', params: { prompt: 'hello' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /recover_last_answer/);
  assert.match(res.error, /no new response appeared/);
  assert.deepEqual(router._testReloads, [], 'a recovery miss must not reload the tab either');
});

test('router recover_last_answer with no Gemini tab errors clearly', async () => {
  const fakeChrome = {
    tabs: {
      query: async () => [],
      get: async () => { throw new Error('no such tab'); },
      sendMessage: async () => { throw new Error('must not be called'); },
    },
  };
  const Router = loadRouter(fakeChrome);
  const router = new Router({
    bridge: { sendTaskUpdate: async () => {} },
    debugger: {},
    profile: { id: 'Profile-test', label: 'test' },
    version: '0.4.13-test',
  });
  const res = await router.handle({ tool: 'recover_last_answer', params: { prompt: 'hello' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /no Gemini tab is open/);
});
