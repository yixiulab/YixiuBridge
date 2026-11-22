// YixiuBridge — muse-runner tests (Node native runner).
// The real createGitHubClient + processOneTask + createBridgeCaller run
// against an in-memory fake GitHub API and a fake bridge. No network,
// no token, no real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTask,
  parseThinking,
  taskFilePaths,
  logFilePath,
  buildLogEntry,
  adapterVersionFromError,
  createGitHubClient,
  createBridgeCaller,
  processOneTask,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  loadConfig,
  saveConfig,
  createFileLogger,
  acquireLock,
  findExtensionProfile,
  createChromeOpener,
  EXTENSION_ID,
} from '../host/muse-runner.mjs';

// ---------- fake GitHub (in-memory repo) ----------
function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function makeFakeGitHub(initial = {}, { pending404 = false } = {}) {
  const files = new Map(Object.entries(initial)); // repo path -> { content, sha }
  let shaSeq = 1;
  const calls = [];
  async function fetchImpl(url, opts = {}) {
    const method = opts.method || 'GET';
    calls.push({ method, url });
    const u = new URL(url);
    if (u.origin !== 'https://api.github.com') return jsonResponse({ message: 'wrong host' }, 400);
    const m = u.pathname.match(/^\/repos\/yixiulab\/YixiuBridge\/contents\/(.+)$/);
    if (method === 'GET' && u.pathname === '/repos/yixiulab/YixiuBridge/contents/tasks/pending') {
      if (pending404) return jsonResponse({ message: 'Not Found' }, 404);
      const items = [];
      for (const [p, f] of files) {
        if (p.startsWith('tasks/pending/')) {
          items.push({ type: 'file', name: p.split('/').pop(), path: p, sha: f.sha });
        }
      }
      return jsonResponse(items);
    }
    if (!m) return jsonResponse({ message: 'not found' }, 404);
    const filePath = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const f = files.get(filePath);
      if (!f) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ sha: f.sha, content: Buffer.from(f.content, 'utf8').toString('base64') });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      // Store decoded; GET re-encodes, exactly like the real API.
      files.set(filePath, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'sha' + (shaSeq++) });
      return jsonResponse({ content: { sha: files.get(filePath).sha } }, 201);
    }
    if (method === 'DELETE') {
      files.delete(filePath);
      return jsonResponse({});
    }
    return jsonResponse({ message: 'bad method' }, 400);
  }
  return { fetchImpl, files, calls };
}

function taskJson(id, prompt, extra = {}) {
  return JSON.stringify({ id, prompt, created_by: 'muse', created_at: '2026-11-21T10:00:00.000Z', ...extra });
}

function makeFakeBridge({ answer = 'mock answer', failWith = null, failCode = null, failAdapterVersion = null, failBridgeTaskId = null, bridgeTaskId = null, statusUp = true, extensions = 1, version = '0.3.1', diskVersion = '0.3.1', adapterVersion = '0.3.1', thinkingWarning = null, appliedThinking = null, recover = undefined } = {}) {
  const calls = [];
  const bridge = {
    calls,
    async status() { calls.push({ op: 'status' }); return { up: statusUp, extensions, version, diskVersion }; },
    async ask(args) {
      calls.push({ op: 'ask', ...args });
      if (failWith) {
        const e = new Error(failWith);
        if (failCode) e.code = failCode;
        if (failAdapterVersion) e.adapterVersion = failAdapterVersion;
        if (failBridgeTaskId) e.bridgeTaskId = failBridgeTaskId;
        throw e;
      }
      return { answer, model: 'Neon', elapsedMs: 1234, adapterVersion, bridgeTaskId, thinkingWarning, appliedThinking };
    },
  };
  // recover: undefined = no recoverLastAnswer at all (old fake bridges);
  // a string = recovery returns that answer; null = recovery finds
  // nothing; { error } = recovery misses with a reason; an array =
  // one entry per call, in order (v0.4.14: the poll loop).
  if (recover !== undefined) {
    bridge.recoverLastAnswer = async (prompt) => {
      calls.push({ op: 'recover', prompt });
      const next = Array.isArray(recover) ? recover.shift() : recover;
      if (next === null || next === undefined) return null;
      if (typeof next === 'object' && next.error) return { error: next.error };
      return { answer: next, model: 'Neon', elapsedMs: 500, adapterVersion: '0.4.14', bridgeTaskId: null, recovered: true };
    };
  }
  return bridge;
}

function readRepo(files, path) {
  const f = files.get(path);
  return f ? JSON.parse(f.content) : null;
}

// ---------- pure helpers ----------

test('parseTask validates and normalises a task file', () => {
  const t = parseTask(taskJson('t1', 'hello', { model: 'Neon', timeout_ms: 60000 }));
  assert.equal(t.id, 't1');
  assert.equal(t.prompt, 'hello');
  assert.equal(t.model, 'Neon');
  assert.equal(t.timeout_ms, 60000);
  const t2 = parseTask(taskJson('t2', 'hello'));
  assert.equal(t2.model, null);
  assert.equal(t2.timeout_ms, null);
  assert.throws(() => parseTask('{bad json', 'x.json'), /parse error/);
  assert.throws(() => parseTask('{"prompt":"x"}', 'x.json'), /missing a safe string "id"/);
  assert.throws(() => parseTask('{"id":"../evil","prompt":"x"}', 'x.json'), /safe string "id"/);
  assert.throws(() => parseTask('{"id":"t","prompt":"  "}', 'x.json'), /non-empty "prompt"/);
});

