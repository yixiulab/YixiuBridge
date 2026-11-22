// YixiuBridge — model selection tests (Node native runner, fake DOM).
// Proves list_models / selectModel / selectThinkingLevel against the mock
// Gemini page, whose model menu mirrors the real Chinese UI (Nov 2026,
// from the user's screenshot):
//   自动 / 日常帮助 (Hydrogen) / 更深入的分析 (Neon, selected) /
//   代码和复杂工作 (Carbon, LOCKED) + 思考等级 submenu (高/中/低).
// No real Chrome, no network, no login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMockGeminiPage } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

test('list_models returns all 4 menu entries with label, codename, selected and locked', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST });
  const res = await adapter.listModels();
  assert.equal(res.ok, true);
  assert.equal(res.current, 'Neon');
  assert.match(res.buttonText, /Neon/);
  assert.equal(res.models.length, 4);
  const byCode = {};
  for (const m of res.models) byCode[m.codename || m.label] = m;
  assert.equal(byCode['自动'].label, '自动');
  assert.equal(byCode['自动'].codename, null);
  assert.equal(byCode['自动'].description, '根据需求调整回答');
  assert.equal(byCode['自动'].selected, false);
  assert.equal(byCode['自动'].locked, false);
  assert.equal(byCode.Hydrogen.label, '日常帮助');
  assert.equal(byCode.Hydrogen.selected, false);
  assert.equal(byCode.Hydrogen.locked, false);
  assert.equal(byCode.Neon.label, '更深入的分析');
  assert.equal(byCode.Neon.selected, true);
  assert.equal(byCode.Neon.locked, false);
  assert.equal(byCode.Carbon.label, '代码和复杂工作');
  assert.equal(byCode.Carbon.selected, false);
  assert.equal(byCode.Carbon.locked, true);
});

test('list_models closes the menu afterwards and does not change the selection', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST });
  await adapter.listModels();
  assert.equal(page.doc.querySelector('[role="menu"]'), null, 'menu must be closed after list_models');
  assert.equal(page.picker.textContent, 'Neon 高');
});

test('ask with the already-selected model (Neon) succeeds without switching', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Neon' });
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.model, 'Neon');
  assert.equal(page.picker.textContent, 'Neon 高');
});

test('ask with model Hydrogen switches the picker and the button text verifies ("Hydrogen 高")', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Hydrogen' });
  assert.equal(res.ok, true);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.model, 'Hydrogen');
  assert.equal(page.picker.textContent, 'Hydrogen 高');
  assert.equal(page.doc.querySelector('[role="menu"]'), null, 'menu must be closed after the ask');
});

test('ask with a Chinese label ("日常帮助") selects the matching model', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: '日常帮助' });
  assert.equal(res.ok, true);
  assert.equal(res.model, 'Hydrogen');
  assert.equal(page.picker.textContent, 'Hydrogen 高');
});

test('ask with the locked model Carbon fails fast with a clear "locked" error and never sends', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const started = Date.now();
  const res = await adapter.ask('hello', { model: 'Carbon' });
  assert.equal(res.ok, false);
  assert.match(res.error, /locked/);
  assert.match(res.error, /Carbon/);
  assert.ok(Date.now() - started < 5000, 'locked model must fail fast');
  assert.equal(page.doc.querySelector('.model-response-text'), null, 'no answer must be started');
  assert.equal(page.picker.textContent, 'Neon 高', 'selection must not change');
  assert.equal(page.doc.querySelector('[role="menu"]'), null, 'menu must be closed after the error');
});

test('ask with an unknown model fails fast and lists the available models', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Pluto' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
  assert.match(res.error, /Pluto/);
  assert.match(res.error, /Neon/);
  assert.match(res.error, /Hydrogen/);
  assert.equal(page.doc.querySelector('.model-response-text'), null, 'no answer must be started');
});

test('ask with a thinking level switches the level and reports the applied level (v0.4.4)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { thinking: '低' });
  assert.equal(res.ok, true);
  assert.equal(res.answer, 'ok');
  assert.equal(res.appliedThinking, '低');
  assert.equal(page.picker.textContent, 'Neon 低');
});

test('ask with a thinking level that does not stick warns and still answers (v0.4.2)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, levelSticks: false, initialLevel: '中' });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { thinking: '高' });
  assert.equal(res.ok, true, 'a level that will not stick must not fail the ask');
  assert.equal(res.answer, 'ok');
  assert.match(res.thinkingWarning || '', /did not stick/);
  assert.match(res.thinkingWarning || '', /selected level is "中"/);
  assert.equal(res.appliedThinking, '中');
  assert.equal(page.picker.textContent, 'Neon 中');
});

test('model menu that swallows the first click still opens on retry (v0.4.2)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10, menuOpensOnClick: 2 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Neon' });
  assert.equal(res.ok, true, 'a swallowed first click must not fail the ask');
  assert.equal(res.answer, 'ok');
});

test('ask with model + thinking level applies both', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { model: 'Hydrogen', thinking: '中' });
  assert.equal(res.ok, true);
  assert.equal(res.model, 'Hydrogen');
  assert.equal(res.appliedThinking, '中');
  assert.equal(page.picker.textContent, 'Hydrogen 中');
});

test('ask with an unknown thinking level fails fast and lists the available levels', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello', { thinking: '超高' });
  assert.equal(res.ok, false);
  assert.match(res.error, /thinking level/);
  assert.match(res.error, /超高/);
  assert.match(res.error, /高/);
  assert.equal(page.doc.querySelector('.model-response-text'), null, 'no answer must be started');
});

test('list_models on a page without a model picker returns a clear error', async () => {
  const page = createMockGeminiPage();
  page.picker.remove();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.listModels();
  assert.equal(res.ok, false);
  assert.match(res.error, /model picker button not found/);
});

test('ask without a model keeps the current UI selection (Neon)', async () => {
  const page = createMockGeminiPage({ chunks: ['ok'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, true);
  assert.equal(res.model, 'gemini-web');
  assert.equal(page.picker.textContent, 'Neon 高');
});
