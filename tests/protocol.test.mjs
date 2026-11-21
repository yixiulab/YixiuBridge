// YixiuBridge — protocol tests (Node native runner).
// Real bridge server + real MCP server subprocess + a SIMULATED extension
// (SSE client that answers tool calls; ask_gemini runs the real Gemini
// adapter against the mock page). No real Chrome, no network, no login.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createBridgeServer } from '../host/bridge-server.mjs';
import { createMockGeminiPage } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');
const ROOT = join(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');

let bridge;
let bridgeUrl;
let ext;
let dataDir;
const children = new Set(); // every spawned MCP child, killed in after()

// ---------- simulated extension (SSE client) ----------
class SimulatedExtension {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.tasks = new Map();
    this._abort = null;
    this._taskSeq = 0;
  }

  async connect() {
    this._abort = new AbortController();
    const res = await fetch(this.baseUrl + '/events?profile=Profile-test&label=test', { signal: this._abort.signal });
    if (!res.ok) throw new Error('SSE connect failed: ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          let frame;
          try { frame = JSON.parse(data); } catch (e) { continue; }
          if (frame.type === 'tool_call') this._handle(frame).catch(() => {});
        }
      }
    };
    pump().catch(() => { /* aborted on disconnect */ });
  }

  disconnect() { if (this._abort) this._abort.abort(); }

  async _post(path, body) {
    await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async _handle(frame) {
    const { tool, params = {} } = frame;
    let out;
    try {
      switch (tool) {
        case 'ping':
          out = { ok: true, result: { ok: true, bridge: 'connected', version: '0.1.0-test' } };
          break;
        case 'tabs_context':
          out = { ok: true, result: { tabs: [{ id: 1, title: 'Gemini (mock)', url: 'https://gemini.google.com/app', active: true }] } };
          break;
        case 'navigate':
          out = { ok: true, result: { navigated: 1, url: params.url } };
          break;
        case 'read_page':
          out = { ok: true, result: { title: 'Gemini (mock)', url: 'https://gemini.google.com/app', textExcerpt: 'mock page', textLength: 9 } };
          break;
        case 'list_models':
          out = {
            ok: true,
            result: {
              current: 'Neon',
              buttonText: 'Neon 高',
              models: [
                { label: '自动', codename: null, description: '根据需求调整回答', selected: false, locked: false },
                { label: '日常帮助', codename: 'Hydrogen', description: '', selected: false, locked: false },
                { label: '更深入的分析', codename: 'Neon', description: '', selected: true, locked: false },
                { label: '代码和复杂工作', codename: 'Carbon', description: '', selected: false, locked: true },
              ],
            },
          };
          break;
        case 'ask_gemini':
          out = { ok: true, result: await this._askGemini(params) };
          break;
        default:
          out = { ok: false, error: 'unknown tool: ' + tool };
      }
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    await this._post('/result', { type: 'tool_result', id: frame.id, tool, ok: out.ok, result: out.result, error: out.error });
  }

  // Mirrors the real router: start the adapter in the background, wait up to
  // timeout_s for it, return pending if it is still running, and post a
  // task-update when it eventually finishes.
  async _askGemini(params) {
    const taskId = 'task_test_' + (++this._taskSeq);
    const slow = params.prompt && params.prompt.includes('SLOW');
    const page = createMockGeminiPage({
      chunks: slow ? ['s', 'l', 'o', 'w', ' ', 'answer.'] : ['4', ' is ', 'the answer.'],
      chunkMs: slow ? 500 : 10,
    });
    const adapter = Adapter.createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40, timeoutMs: 30000 });
    const started = Date.now();
    this.tasks.set(taskId, { status: 'running', startedAt: started });
    const doneP = adapter.ask(params.prompt || '').then((res) => {
      const task = res.ok
        ? { status: 'done', answer: res.answer, model: res.model, elapsedMs: res.elapsedMs }
        : { status: 'failed', error: res.error };
      this.tasks.set(taskId, { ...task, startedAt: started, finishedAt: Date.now() });
      this._post('/task-update', { type: 'task_update', taskId, task: this.tasks.get(taskId) }).catch(() => {});
      return task;
    });
    const timeoutMs = Math.min((params.timeout_s || 180) * 1000, 600000);
    const winner = await Promise.race([
      doneP.then((t) => ({ finished: true, task: t })),
      new Promise((r) => setTimeout(() => r({ finished: false }), timeoutMs)),
    ]);
    if (winner.finished) {
      if (winner.task.status === 'done') {
        return { answer: winner.task.answer, model: winner.task.model, elapsed_ms: winner.task.elapsedMs, task_id: taskId };
      }
      throw new Error('ask_gemini: ' + winner.task.error);
    }
    return { status: 'pending', task_id: taskId, note: 'answer still streaming — poll get_answer with this task_id' };
  }
}

// ---------- JSON-RPC client over a child process stdio ----------
class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.code + ': ' + msg.error.message));
          else resolve(msg.result);
        }
      }
    });
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('rpc timeout for ' + method));
        }
      }, 30000);
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

function spawnMcp() {
  const child = spawn('node', [join(ROOT, 'host', 'mcp-server.mjs')], {
    env: { ...process.env, YIXIUBRIDGE_BRIDGE_URL: bridgeUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stderr.on('data', () => { /* keep stderr quiet unless debugging */ });
  return new RpcClient(child);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'yixiubridge-test-'));
  bridge = await createBridgeServer({ port: 0, dataDir, repoRoot: ROOT });
  bridgeUrl = 'http://127.0.0.1:' + bridge.port;
  ext = new SimulatedExtension(bridgeUrl);
  await ext.connect();
  // Give the SSE subscription a moment to register.
  await new Promise((r) => setTimeout(r, 200));
});