test('taskFilePaths and logFilePath use the documented layout', () => {
  assert.deepEqual(taskFilePaths('abc'), {
    pending: 'tasks/pending/abc.json',
    done: 'tasks/done/abc.answer.json',
    failed: 'tasks/failed/abc.error.json',
  });
  assert.equal(logFilePath(new Date(2026, 10, 21)), 'tasks/log/2026-11-21.json');
});

test('buildLogEntry truncates long prompts and carries status + models', () => {
  const e = buildLogEntry({
    task: { id: 't1', prompt: 'x'.repeat(300) },
    status: 'done', elapsedMs: 6500, askedModel: 'Neon', answeredModel: 'Neon',
    adapterVersion: '0.3.1', bridgeVersion: '0.3.1',
  });
  assert.equal(e.id, 't1');
  assert.equal(e.status, 'done');
  assert.equal(e.prompt.length, 201);
  assert.equal(e.asked_model, 'Neon');
  assert.equal(e.elapsed_ms, 6500);
  assert.equal(e.error, null);
  assert.equal(e.adapter_version, '0.3.1');
  assert.equal(e.bridge_version, '0.3.1');
  assert.ok(e.at);
});

// ---------- processOneTask ----------

test('happy path: oldest task answered, done file written, pending deleted, log appended', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t-old.json': { content: taskJson('t-old', 'old question', { created_at: '2026-11-21T09:00:00.000Z' }), sha: 's1' },
    'tasks/pending/t-new.json': { content: taskJson('t-new', 'new question', { created_at: '2026-11-21T10:00:00.000Z' }), sha: 's2' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(res.id, 't-old', 'oldest first');
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 1);
  assert.equal(bridge.calls.find((c) => c.op === 'ask').prompt, 'old question');
  assert.equal(bridge.calls.find((c) => c.op === 'ask').model, DEFAULT_MODEL, 'no model in task -> Neon default');
  const done = readRepo(gh.files, 'tasks/done/t-old.answer.json');
  assert.equal(done.answer, 'mock answer');
  assert.equal(done.model, 'gemini-web');
  assert.equal(done.elapsed_ms, 1234);
  assert.equal(done.asked_model, 'Neon');
  assert.equal(done.answered_model, 'Neon');
  assert.ok(done.answered_at);
  assert.equal(done.adapter_version, '0.3.1', 'done file records the adapter version that answered');
  assert.equal(done.bridge_version, '0.3.1');
  assert.equal(res.adapterVersion, '0.3.1');
  assert.equal(res.bridgeVersion, '0.3.1');
  assert.equal(gh.files.has('tasks/pending/t-old.json'), false);
  assert.equal(gh.files.has('tasks/pending/t-new.json'), true, 'the newer task stays pending');
  const today = new Date();
  const logPath = 'tasks/log/' + today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.json';
  const log = readRepo(gh.files, logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 't-old');
  assert.equal(log[0].status, 'done');
  assert.equal(log[0].adapter_version, '0.3.1');
  assert.equal(log[0].bridge_version, '0.3.1');
});

test('task with an explicit model passes it through to the bridge', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q', { model: 'Hydrogen' }), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(bridge.calls.find((c) => c.op === 'ask').model, 'Hydrogen');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').asked_model, 'Hydrogen');
});

test('bridge failure writes a failed file, deletes pending, logs failed', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ failWith: 'gemini send did not register' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'gemini send did not register');
  const failed = readRepo(gh.files, 'tasks/failed/t1.error.json');
  assert.equal(failed.id, 't1');
  assert.match(failed.error, /did not register/);
  assert.ok(failed.failed_at);
  assert.equal(gh.files.has('tasks/pending/t1.json'), false);
  assert.equal(gh.files.has('tasks/done/t1.answer.json'), false);
});

test('malformed task JSON moves to failed with a parse error', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/broken.json': { content: '{not json', sha: 's1' },
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's2' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.id, 'broken', 'malformed file is cleared first');
  assert.match(res.error, /parse error/);
  assert.equal(gh.files.has('tasks/pending/broken.json'), false);
  assert.equal(readRepo(gh.files, 'tasks/failed/broken.error.json').error, res.error);
  assert.equal(gh.files.has('tasks/pending/t1.json'), true, 'the good task is untouched');
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 0);
});

test('bridge down leaves the task pending and changes nothing', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ statusUp: false });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'bridge-down');
  assert.equal(gh.files.has('tasks/pending/t1.json'), true);
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 0);
});

test('bridge up but no extension connected leaves the task pending', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ extensions: 0 });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'no-extension');
  assert.equal(gh.files.has('tasks/pending/t1.json'), true);
});

test('browser busy leaves the task pending for the next cycle', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ failWith: 'browser busy — a task is already running', failCode: 'busy' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'busy');
  assert.equal(gh.files.has('tasks/pending/t1.json'), true);
  assert.equal(gh.files.has('tasks/failed/t1.error.json'), false);
});

test('idempotency guard: a pending task whose done file already exists is NOT asked again (v0.3.3)', async () => {
  // The runner writes done FIRST, then deletes pending. If it is stopped
  // in between, the next poll sees the same pending task — without this
  // guard it would ask Gemini the same question a second time.
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
    'tasks/done/t1.answer.json': { content: JSON.stringify({ id: 't1', answer: 'already answered', model: 'gemini-web' }), sha: 's2' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'already-resolved');
  assert.equal(res.id, 't1');
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 0, 'the question must not be asked a second time');
  assert.equal(gh.files.has('tasks/pending/t1.json'), false, 'the leftover pending file is removed');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').answer, 'already answered', 'the existing answer file is untouched');
});

