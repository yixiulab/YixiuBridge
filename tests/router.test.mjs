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
  const ctx = vm.createContext({ chrome: fakeChrome });
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
