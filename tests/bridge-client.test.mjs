// YixiuBridge — bridge client (extension SSE) tests (Node native runner).
// Proves the v0.4.16 generation guard: stop() + connect() while the old
// reconnect loop is asleep must replace the loop, not leave two loops
// fetching the SSE stream. No real Chrome, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadBridgeClient(fakeFetch) {
  const src = fs.readFileSync(new URL('../extension/background/bridge-client.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    fetch: fakeFetch,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(src, ctx);
  return ctx.YixiuBridgeBridgeClient;
}

test('a second connect() replaces the first loop instead of running two streams (v0.4.16)', async () => {
  // Stream 1 closes at once (bridge restarted); stream 2 stays open.
  // The old loop sleeps its 1000ms reconnect delay after stream 1 dies.
  // connect() #2 must take over: when the old loop wakes, it sees its
  // generation no longer matches and exits WITHOUT fetching again.
  let fetchCalls = 0;
  const fakeFetch = () => {
    fetchCalls++;
    const n = fetchCalls;
    const reader = {
      read: () => {
        if (n === 1) return new Promise((r) => setTimeout(() => r({ done: true }), 10));
        return new Promise(() => {}); // stream 2 never yields — the new loop stays in it
      },
      releaseLock: () => {},
    };
    return Promise.resolve({ ok: true, body: { getReader: () => reader } });
  };
  const BridgeClient = loadBridgeClient(fakeFetch);
  const client = new BridgeClient({
    profile: { id: 'Profile-test', label: 'test' },
    onToolCall: async () => {},
    onStatus: () => {},
  });
  const p1 = client.connect();
  await new Promise((r) => setTimeout(r, 50)); // stream 1 closed; old loop is in its reconnect sleep
  assert.equal(fetchCalls, 1);
  const p2 = client.connect(); // takes over while the old loop sleeps
  assert.equal(fetchCalls, 2);
  await new Promise((r) => setTimeout(r, 1300)); // past the old loop's 1000ms reconnect delay
  assert.equal(fetchCalls, 2, 'the replaced loop must not fetch a third stream');
  client.stop();
  await p1; // the old loop has exited by now
  // p2 never resolves on its own (stream 2 never yields) — do not await it.
  assert.equal(client.connected, false, 'stop() marks the client disconnected');
});

test('stop() marks the client disconnected and a fresh connect() works', async () => {
  let fetchCalls = 0;
  const fakeFetch = () => {
    fetchCalls++;
    const reader = {
      read: () => new Promise((r) => setTimeout(() => r({ done: true }), 10)),
      releaseLock: () => {},
    };
    return Promise.resolve({ ok: true, body: { getReader: () => reader } });
  };
  const BridgeClient = loadBridgeClient(fakeFetch);
  const client = new BridgeClient({
    profile: { id: 'Profile-test', label: 'test' },
    onToolCall: async () => {},
    onStatus: () => {},
  });
  const p = client.connect();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetchCalls, 1);
  assert.equal(client.connected, false, 'stream closed at once, so the client is disconnected');
  client.stop();
  await p;
  // Reconnect after a stop: a new generation starts a fresh loop.
  const p2 = client.connect();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetchCalls, 2);
  client.stop();
  await p2;
});