test('idempotency guard: a pending task whose failed file already exists is NOT asked again — even when the bridge is down', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
    'tasks/failed/t1.error.json': { content: JSON.stringify({ id: 't1', error: 'earlier failure' }), sha: 's2' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ statusUp: false });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'already-resolved', 'the guard runs before the bridge status check');
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 0);
  assert.equal(gh.files.has('tasks/pending/t1.json'), false);
  assert.equal(readRepo(gh.files, 'tasks/failed/t1.error.json').error, 'earlier failure', 'the existing failed file is untouched');
});

test('empty pending folder (GitHub 404) is a no-op', async () => {
  const gh = makeFakeGitHub({}, { pending404: true });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'empty');
});

test('quota log is read-modify-written: existing entries are kept', async () => {
  const today = new Date();
  const logPath = 'tasks/log/' + today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.json';
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
    [logPath]: { content: JSON.stringify([{ id: 'earlier', status: 'done' }]), sha: 'logsha' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  await processOneTask({ github, bridge, log: () => {} });
  const log = readRepo(gh.files, logPath);
  assert.equal(log.length, 2);
  assert.equal(log[0].id, 'earlier');
  assert.equal(log[1].id, 't1');
});

test('createGitHubClient refuses to run without a token', () => {
  assert.throws(() => createGitHubClient({ token: '' }), /github-token/);
  assert.throws(() => createGitHubClient({}), /github-token/);
});

test('createGitHubClient turns a rate limit into a backoff error', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429,
    headers: { get: (n) => (n === 'retry-after' ? '120' : null) },
    json: async () => ({}), text: async () => '',
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl });
  await assert.rejects(github.listPending(), (e) => {
    assert.match(e.message, /rate limit/);
    assert.equal(e.retryAfterMs, 120000);
    return true;
  });
});

// ---------- bridge caller: pending polling ----------

test('createBridgeCaller polls GET /tasks/:id when ask_gemini returns pending', async () => {
  let taskCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/status')) return jsonResponse({ ok: true, version: '0.3.1', disk_version: '0.3.1', extensions: [{ id: 'p1' }] });
    if (url.endsWith('/call')) {
      return jsonResponse({ ok: true, result: { status: 'pending', task_id: 'task_x' } });
    }
    if (url.includes('/tasks/task_x')) {
      taskCalls++;
      if (taskCalls < 2) return jsonResponse({ status: 'running' });
      return jsonResponse({ status: 'done', answer: 'slow answer', model: 'Neon', elapsedMs: 9000, adapterVersion: '0.3.1' });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  const st = await bridge.status();
  assert.deepEqual(st, { up: true, extensions: 1, version: '0.3.1', diskVersion: '0.3.1' });
  const res = await bridge.ask({ prompt: 'slow one', model: 'Neon', timeoutMs: 30000 });
  assert.equal(res.answer, 'slow answer');
  assert.equal(res.model, 'Neon');
  assert.equal(res.elapsedMs, 9000);
  assert.equal(res.adapterVersion, '0.3.1', 'polled task carries the adapter version that answered');
  assert.ok(taskCalls >= 2);
});

test('createBridgeCaller marks a busy bridge with code "busy"', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/call')) return jsonResponse({ ok: false, error: 'browser busy — a task is already running' });
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  await assert.rejects(bridge.ask({ prompt: 'q', model: 'Neon' }), (e) => {
    assert.equal(e.code, 'busy');
    return true;
  });
});

// ---------- long answers: poll after a bridge timeout (v0.3.4) ----------
// Background: task -007 (2026-11-21) — the runner wrote a failed file
// ("ask_gemini timed out after 240s") while the answer was sitting in the
// Gemini tab: Gemini had answered the pomodoro question, generation just
// took longer than the 240s cap. A bridge timeout that carries a task_id
// must be polled, not failed.

test('createBridgeCaller polls after a bridge timeout that carries a task_id and returns the late answer', async () => {
  let taskCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/call')) {
      // The bridge-side timeout shape (ok:false + task_id): the ask is
      // still running in the browser.
      return jsonResponse({ ok: false, error: 'ask_gemini timed out after 240s — the task may still be running in the browser; poll get_answer with this task_id.', task_id: 'task_late' });
    }
    if (url.includes('/tasks/task_late')) {
      taskCalls++;
      if (taskCalls < 2) return jsonResponse({ status: 'running' });
      return jsonResponse({ status: 'done', answer: 'late pomodoro code', model: 'Neon', elapsedMs: 260000, adapterVersion: '0.3.6' });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10, overallCapMs: 60000 });
  const res = await bridge.ask({ prompt: 'slow one', model: 'Neon', timeoutMs: 30000 });
  assert.equal(res.answer, 'late pomodoro code');
  assert.equal(res.bridgeTaskId, 'task_late', 'the late answer carries the bridge task id');
  assert.equal(res.adapterVersion, '0.3.6');
  assert.ok(taskCalls >= 2);
});

test('createBridgeCaller gives up only after the overall cap, and the error carries the bridge task_id', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/call')) {
      return jsonResponse({ ok: true, result: { status: 'pending', task_id: 'task_stuck' } });
    }
    if (url.includes('/tasks/task_stuck')) return jsonResponse({ status: 'running' });
    return jsonResponse({}, 404);
  };
  // Tiny overall cap for the test: 60ms of polling, then it must fail.
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10, overallCapMs: 60 });
  await assert.rejects(bridge.ask({ prompt: 'q', model: 'Neon', timeoutMs: 30000 }), (e) => {
    assert.match(e.message, /did not finish within/);
    assert.match(e.message, /task_stuck/);
    assert.equal(e.bridgeTaskId, 'task_stuck');
    return true;
  });
});