after(async () => {
  for (const c of children) { try { c.kill(); } catch (e) { /* already gone */ } }
  children.clear();
  ext.disconnect();
  await bridge.close();
});

test('MCP initialize is rejected without a pairing window', async () => {
  const rpc = spawnMcp();
  await assert.rejects(
    rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'NoWindow', version: '1.0' } }),
    /not authorized/
  );
  rpc.child.kill();
});

test('pairing window authorizes the first client; tools/list exposes the 7 tools', async () => {
  const res = await fetch(bridgeUrl + '/pair/start', { method: 'POST' });
  assert.equal(res.status, 200);
  const rpc = spawnMcp();
  const init = await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  assert.equal(init.serverInfo.name, 'YixiuBridge');
  rpc.notify('notifications/initialized');
  const list = await rpc.call('tools/list', {});
  const names = list.tools.map((t) => t.name);
  for (const n of ['ping', 'tabs_context', 'navigate', 'read_page', 'list_models', 'ask_gemini', 'get_answer']) {
    assert.ok(names.includes(n), 'missing tool ' + n);
  }
  rpc.child.kill();
});

test('ping and tabs_context round-trip through bridge and simulated extension', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  const ping = await rpc.call('tools/call', { name: 'ping', arguments: {} });
  const pingText = JSON.parse(ping.content[0].text);
  assert.equal(pingText.ok, true);
  assert.equal(ping.isError, false);
  const tabs = await rpc.call('tools/call', { name: 'tabs_context', arguments: {} });
  const tabsText = JSON.parse(tabs.content[0].text);
  assert.equal(tabsText.tabs[0].url, 'https://gemini.google.com/app');
  rpc.child.kill();
});

test('/status reports the version on disk (disk_version, read fresh from package.json)', async () => {
  const res = await fetch(bridgeUrl + '/status');
  assert.equal(res.status, 200);
  const st = await res.json();
  assert.equal(st.ok, true);
  assert.equal(st.version, '0.3.1');
  assert.equal(st.disk_version, '0.3.1');
});

test('ask_gemini returns the mock answer end-to-end (bridge -> extension -> adapter -> mock page)', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  const out = await rpc.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'What is 2+2?', timeout_s: 30 } });
  assert.equal(out.isError, false);
  const res = JSON.parse(out.content[0].text);
  assert.equal(res.answer, '4 is the answer.');
  assert.equal(res.model, 'gemini-web');
  rpc.child.kill();
});

test('list_models round-trips through MCP and ask_gemini accepts a model param', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  const out = await rpc.call('tools/call', { name: 'list_models', arguments: {} });
  assert.equal(out.isError, false);
  const res = JSON.parse(out.content[0].text);
  assert.equal(res.current, 'Neon');
  assert.equal(res.models.length, 4);
  assert.equal(res.models.find((m) => m.codename === 'Carbon').locked, true);
  const ask = await rpc.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'What is 2+2?', model: 'Neon', timeout_s: 30 } });
  assert.equal(ask.isError, false);
  assert.equal(JSON.parse(ask.content[0].text).answer, '4 is the answer.');
  rpc.child.kill();
});

test('slow ask returns pending, then get_answer returns the finished answer', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  const out = await rpc.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'SLOW question', timeout_s: 1 } });
  const pending = JSON.parse(out.content[0].text);
  assert.equal(pending.status, 'pending');
  assert.ok(pending.task_id);
  let final = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const g = await rpc.call('tools/call', { name: 'get_answer', arguments: { task_id: pending.task_id } });
    const t = JSON.parse(g.content[0].text);
    if (t.status === 'done') { final = t; break; }
  }
  assert.ok(final, 'answer never finished');
  assert.equal(final.answer, 'slow answer.');
  rpc.child.kill();
});

test('get_answer with an unknown task id reports unknown', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  const g = await rpc.call('tools/call', { name: 'get_answer', arguments: { task_id: 'task_nope' } });
  const t = JSON.parse(g.content[0].text);
  assert.equal(t.status, 'unknown');
  rpc.child.kill();
});

test('second client is refused while a task is busy, but ping still works', async () => {
  // Open a fresh pairing window for the second client.
  await fetch(bridgeUrl + '/pair/start', { method: 'POST' });
  const rpc1 = spawnMcp();
  const rpc2 = spawnMcp();
  await rpc1.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  await rpc2.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'SecondClient', version: '1.0' } });

  const slowCall = rpc1.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'SLOW busy test', timeout_s: 30 } });
  // While the slow ask holds the lock, a browser tool from client 2 must fail.
  await new Promise((r) => setTimeout(r, 300));
  const busy = await rpc2.call('tools/call', { name: 'tabs_context', arguments: {} });
  assert.equal(busy.isError, true);
  assert.match(JSON.parse(busy.content[0].text).error, /busy/);
  // ping never takes the lock.
  const ping = await rpc2.call('tools/call', { name: 'ping', arguments: {} });
  assert.equal(ping.isError, false);

  const done = await slowCall;
  assert.equal(done.isError, false);
  assert.equal(JSON.parse(done.content[0].text).answer, 'slow answer.');
  rpc1.child.kill();
  rpc2.child.kill();
});

test('unknown tool is rejected with -32602', async () => {
  const rpc = spawnMcp();
  await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'TestClient', version: '1.0' } });
  await assert.rejects(
    rpc.call('tools/call', { name: 'nope', arguments: {} }),
    /-32602/
  );
  rpc.child.kill();
});
