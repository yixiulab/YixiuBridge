// YixiuBridge — debugger manager tests (Node native runner, fake chrome).
// Proves the debugger attaches on demand and detaches as soon as the
// evaluation is done, so Chrome's "is debugging this browser" infobar
// only shows briefly during a read_page call instead of staying up forever.
// No real Chrome, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadDebuggerManager(fakeChrome) {
  const src = fs.readFileSync(new URL('../extension/background/debugger.js', import.meta.url), 'utf8');
  // trustedClick (v0.4.11) sleeps between the CDP mouse events; the vm
  // context has no timers by default, so pass Node's setTimeout in.
  const ctx = vm.createContext({ chrome: fakeChrome, setTimeout });
  vm.runInContext(src, ctx);
  return ctx.YixiuBridgeDebuggerManager;
}

function makeFakeChrome({ sendCommandImpl } = {}) {
  const calls = [];
  const send = sendCommandImpl || (async () => ({ result: { value: 42 } }));
  return {
    calls,
    debugger: {
      attach(target) {
        calls.push(['attach', target.tabId]);
        return Promise.resolve();
      },
      detach(target) {
        calls.push(['detach', target.tabId]);
        return Promise.resolve();
      },
      sendCommand(target, method, params) {
        calls.push(['sendCommand', target.tabId, method]);
        return send(target, method, params);
      },
    },
  };
}

test('evaluate detaches after success and leaves no attach behind', async () => {
  const fake = makeFakeChrome();
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  const value = await mgr.evaluate(7, '1+1');
  assert.equal(value, 42);
  assert.deepEqual(fake.calls, [
    ['attach', 7],
    ['sendCommand', 7, 'Runtime.evaluate'],
    ['detach', 7],
  ]);
  assert.equal(mgr.isAttached(7), false);
});

test('evaluate detaches even when the page throws', async () => {
  const fake = makeFakeChrome({
    sendCommandImpl: async () => ({ exceptionDetails: { text: 'boom' } }),
  });
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  await assert.rejects(mgr.evaluate(9, 'bad()'), /page evaluation failed: boom/);
  assert.deepEqual(fake.calls, [
    ['attach', 9],
    ['sendCommand', 9, 'Runtime.evaluate'],
    ['detach', 9],
  ]);
  assert.equal(mgr.isAttached(9), false);
});

test('evaluate detaches even when sendCommand fails and the retry fails too', async () => {
  const fake = makeFakeChrome({
    sendCommandImpl: async () => { throw new Error('tab gone'); },
  });
  // Second attach fails as well: make attach reject after the first call.
  let attaches = 0;
  fake.debugger.attach = (target) => {
    fake.calls.push(['attach', target.tabId]);
    attaches++;
    if (attaches > 1) return Promise.reject(new Error('cannot attach'));
    return Promise.resolve();
  };
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  await assert.rejects(mgr.evaluate(11, '1+1'), /re-attach failed/);
  assert.equal(mgr.isAttached(11), false);
  // Attach, first command fails, real detach, re-attach fails. The final
  // detach in the finally block is a no-op (nothing attached any more).
  assert.deepEqual(fake.calls, [
    ['attach', 11],
    ['sendCommand', 11, 'Runtime.evaluate'],
    ['detach', 11],
    ['attach', 11],
  ]);
});

test('concurrent evaluations on the same tab share one attach and detach once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = makeFakeChrome({
    sendCommandImpl: async () => {
      await gate;
      return { result: { value: 'done' } };
    },
  });
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  const p1 = mgr.evaluate(5, 'a()');
  const p2 = mgr.evaluate(5, 'b()');
  // Both are in flight; nothing detached yet.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'detach'), []);
  release();
  assert.deepEqual(await Promise.all([p1, p2]), ['done', 'done']);
  assert.equal(fake.calls.filter((c) => c[0] === 'attach').length, 1);
  assert.equal(fake.calls.filter((c) => c[0] === 'detach').length, 1);
  assert.equal(mgr.isAttached(5), false);
});

test('snapshot uses evaluate, so it also detaches', async () => {
  const fake = makeFakeChrome({
    sendCommandImpl: async () => ({
      result: { value: { title: 't', url: 'https://example.com/', textExcerpt: 'hi', textLength: 2 } },
    }),
  });
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  const snap = await mgr.snapshot(3);
  assert.equal(snap.title, 't');
  assert.equal(mgr.isAttached(3), false);
  assert.ok(fake.calls.some((c) => c[0] === 'detach' && c[1] === 3));
});

test('trustedClick sends the mouseMoved -> mousePressed -> mouseReleased sequence (v0.4.11)', async () => {
  // The teacher's answer (2026-11-22): a CDP trusted click is a real
  // (isTrusted true) click — the only input the Gemini thinking-level
  // submenu items accept. It assumes the tab is already attached.
  const commands = [];
  const fake = makeFakeChrome({
    sendCommandImpl: async (target, method, params) => {
      commands.push({ method, params });
      return {};
    },
  });
  const Manager = loadDebuggerManager(fake);
  const mgr = new Manager();
  await mgr.attach(7);
  await mgr.trustedClick(7, 160, 218);
  assert.equal(commands.length, 3);
  assert.equal(commands[0].method, 'Input.dispatchMouseEvent');
  assert.equal(commands[0].params.type, 'mouseMoved');
  assert.equal(commands[0].params.x, 160);
  assert.equal(commands[0].params.y, 218);
  assert.equal(commands[0].params.button, 'none');
  assert.equal(commands[1].params.type, 'mousePressed');
  assert.equal(commands[1].params.button, 'left');
  assert.equal(commands[1].params.buttons, 1);
  assert.equal(commands[1].params.clickCount, 1);
  assert.equal(commands[2].params.type, 'mouseReleased');
  assert.equal(commands[2].params.button, 'left');
  assert.equal(commands[2].params.buttons, 0);
  assert.equal(commands[2].params.clickCount, 1);
  assert.equal(mgr.isAttached(7), true, 'trustedClick does not detach — the caller detaches');
});