test('processOneTask failure records bridge_task_id in the failed file (v0.3.4)', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'ask_gemini task task_x did not finish within 900s — poll get_answer with task_id task_x for the result',
    failBridgeTaskId: 'task_x',
  });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.bridgeTaskId, 'task_x');
  const failed = readRepo(gh.files, 'tasks/failed/t1.error.json');
  assert.equal(failed.bridge_task_id, 'task_x', 'the failed file names the bridge task so the answer can still be retrieved');
  assert.equal(gh.files.has('tasks/pending/t1.json'), false);
  const today = new Date();
  const logPath = 'tasks/log/' + today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.json';
  assert.equal(readRepo(gh.files, logPath)[0].bridge_task_id, 'task_x');
});

test('processOneTask success records bridge_task_id in the done file (v0.3.4)', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ bridgeTaskId: 'task_y' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(res.bridgeTaskId, 'task_y');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').bridge_task_id, 'task_y');
});

// ---------- version self-check (v0.3.1) ----------
// Background: task -003 (2026-11-21) failed with the 0.2.0 send-button
// error while the panel showed 0.3.0 — the Gemini tab ran the old adapter
// and nothing in the runner log said so. The runner now logs the bridge
// version before every ask and the adapter version with the result, and
// flags a mismatch in plain language.

// ---------- abort + recovery (v0.4.13) ----------
// Background: teacher-testpc-002/003 (2026-11-22) — the runner's fetch
// to the bridge aborted at 5 minutes with the bare DOM error "This
// operation was aborted" and NO task_id, while Gemini had already
// answered in the tab. The answer was thrown away as a failed file.
// Two fixes: the fetch no longer aborts before the overall 15-minute
// cap, and an ask failure now reads the tab once (recover_last_answer)
// before any failed file is written.

test('createBridgeCaller does not abort the /call fetch before the overall cap', async () => {
  // The /call fetch only resolves when its signal aborts; the bridge
  // then answers pending and the task is already done. With the old
  // abort (min((timeoutS + 90)s, 300s) = 95s for timeoutMs 5000) this
  // test would hang ~95s; with the 0.4.13 abort (overallCapMs) it
  // finishes in ~2s.
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/call')) {
      await new Promise((resolve) => {
        if (opts.signal) opts.signal.addEventListener('abort', resolve);
        else setTimeout(resolve, 5000);
      });
      return jsonResponse({ ok: true, result: { status: 'pending', task_id: 'task_abort' } });
    }
    if (url.includes('/tasks/task_abort')) {
      return jsonResponse({ status: 'done', answer: 'late answer', model: 'Neon', elapsedMs: 2000, adapterVersion: '0.4.13' });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10, overallCapMs: 2000 });
  const res = await bridge.ask({ prompt: 'slow one', model: 'Neon', timeoutMs: 5000 });
  assert.equal(res.answer, 'late answer');
  assert.equal(res.bridgeTaskId, 'task_abort');
});

test('processOneTask recovers the answer after an aborted fetch instead of failing', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'This operation was aborted',
    recover: 'the answer that was already in the tab',
  });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(res.recovered, true);
  const done = readRepo(gh.files, 'tasks/done/t1.answer.json');
  assert.equal(done.answer, 'the answer that was already in the tab');
  assert.equal(done.recovered, true, 'the done file must say the answer was recovered, not freshly asked');
  assert.equal(gh.files.has('tasks/failed/t1.error.json'), false, 'no failed file may be written when recovery succeeds');
  assert.equal(gh.files.has('tasks/pending/t1.json'), false);
  assert.ok(bridge.calls.some((c) => c.op === 'recover' && c.prompt === 'q'), 'recovery must be attempted with the task prompt');
});

test('processOneTask recovers after send did not register', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'gemini send did not register — the prompt is still in the input box after click + Enter [adapter_version: 0.4.13]',
    failAdapterVersion: '0.4.13',
    recover: 'recovered answer',
  });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(res.recovered, true);
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').answer, 'recovered answer');
  assert.equal(gh.files.has('tasks/failed/t1.error.json'), false);
});

test('processOneTask writes failed only when recovery finds nothing', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'This operation was aborted',
    recover: null,
  });
  const res = await processOneTask({ github, bridge, log: () => {}, recoverBudgetMs: 30, recoverPollMs: 10 });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /aborted/);
  assert.equal(gh.files.has('tasks/done/t1.answer.json'), false);
  assert.ok(readRepo(gh.files, 'tasks/failed/t1.error.json'));
});

// ---------- recovery polling (v0.4.14) ----------
// Background: teacher-testpc-004 (2026-11-22 18:15) failed with "no
// response appeared" while Gemini was still thinking, and the single
// recovery read ran while the answer was still streaming — so it
// refused, the failed file was written, and the answer that arrived
// minutes later was never collected. Recovery now polls for up to 5
// minutes, and a miss records its reason in the failed file.

test('processOneTask polls recovery until the late answer appears', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'gemini no response appeared',
    recover: [null, { error: 'recover: answer still streaming' }, 'the late answer'],
  });
  const res = await processOneTask({ github, bridge, log: () => {}, recoverBudgetMs: 500, recoverPollMs: 10 });
  assert.equal(res.status, 'done');
  assert.equal(res.recovered, true);
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').answer, 'the late answer');
  assert.equal(gh.files.has('tasks/failed/t1.error.json'), false, 'no failed file may be written when a late recovery succeeds');
  assert.equal(bridge.calls.filter((c) => c.op === 'recover').length, 3, 'recovery must keep polling until the answer appears');
});

