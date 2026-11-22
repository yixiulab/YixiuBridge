// YixiuBridge — real Gemini DOM structure tests (v0.3.6, task -009).
// Ground truth 2026-11-21: task -009 failed with "gemini no response
// appeared" although the answer WAS rendered in the tab (user screenshot:
// user bubble + full HTML code block, tab "番茄钟网页生成").
// Root cause: responseScope() picked [data-test-id="conversation"] as the
// conversation container — on the REAL page that selector matches the
// SIDEBAR conversation-list links (a[data-test-id="conversation"]), so
// every response query ran inside a sidebar link and found nothing. The
// mock page had invented [data-test-id="conversation"] as the chat
// container, so the tests never saw it. The real structure (confirmed by
// independent DOM analyses, Apr–Jul 2026) is:
//   infinite-scroller.chat-history (or [data-test-id="chat-history-container"])
//     div.conversation-container          // one per turn
//       user-query > .query-text > p.query-text-line
//       model-response
//         structured-content-container.model-response-text
//           > .markdown.markdown-main-panel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMockGeminiPage, createMockGeminiHomePage } from './mock-gemini.mjs';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };
const CODE_ANSWER = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<title>番茄钟</title>\n</head>';

test('fake DOM matches hyphenated custom-element tags (model-response, user-query, infinite-scroller)', () => {
  const doc = new FakeDocument();
  const scroller = new FakeElement('infinite-scroller', { class: 'chat-history' });
  const turn = new FakeElement('div', { class: 'conversation-container' });
  const uq = new FakeElement('user-query');
  const mr = new FakeElement('model-response');
  const md = new FakeElement('div', { class: 'markdown markdown-main-panel' });
  md.textContent = 'hello';
  mr.appendChild(md);
  turn.appendChild(uq);
  turn.appendChild(mr);
  scroller.appendChild(turn);
  doc.body.appendChild(scroller);
  assert.equal(doc.querySelector('model-response'), mr);
  assert.equal(doc.querySelector('user-query'), uq);
  assert.equal(doc.querySelector('infinite-scroller.chat-history'), scroller);
  assert.equal(doc.querySelector('model-response .markdown'), md);
  assert.equal(doc.querySelector('div.conversation-container'), turn);
});

test('ask on the real page structure returns the full code-block answer (-009 reproduction)', async () => {
  const chunks = [CODE_ANSWER, '\n<body>番茄钟</body>', '\n</html>'];
  const page = createMockGeminiPage({ realStructure: true, chunks, chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('做一个番茄钟网页，单文件 HTML，有开始/暂停/重置按钮，25 分钟工作、5 分钟休息，时间到了响一声（用 Web Audio API），界面要好看现代。只给完整代码，不要解释。');
  assert.equal(res.ok, true, 'must find the rendered answer, not fail with "no response appeared": ' + (res.error || ''));
  assert.ok(res.answer.indexOf('<!DOCTYPE html>') !== -1, 'the code block must be in the answer');
  assert.ok(res.answer.indexOf('番茄钟') !== -1);
  assert.equal(res.model, 'gemini-web');
});

test('ask with model Neon on the real structure works (model selection + response detection together)', async () => {
  const page = createMockGeminiPage({ realStructure: true, chunks: ['<p>ok</p>'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hi', { model: 'Neon' });
  assert.equal(res.ok, true, res.error || '');
  assert.equal(res.model, 'Neon');
  assert.equal(res.answer, '<p>ok</p>');
});

test('sidebar conversation links are never read as the response (the -009 scope trap)', async () => {
  const page = createMockGeminiPage({ realStructure: true, chunks: ['new answer'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('new question');
  assert.equal(res.ok, true, res.error || '');
  assert.equal(res.answer, 'new answer');
  const all = adapter.getAllResponses();
  assert.ok(all.indexOf('黑洞的定义') === -1, 'sidebar titles must never appear as responses');
  assert.ok(all.indexOf('光合作用定义') === -1);
});

test('leaf-most: one turn yields one response text, not the whole turn plus the markdown', () => {
  const page = createMockGeminiPage({ realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const all = adapter.getAllResponses();
  assert.equal(all.length, 1, 'the pre-existing turn contributes exactly one text, got: ' + JSON.stringify(all));
  assert.ok(all[0].indexOf('意大利面') !== -1, 'that one text is the old answer');
});

test('multi-turn: the latest answer is the newest turn, never an older one', async () => {
  const page = createMockGeminiPage({ realStructure: true, chunks: ['second answer'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('second question');
  assert.equal(res.ok, true, res.error || '');
  assert.equal(res.answer, 'second answer');
  assert.equal(adapter.getLatestResponseText(), 'second answer');
});

test('home screen with sidebar links still returns empty, never suggestions', () => {
  const page = createMockGeminiHomePage({ realStructure: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  assert.deepEqual(adapter.getAllResponses(), [], 'no model turn exists — nothing to return');
  assert.equal(adapter.getLatestResponseText(), '');
});

test('"no response appeared" error carries the conversation-structure dump', async () => {
  const page = createMockGeminiHomePage({ realStructure: true, enterClearsBox: true });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 400 });
  const res = await adapter.ask('写一个番茄钟网页');
  assert.equal(res.ok, false);
  assert.match(res.error, /no response appeared/);
  assert.match(res.error, /Conversation structure:/, 'the error must carry the structural dump');
  assert.match(res.error, /model-response=0/, 'dump counts the model turns found');
  assert.match(res.error, /scope:/, 'dump names the scope used');
  assert.match(res.error, /adapter_version: 0\.4.13/);
  assert.doesNotMatch(res.error, /需要我为你做些什么/, 'the dump is structural, never page text');
});

test('dump describes the last turns when a send clears the box but no model turn appears', async () => {
  const page = createMockGeminiPage({ realStructure: true });
  // The click clears the box (so confirmSent passes) but starts no stream.
  page.send._listeners.click = [];
  page.send.addEventListener('click', () => { page.box.textContent = ''; });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 400 });
  const res = await adapter.ask('a question with no answer');
  assert.equal(res.ok, false);
  assert.match(res.error, /no response appeared/);
  assert.match(res.error, /turn\[0\]: div\.conversation-container/, 'dump lists the existing turn');
  assert.match(res.error, /user-query/, 'dump shows the user-query child');
  assert.match(res.error, /model-response/, 'dump shows the model-response child');
  assert.match(res.error, /黑洞/, 'dump carries a short text snippet of the turn');
  assert.ok(res.error.length < 3000, 'dump is capped, not a page dump: ' + res.error.length);
});
