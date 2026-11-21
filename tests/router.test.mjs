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

function makeGeminiRouter({ sendMessageImpl, pingTimeoutMs, bridge }) {
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
    bridge: bridge || { sendTaskUpdate: async () => {} },
    debugger: { snapshot: async () => ({}) },
    profile: { id: 'Profile-test', label: 'test' },
    version: '0.2.0-test',
    pingTimeoutMs,
  });
  router._testReloads = reloads;
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
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
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
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
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
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
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

test('stale content script (pre-update, no version) reloads the tab once, then proceeds', async () => {
  let pings = 0;
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') {
        pings++;
        // First ping: the tab still runs the content script from before the
        // extension was updated (no version field — Chrome does not
        // re-inject content scripts on extension reload). After the tab
        // reload it reports the current version.
        if (pings === 1) return { ok: true, page: 'gemini' };
        return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      }
      if (msg.tool === 'list_models') return { ok: true, result: { current: 'Neon', buttonText: 'Neon 高', models: [] } };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, true);
  assert.equal(res.result.current, 'Neon');
  assert.equal(pings, 2, 'ping must be retried after the reload');
  assert.deepEqual(router._testReloads, [7], 'tab must be reloaded exactly once');
});

test('content script still stale after a tab reload fails with a clear error', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.1.0' };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /still an old version/);
  assert.match(res.error, /0\.2\.0-test/);
  assert.deepEqual(router._testReloads, [7], 'tab is reloaded once before giving up');
});

// ---------- version self-check (v0.3.1) ----------
// Background: task -003 (2026-11-21) failed with the 0.2.0 send-button
// error while the panel showed 0.3.0 — the Gemini tab ran the old adapter
// and nothing said so. The ping handshake now checks the adapter version
// too, and every result/error carries it.

test('stale adapter version (content script current, adapter old) reloads the tab once, then proceeds', async () => {
  let pings = 0;
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') {
        pings++;
        // The content script is current but the adapter file in this tab
        // is still the old one — the two files can diverge after an
        // extension update, and only the adapter version catches it.
        if (pings === 1) return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.1.0' };
        return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      }
      if (msg.tool === 'list_models') return { ok: true, result: { current: 'Neon', buttonText: 'Neon 高', models: [], adapter_version: '0.2.0-test' } };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, true);
  assert.equal(res.result.current, 'Neon');
  assert.equal(pings, 2, 'ping must be retried after the reload');
  assert.deepEqual(router._testReloads, [7], 'tab must be reloaded exactly once');
});

test('content script that answers without a ping handler is stale, reloads once, then proceeds', async () => {
  let pings = 0;
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') {
        pings++;
        // Pre-0.3.0 content script: alive, but answers {ok:false} to the
        // unknown ping tool instead of a version. Reload fixes it.
        if (pings === 1) return { ok: false, error: 'unknown tool for gemini content script: ping' };
        return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      }
      if (msg.tool === 'list_models') return { ok: true, result: { current: 'Neon', buttonText: 'Neon 高', models: [] } };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(router._testReloads, [7], 'tab must be reloaded exactly once');
});

test('content script that never answers reloads the tab once, then proceeds', async () => {
  let pings = 0;
  const router = makeGeminiRouter({
    pingTimeoutMs: 50,
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') {
        pings++;
        // Orphaned script after an extension reload: the tab never
        // answers at all (Chrome drops the old context). A tab reload
        // injects the current scripts. (pingTimeoutMs is tiny here, so
        // each _pingContentScript call makes exactly one attempt: the
        // first call fails, the reload happens, the second answers.)
        if (pings <= 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      }
      if (msg.tool === 'list_models') return { ok: true, result: { current: 'Neon', buttonText: 'Neon 高', models: [] } };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(router._testReloads, [7], 'tab must be reloaded exactly once');
});

test('content script still silent after a reload fails with a clear error', async () => {
  const router = makeGeminiRouter({
    pingTimeoutMs: 50,
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') throw new Error('Could not establish connection. Receiving end does not exist.');
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /did not answer even after reloading/);
  assert.deepEqual(router._testReloads, [7], 'tab is reloaded once before giving up — never in a loop');
});

test('ask_gemini success result carries adapter_version through', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      if (msg.tool === 'ask_gemini') {
        setTimeout(() => router.onAskResult(msg.taskId, { ok: true, answer: 'hi', model: 'Neon', elapsedMs: 10, adapter_version: '0.2.0-test' }), 5);
        return { ok: true, started: true, taskId: msg.taskId };
      }
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'ask_gemini', params: { prompt: 'hello', timeout_s: 30 } });
  assert.equal(res.ok, true);
  assert.equal(res.result.answer, 'hi');
  assert.equal(res.result.adapter_version, '0.2.0-test');
});

test('ask_gemini failure names the adapter version in the error', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      if (msg.tool === 'ask_gemini') {
        setTimeout(() => router.onAskResult(msg.taskId, { ok: false, error: 'gemini send button not found — UI may have changed', adapter_version: '0.1.0' }), 5);
        return { ok: true, started: true, taskId: msg.taskId };
      }
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'ask_gemini', params: { prompt: 'hello', timeout_s: 30 } });
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
  assert.match(res.error, /\[adapter_version: 0\.1\.0\]/, 'the stale version must be visible in the error text itself');
});

test('list_models error names the adapter version in the error', async () => {
  const router = makeGeminiRouter({
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      if (msg.tool === 'list_models') return { ok: false, error: 'gemini model picker button not found', adapter_version: '0.2.0-test' };
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'list_models', params: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /model picker button not found/);
  assert.match(res.error, /\[adapter_version: 0\.2\.0-test\]/);
});

// ---------- task registration at ask start (v0.3.4) ----------
// Background: task -007 — the bridge timer fired with a bare error and no
// task_id, so the runner failed while the answer sat in the tab. The router
// now registers the task with the bridge the moment the ask starts, so the
// bridge can hand the caller that id on timeout.

test('ask_gemini registers the task with the bridge immediately (running update before the answer)', async () => {
  const taskUpdates = [];
  const router = makeGeminiRouter({
    bridge: { sendTaskUpdate: async (frame) => { taskUpdates.push(frame); } },
    sendMessageImpl: async (tabId, msg) => {
      if (msg.tool === 'ping') return { ok: true, page: 'gemini', version: '0.2.0-test', adapter_version: '0.2.0-test' };
      if (msg.tool === 'ask_gemini') {
        setTimeout(() => router.onAskResult(msg.taskId, { ok: true, answer: 'hi', model: 'Neon', elapsedMs: 10 }), 5);
        return { ok: true, started: true, taskId: msg.taskId };
      }
      throw new Error('unexpected tool ' + msg.tool);
    },
  });
  const res = await router.handle({ tool: 'ask_gemini', params: { prompt: 'hello', timeout_s: 30 } });
  assert.equal(res.ok, true);
  assert.equal(res.result.answer, 'hi');
  assert.ok(taskUpdates.length >= 2, 'expected a running registration plus the completion update, got ' + JSON.stringify(taskUpdates));
  assert.equal(taskUpdates[0].taskId, res.result.task_id);
  assert.equal(taskUpdates[0].task.status, 'running', 'the first update registers the task as running so the bridge can hand out its id on timeout');
  assert.equal(taskUpdates[1].taskId, res.result.task_id);
  assert.equal(taskUpdates[1].task.status, 'done');
});