test('processOneTask failed file records the recovery reason', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({
    failWith: 'gemini no response appeared',
    recover: { error: 'recover: answer still streaming' },
  });
  const res = await processOneTask({ github, bridge, log: () => {}, recoverBudgetMs: 50, recoverPollMs: 10 });
  assert.equal(res.status, 'failed');
  const failed = readRepo(gh.files, 'tasks/failed/t1.error.json');
  assert.ok(failed, 'a failed file must be written');
  assert.match(failed.recover_error, /still streaming/, 'the failed file must say WHY recovery missed, not force a guess');
  assert.ok(failed.recover_attempts >= 1, 'the failed file must count the recovery attempts');
  assert.equal(res.recoverError, 'recover: answer still streaming');
});

test('adapterVersionFromError extracts the version tag, null when absent', () => {
  assert.equal(adapterVersionFromError('ask_gemini: gemini send button not found [adapter_version: 0.2.0]'), '0.2.0');
  assert.equal(adapterVersionFromError('ask_gemini: something failed [adapter_version: 0.3.1-test]'), '0.3.1-test');
  assert.equal(adapterVersionFromError('plain error, no version'), null);
  assert.equal(adapterVersionFromError(''), null);
  assert.equal(adapterVersionFromError(null), null);
});

test('createBridgeCaller ask returns adapter_version on the direct path', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/call')) {
      return jsonResponse({ ok: true, result: { answer: 'direct answer', model: 'Neon', elapsed_ms: 100, adapter_version: '0.3.1' } });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  const res = await bridge.ask({ prompt: 'q', model: 'Neon', timeoutMs: 30000 });
  assert.equal(res.answer, 'direct answer');
  assert.equal(res.adapterVersion, '0.3.1');
});

test('createBridgeCaller ask error carries adapterVersion from the version tag', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/call')) {
      return jsonResponse({ ok: false, error: 'ask_gemini: gemini send button not found [adapter_version: 0.2.0]' });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  await assert.rejects(bridge.ask({ prompt: 'q', model: 'Neon' }), (e) => {
    assert.match(e.message, /send button not found/);
    assert.equal(e.adapterVersion, '0.2.0');
    return true;
  });
});

test('processOneTask logs the bridge version line before asking', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ version: '0.3.1', diskVersion: '0.3.1' });
  const lines = [];
  const res = await processOneTask({ github, bridge, log: (m) => lines.push(m) });
  assert.equal(res.status, 'done');
  assert.ok(lines.some((l) => /bridge v0\.3\.1 \(disk v0\.3\.1\), 1 extension connected — asking task t1/.test(l)),
    'expected a bridge version line, got: ' + JSON.stringify(lines));
  assert.equal(lines.some((l) => /版本不一致/.test(l)), false, 'no mismatch warning when versions agree');
});

test('processOneTask flags a bridge/adapter version mismatch in the log', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  // Bridge runs 0.3.1 but the tab answered with the 0.2.0 adapter: the
  // -003 situation. The log must say so in plain language.
  const bridge = makeFakeBridge({ version: '0.3.1', diskVersion: '0.3.1', adapterVersion: '0.2.0' });
  const lines = [];
  const res = await processOneTask({ github, bridge, log: (m) => lines.push(m) });
  assert.equal(res.status, 'done');
  assert.equal(res.adapterVersion, '0.2.0');
  assert.ok(lines.some((l) => /版本不一致: bridge v0\.3\.1，但 Gemini 适配器 v0\.2\.0/.test(l)),
    'expected a mismatch warning, got: ' + JSON.stringify(lines));
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').adapter_version, '0.2.0');
});

test('processOneTask failure records adapter_version in the failed file (error property)', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ failWith: 'gemini send did not register', failAdapterVersion: '0.2.0' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.adapterVersion, '0.2.0');
  const failed = readRepo(gh.files, 'tasks/failed/t1.error.json');
  assert.equal(failed.adapter_version, '0.2.0');
  assert.equal(failed.bridge_version, '0.3.1');
});

test('processOneTask failure records adapter_version from the error-string tag', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  // The router embeds the tag in the error string (plain-text bridge
  // channel); the runner must recover it even without the property.
  const bridge = makeFakeBridge({ failWith: 'ask_gemini: gemini send button not found [adapter_version: 0.2.0]' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.adapterVersion, '0.2.0');
  assert.equal(readRepo(gh.files, 'tasks/failed/t1.error.json').adapter_version, '0.2.0');
});

// ---------- stale lock, file log, BOM-tolerant config (v0.3.4) ----------
// Background: task -008 sat unpicked for 8+ minutes because the runner
// had died and its lock file was never reclaimed; the runner starts
// minimized, so there was no window and no log to look at. And the
// 17:17 updater run clobbered config.json (github_token lost), so the
// restarted runner failed immediately with "no github_token".

test('loadConfig tolerates a leading BOM (v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-config-'));
  // Windows PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM; Node's
  // JSON.parse chokes on it, so the runner used to fail to start with
  // "no github_token" although the token was still in the file.
  await writeFile(join(dir, 'config.json'), '\uFEFF' + JSON.stringify({ github_token: 'tok123' }), 'utf8');
  const cfg = await loadConfig(dir);
  assert.equal(cfg.github_token, 'tok123');
});

