// YixiuBridge — router read_page tests (Node native runner, fake chrome).
// Proves read_page prefers the tab's content script (no debugger, no
// Chrome debugging infobar) and only falls back to a brief debugger
// attach for tabs without a content script. No real Chrome, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadRouter(fakeChrome) {
  const src = fs.readFileSync(new URL('../extension/background/router.js', import.meta.url), 'utf8');
  // The router uses host timers (setTimeout in _waitForTask); pass them in.
  const ctx = vm.createContext({ chrome: fakeChrome, setTimeout, clearTimeout });
  vm.runInContext(src, ctx);
  return ctx.YixiuBridgeRouter;
}

function makeRouter({ tab, sendMessageImpl, snapshotImpl }) {
  const debuggerCalls = [];
  const fakeDebugger = {
    snapshot: async (tabId) => {
      debuggerCalls.push(tabId);
      if (snapshotImpl) return snapshotImpl(tabId);
      return { title: 'via debugger', url: tab.url, textExcerpt: 'dbg', textLength: 3 };
    },
  };
  const fakeChrome = {
    tabs: {
      query: async () => [tab],
      sendMessage: (tabId, msg) => sendMessageImpl(tabId, msg),
    },
  };
  const Router = loadRouter(fakeChrome);
  const router = new Router({
    bridge: { sendTaskUpdate: async () => {} },
    debugger: fakeDebugger,
    profile: { id: 'Profile-test', label: 'test' },
    version: '0.1.0-test',
  });
  return { router, debuggerCalls };
}

test('read_page on a Gemini tab uses the content script and never touches the debugger', async () => {
  const tab = { id: 7, title: 'Gemini', url: 'https://gemini.google.com/app', active: true };
  const snapshot = { title: 'Gemini', url: tab.url, textExcerpt: 'hello gemini', textLength: 12 };
  const { router, debuggerCalls } = makeRouter({
    tab,
    sendMessageImpl: async (tabId, msg) => {
      assert.equal(tabId, 7);
      assert.equal(msg.tool, 'read_page');
      return { ok: true, snapshot };
    },
  });
  const res = await router.handle({ tool: 'read_page', params: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, snapshot);
  assert.deepEqual(debuggerCalls, [], 'debugger must not be used when the content script answers');
});

test('read_page on a tab without a content script falls back to the debugger', async () => {
  const tab = { id: 9, title: 'Some page', url: 'https://example.com/', active: true };
  const { router, debuggerCalls } = makeRouter({
    tab,
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  const res = await router.handle({ tool: 'read_page', params: {} });
  assert.equal(res.ok, true);
  assert.equal(res.result.title, 'via debugger');
  assert.deepEqual(debuggerCalls, [9]);
});

test('read_page on a Chrome internal page does not attach anything', async () => {
  const tab = { id: 3, title: 'Extensions', url: 'chrome://extensions', active: true };
  let sendMessageCalled = false;
  const { router, debuggerCalls } = makeRouter({
    tab,
    sendMessageImpl: async () => { sendMessageCalled = true; return { ok: true, snapshot: {} }; },
  });
  const res = await router.handle({ tool: 'read_page', params: {} });
  assert.equal(res.ok, true);
  assert.match(res.result.note, /cannot be read/);
  assert.equal(sendMessageCalled, false);
  assert.deepEqual(debuggerCalls, []);
});

// ---------- list_models / ask_gemini model routing ----------

function makeGeminiRouter({ sendMessageImpl }) {
  const tab = { id: 7, title: 'Gemini', url: 'https://gemini.google.com/app', active: true, status: 'complete' };
  const fakeChrome = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      create: async () => tab,
      sendMessage: (tabId, msg) => sendMessageImpl(tabId, msg),
    },
  };
  const Router = loadRouter(fakeChrome);
  const router = new Router({
    bridge: { sendTaskUpdate: async () => {} },
    debugger: { snapshot: async () => ({}) },
    profile: { id: 'Profile-test', label: 'test' },
    version: '0.2.0-test',
  });
  return router;
}

test('list_models reaches the Gemini content script and returns its result', async () => {
  const modelsResult = {
    current: 'Neon',
    buttonText: 'Neon 高',
    models: [{ label: '更深入的分析', codename: 'Neon', description: '', selected: true, locked: false }],
  };
  const seen = [];
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      seen.push(msg);
      if (msg.tool === 'ping') return { ok: true, page: 'gemini' };
      if (msg.tool === 'list_models') return { ok: true, result: modelsResult };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, modelsResult);
  assert.equal(seen.some((m) => m.tool === 'list_models'), true);
});

test('list_models reports a clear error when the content script fails', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini' };
      if (msg.tool === 'list_models') return { ok: false, error: 'gemini model picker button not found' };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /model picker button not found/);
});

test('ask_gemini passes model and thinking through to the content script', async () => {
  const seen = [];
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      seen.push(msg);
      if (msg.tool === 'ping') return { ok: true, page: 'gemini' };
      if (msg.tool === 'ask_gemini') {
        // Simulate the content script finishing immediately.
        setTimeout(() => router.onAskResult(msg.taskId, { ok: true, answer: 'hi', model: 'Neon', elapsedMs: 10 }), 5);
        return { ok: true, started: true, taskId: msg.taskId };
      }
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'ask_gemini', params: { prompt: 'hello', model: 'Neon', thinking: '高', timeout_s: 30 } });
  assert.equal(res.ok, true);
  assert.equal(res.result.answer, 'hi');
  assert.equal(res.result.model, 'Neon');
  const askMsg = seen.find((m) => m.tool === 'ask_gemini');
  assert.equal(askMsg.params.model, 'Neon');
  assert.equal(askMsg.params.thinking, '高');
  assert.equal(askMsg.params.prompt, 'hello');
});
