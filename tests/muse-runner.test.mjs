// YixiuBridge — muse-runner tests (Node native runner).
// The real createGitHubClient + processOneTask + createBridgeCaller run
// against an in-memory fake GitHub API and a fake bridge. No network,
// no token, no real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTask,
  taskFilePaths,
  logFilePath,
  buildLogEntry,
  adapterVersionFromError,
  createGitHubClient,
  createBridgeCaller,
  processOneTask,
  DEFAULT_MODEL,
  loadConfig,
  saveConfig,
  createFileLogger,
  acquireLock,
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

function makeFakeBridge({ answer = 'mock answer', failWith = null, failCode = null, failAdapterVersion = null, failBridgeTaskId = null, bridgeTaskId = null, statusUp = true, extensions = 1, version = '0.3.1', diskVersion = '0.3.1', adapterVersion = '0.3.1' } = {}) {
  const calls = [];
  return {
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
      return { answer, model: 'Neon', elapsedMs: 1234, adapterVersion, bridgeTaskId };
    },
  };
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
      return jsonResponse({ status: 'done', answer: 'late pomodoro code', model: 'Neon', elapsedMs: 260000, adapterVersion: '0.3.5' });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10, overallCapMs: 60000 });
  const res = await bridge.ask({ prompt: 'slow one', model: 'Neon', timeoutMs: 30000 });
  assert.equal(res.answer, 'late pomodoro code');
  assert.equal(res.bridgeTaskId, 'task_late', 'the late answer carries the bridge task id');
  assert.equal(res.adapterVersion, '0.3.5');
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