test('saveConfig merges instead of clobbering and leaves no temp file (v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-config-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ github_token: 'tok123', runner_interval_s: 30 }), 'utf8');
  const cfg = await saveConfig(dir, { last_chrome_profile: 'Profile 21' });
  assert.equal(cfg.github_token, 'tok123', 'the saved token must survive a merge');
  assert.equal(cfg.runner_interval_s, 30);
  assert.equal(cfg.last_chrome_profile, 'Profile 21');
  const back = await loadConfig(dir);
  assert.equal(back.github_token, 'tok123');
  assert.equal(back.last_chrome_profile, 'Profile 21');
  await assert.rejects(readFile(join(dir, 'config.json.tmp'), 'utf8'), 'no temp file may be left behind');
});

test('createFileLogger appends lines and rotates a log over 1 MiB (v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-log-'));
  const logger = await createFileLogger(dir);
  await logger.log('[2026-11-21T00:00:00.000Z] hello');
  assert.match(await readFile(logger.path, 'utf8'), /hello/);
  await writeFile(logger.path, 'x'.repeat(1024 * 1024 + 1), 'utf8');
  const logger2 = await createFileLogger(dir);
  assert.equal(logger2.path, logger.path);
  const rotated = await readFile(logger.path + '.1', 'utf8');
  assert.equal(rotated.length, 1024 * 1024 + 1, 'the oversized log moves to .log.1');
  await logger2.log('fresh line');
  assert.match(await readFile(logger.path, 'utf8'), /fresh line/);
});

test('acquireLock takes over a lock whose PID is dead, and the runner then processes a task (v0.3.4, -008)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-lock-'));
  // A lock left behind by a dead runner: PID 99999999 can never be alive.
  await writeFile(join(dir, 'muse-runner.lock'), '99999999\n');
  const lines = [];
  const lockPath = await acquireLock(dir, (m) => lines.push(m));
  assert.ok(lockPath.endsWith('muse-runner.lock'));
  assert.equal((await readFile(lockPath, 'utf8')).trim(), String(process.pid), 'the lock now belongs to this process');
  assert.ok(lines.some((l) => /stale lock: pid 99999999 is dead/.test(l)));
  // With the lock reclaimed, task processing works.
  const gh = makeFakeGitHub({ 'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' } });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const res = await processOneTask({ github, bridge: makeFakeBridge(), log: () => {} });
  assert.equal(res.status, 'done');
  await unlink(lockPath);
});

test('acquireLock refuses when the lock PID is alive with a fresh heartbeat (v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-lock-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  try {
    await writeFile(join(dir, 'muse-runner.lock'), String(child.pid) + '\n');
    await writeFile(join(dir, 'muse-runner.heartbeat'), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }));
    await assert.rejects(acquireLock(dir, () => {}), /already running/);
    assert.equal((await readFile(join(dir, 'muse-runner.lock'), 'utf8')).trim(), String(child.pid), 'the live lock is untouched');
  } finally {
    child.kill();
  }
});

test('acquireLock takes over when the lock PID is alive but its heartbeat is stale (v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-lock-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  try {
    await writeFile(join(dir, 'muse-runner.lock'), String(child.pid) + '\n');
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeFile(join(dir, 'muse-runner.heartbeat'), JSON.stringify({ pid: child.pid, at: staleAt }));
    const lines = [];
    const lockPath = await acquireLock(dir, (m) => lines.push(m));
    assert.equal((await readFile(lockPath, 'utf8')).trim(), String(process.pid), 'the lock now belongs to this process');
    assert.ok(lines.some((l) => /stale lock/.test(l) && /heartbeat is stale/.test(l)));
    await unlink(lockPath);
  } finally {
    child.kill();
  }
});

test('acquireLock takes over when the lock PID is alive but there is no heartbeat file (pre-0.3.4 runner, v0.3.4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-lock-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  try {
    await writeFile(join(dir, 'muse-runner.lock'), String(child.pid) + '\n');
    const lines = [];
    const lockPath = await acquireLock(dir, (m) => lines.push(m));
    assert.equal((await readFile(lockPath, 'utf8')).trim(), String(process.pid));
    assert.ok(lines.some((l) => /stale lock/.test(l) && /heartbeat is missing/.test(l)));
    await unlink(lockPath);
  } finally {
    child.kill();
  }
});

// ---------- auto-open Chrome when no extension is connected (v0.3.7) ----------
// Background: 2026-11-21, the 0.3.6 update — the runner logged "bridge is
// up but no Chrome extension is connected" once a minute for 12 minutes
// (19:11–19:23) and did nothing; the loop only closed when the user opened
// Profile 21's Chrome by hand. The runner now opens Chrome itself when a
// task is waiting and no extension is connected.

async function makeUserData(profiles) {
  // profiles: { 'Profile 21': { secure: <object|null>, prefs: <object|null> } }
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-userdata-'));
  for (const [name, files] of Object.entries(profiles)) {
    await mkdir(join(dir, name), { recursive: true });
    if (files.secure !== undefined && files.secure !== null) {
      await writeFile(join(dir, name, 'Secure Preferences'), JSON.stringify(files.secure), 'utf8');
    }
    if (files.prefs !== undefined && files.prefs !== null) {
      await writeFile(join(dir, name, 'Preferences'), JSON.stringify(files.prefs), 'utf8');
    }
  }
  return dir;
}

function securePrefsWithExtension(path) {
  return {
    extensions: { settings: { [EXTENSION_ID]: { location: 4, path } } },
    protection: { macs: { extensions: { settings: { [EXTENSION_ID]: 'hash' } } } },
  };
}

function securePrefsStaleMacsOnly() {
  // The ID appears only as a protection-MAC key: Chrome kept the integrity
  // hash after the install record was removed. Substring search matches
  // this profile; a settings-key check must not.
  return {
    extensions: { settings: {} },
    protection: { macs: { extensions: { settings: { [EXTENSION_ID]: 'hash' } } } },
  };
}

test('findExtensionProfile picks confirmed Profile 21 over unconfirmed Profile 18, even when 18 is newer', async () => {
  const dir = await makeUserData({
    'Profile 21': { secure: securePrefsWithExtension('C:\\software\\myself\\YixiuBridge-main\\extension') },
    'Profile 18': { secure: securePrefsStaleMacsOnly() },
    'Profile 2': { secure: { extensions: { settings: {} } } },
  });
  // Make Profile 18 the most recently modified profile: recency alone
  // would pick it (that is how 0.3.4 mis-picked it on the real machine).
  const now = new Date();
  await utimes(join(dir, 'Profile 18', 'Secure Preferences'), now, now);
  await utimes(join(dir, 'Profile 21', 'Secure Preferences'), new Date(now.getTime() - 3600000), new Date(now.getTime() - 3600000));
  const found = await findExtensionProfile(dir);
  assert.equal(found.profileDir, 'Profile 21');
  assert.equal(found.confirmed, true);
  assert.equal(found.loadedPath, 'C:\\software\\myself\\YixiuBridge-main\\extension');
  // A cached unconfirmed profile must not win over a confirmed one.
  const cached = await findExtensionProfile(dir, { preferredProfileDir: 'Profile 18' });
  assert.equal(cached.profileDir, 'Profile 21', 'an unconfirmed cached profile never beats a confirmed match');
});

test('findExtensionProfile returns an unconfirmed match when nothing is confirmed, and null when nothing matches', async () => {
  const onlyStale = await makeUserData({ 'Profile 18': { secure: securePrefsStaleMacsOnly() } });
  const stale = await findExtensionProfile(onlyStale);
  assert.equal(stale.profileDir, 'Profile 18');
  assert.equal(stale.confirmed, false);
  const empty = await makeUserData({ 'Profile 2': { secure: { extensions: { settings: {} } } } });
  assert.equal(await findExtensionProfile(empty), null);
  const missing = join(tmpdir(), 'yixiubridge-does-not-exist-' + Date.now());
  assert.equal(await findExtensionProfile(missing), null);
});

test('createChromeOpener opens Chrome with the right profile, throttles, and caps attempts per task', async () => {
  const spawns = [];
  const fakeSpawn = (exe, args, opts) => {
    spawns.push({ exe, args, opts });
    return { unref() {} };
  };
  let nowMs = 1000000;
  const opener = createChromeOpener({
    dataDir: await mkdtemp(join(tmpdir(), 'yixiubridge-opener-')),
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\at\\AppData\\Local' },
    spawnImpl: fakeSpawn,
    findProfileFn: async () => ({ profileDir: 'Profile 21', confirmed: true }),
    findExeFn: async () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    now: () => nowMs,
  });
  const logs = [];
  const log = (m) => logs.push(m);
  const first = await opener.ensureConnected({ taskId: 't1', log });
  assert.equal(first.opened, true);
  assert.equal(first.profileDir, 'Profile 21');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].exe, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.deepEqual(spawns[0].args, ['--profile-directory=Profile 21', 'https://gemini.google.com']);
  assert.equal(spawns[0].opts.detached, true);
  assert.ok(logs.some((l) => /正在帮你打开 Chrome（Profile 21）/.test(l)));
  // Second call right away: throttled, no second window.
  const throttled = await opener.ensureConnected({ taskId: 't1', log });
  assert.equal(throttled.opened, false);
  assert.equal(throttled.reason, 'throttled');
  assert.equal(spawns.length, 1);
  // After the 3-minute interval: second and third attempts open again.
  nowMs += 181000;
  assert.equal((await opener.ensureConnected({ taskId: 't1', log })).opened, true);
  nowMs += 181000;
  assert.equal((await opener.ensureConnected({ taskId: 't1', log })).opened, true);
  assert.equal(spawns.length, 3);
  // Fourth attempt for the same task: capped, no more windows.
  nowMs += 181000;
  const capped = await opener.ensureConnected({ taskId: 't1', log });
  assert.equal(capped.opened, false);
  assert.equal(capped.reason, 'max-attempts');
  assert.equal(spawns.length, 3);
  // A different task gets its own attempts.
  const other = await opener.ensureConnected({ taskId: 't2', log });
  assert.equal(other.opened, true);
  assert.equal(spawns.length, 4);
});

test('createChromeOpener does nothing off Windows, and reports a missing profile or chrome.exe instead of spawning', async () => {
  const spawns = [];
  const fakeSpawn = (exe, args, opts) => { spawns.push({ exe, args }); return { unref() {} }; };
  const base = {
    dataDir: await mkdtemp(join(tmpdir(), 'yixiubridge-opener-')),
    env: { LOCALAPPDATA: 'C:\\Users\\at\\AppData\\Local' },
    spawnImpl: fakeSpawn,
    findProfileFn: async () => ({ profileDir: 'Profile 21', confirmed: true }),
    findExeFn: async () => 'C:\\chrome.exe',
    now: () => 1000000,
  };
  const linux = createChromeOpener({ ...base, platform: 'linux' });
  assert.deepEqual(await linux.ensureConnected({ taskId: 't1', log: () => {} }), { opened: false, reason: 'not-windows' });
  assert.equal(spawns.length, 0);
  const noProfile = createChromeOpener({ ...base, platform: 'win32', findProfileFn: async () => null });
  const r1 = await noProfile.ensureConnected({ taskId: 't1', log: () => {} });
  assert.equal(r1.opened, false);
  assert.equal(r1.reason, 'no-profile');
  assert.equal(spawns.length, 0);
  const noExe = createChromeOpener({ ...base, platform: 'win32', findExeFn: async () => null });
  const r2 = await noExe.ensureConnected({ taskId: 't1', log: () => {} });
  assert.equal(r2.opened, false);
  assert.equal(r2.reason, 'no-chrome-exe');
  assert.equal(spawns.length, 0);
});

test('processOneTask calls the chrome opener when no extension is connected, and never when the bridge is down', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const openedFor = [];
  const opener = {
    async ensureConnected({ taskId }) {
      openedFor.push(taskId);
      return { opened: true, profileDir: 'Profile 21' };
    },
  };
  const bridge = makeFakeBridge({ extensions: 0 });
  const res = await processOneTask({ github, bridge, log: () => {}, chromeOpener: opener });
  assert.equal(res.status, 'no-extension');
  assert.equal(res.chromeOpened, true);
  assert.equal(res.chromeProfile, 'Profile 21');
  assert.deepEqual(openedFor, ['t1'], 'the opener runs once for the waiting task');
  assert.equal(gh.files.has('tasks/pending/t1.json'), true, 'the task stays pending until the plugin reconnects');
  assert.equal(bridge.calls.filter((c) => c.op === 'ask').length, 0);
  // Bridge down: the opener must not run (nothing to connect to).
  const bridgeDown = makeFakeBridge({ statusUp: false });
  const res2 = await processOneTask({ github, bridge: bridgeDown, log: () => {}, chromeOpener: opener });
  assert.equal(res2.status, 'bridge-down');
  assert.deepEqual(openedFor, ['t1'], 'no Chrome window when the bridge itself is down');
});

// ---------- thinking level default (v0.4.1) ----------
// User's standing preference (2026-11-21): Gemini's 思考等级 prefers 高.
// The bridge + adapter already accepted a `thinking` param (tools.js,
// gemini-web.js selectThinkingLevel); the runner never sent one, so this
// wires it through with 高 as the default.

test('parseThinking accepts 高/中/低 and English aliases, rejects the rest', () => {
  assert.equal(parseThinking('高'), '高');
  assert.equal(parseThinking('中'), '中');
  assert.equal(parseThinking('低'), '低');
  assert.equal(parseThinking('high'), '高');
  assert.equal(parseThinking('Medium'), '中');
  assert.equal(parseThinking('LOW'), '低');
  assert.equal(parseThinking('  高  '), '高');
  assert.equal(parseThinking(null), null);
  assert.equal(parseThinking(undefined), null);
  assert.equal(parseThinking(''), null);
  assert.throws(() => parseThinking('超高'), /thinking must be 高\/中\/低/);
  assert.throws(() => parseThinking(123), /thinking must be a string/);
  assert.equal(parseTask(taskJson('t9', 'q', { thinking: '中' })).thinking, '中');
  assert.equal(parseTask(taskJson('t9', 'q')).thinking, null);
  assert.equal(DEFAULT_THINKING, '高');
});

test('task without thinking asks with 高 and records it in the done file + log', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(bridge.calls.find((c) => c.op === 'ask').thinking, '高', 'no thinking in task -> 高 default');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').asked_thinking, '高');
  const today = new Date();
  const logPath = 'tasks/log/' + today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.json';
  assert.equal(readRepo(gh.files, logPath)[0].asked_thinking, '高');
  assert.equal(res.askedThinking, '高');
});

test('task with an explicit thinking level passes it through', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q', { thinking: '低' }), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge();
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(bridge.calls.find((c) => c.op === 'ask').thinking, '低');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').asked_thinking, '低');
});

test('a thinking warning from the bridge lands in the done file (v0.4.2)', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ thinkingWarning: 'gemini thinking level did not stick — picker still shows "Neon"' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.match(readRepo(gh.files, 'tasks/done/t1.answer.json').thinking_warning, /did not stick/);
});

test('the actually applied thinking level lands in the done file (v0.4.4)', async () => {
  const gh = makeFakeGitHub({
    'tasks/pending/t1.json': { content: taskJson('t1', 'q'), sha: 's1' },
  });
  const github = createGitHubClient({ token: 'fake-token-for-tests', fetchImpl: gh.fetchImpl });
  const bridge = makeFakeBridge({ appliedThinking: '高' });
  const res = await processOneTask({ github, bridge, log: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(readRepo(gh.files, 'tasks/done/t1.answer.json').applied_thinking, '高');
});

test('createBridgeCaller.ask sends thinking in the /call body', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/call')) {
      sentBody = JSON.parse(opts.body);
      return jsonResponse({ ok: true, result: { answer: 'a', model: 'Neon', elapsed_ms: 10, adapter_version: '0.3.1' } });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  await bridge.ask({ prompt: 'q', model: 'Neon', thinking: '高', timeoutMs: 30000 });
  assert.equal(sentBody.tool, 'ask_gemini');
  assert.equal(sentBody.params.thinking, '高');
  assert.equal(sentBody.params.model, 'Neon');
});
