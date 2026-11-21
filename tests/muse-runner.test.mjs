// YixiuBridge — muse-runner tests (Node native runner).
// The real createGitHubClient + processOneTask + createBridgeCaller run
// against an in-memory fake GitHub API and a fake bridge. No network,
// no token, no real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTask,
  taskFilePaths,
  logFilePath,
  buildLogEntry,
  createGitHubClient,
  createBridgeCaller,
  processOneTask,
  DEFAULT_MODEL,
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

function makeFakeBridge({ answer = 'mock answer', failWith = null, failCode = null, statusUp = true, extensions = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async status() { calls.push({ op: 'status' }); return { up: statusUp, extensions }; },
    async ask(args) {
      calls.push({ op: 'ask', ...args });
      if (failWith) {
        const e = new Error(failWith);
        if (failCode) e.code = failCode;
        throw e;
      }
      return { answer, model: 'Neon', elapsedMs: 1234 };
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
  });
  assert.equal(e.id, 't1');
  assert.equal(e.status, 'done');
  assert.equal(e.prompt.length, 201);
  assert.equal(e.asked_model, 'Neon');
  assert.equal(e.elapsed_ms, 6500);
  assert.equal(e.error, null);
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
  assert.equal(gh.files.has('tasks/pending/t-old.json'), false);
  assert.equal(gh.files.has('tasks/pending/t-new.json'), true, 'the newer task stays pending');
  const today = new Date();
  const logPath = 'tasks/log/' + today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.json';
  const log = readRepo(gh.files, logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 't-old');
  assert.equal(log[0].status, 'done');
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
    if (url.endsWith('/status')) return jsonResponse({ ok: true, extensions: [{ id: 'p1' }] });
    if (url.endsWith('/call')) {
      return jsonResponse({ ok: true, result: { status: 'pending', task_id: 'task_x' } });
    }
    if (url.includes('/tasks/task_x')) {
      taskCalls++;
      if (taskCalls < 2) return jsonResponse({ status: 'running' });
      return jsonResponse({ status: 'done', answer: 'slow answer', model: 'Neon', elapsedMs: 9000 });
    }
    return jsonResponse({}, 404);
  };
  const bridge = createBridgeCaller({ bridgeUrl: 'http://127.0.0.1:8765', fetchImpl, pollMs: 10 });
  const st = await bridge.status();
  assert.deepEqual(st, { up: true, extensions: 1 });
  const res = await bridge.ask({ prompt: 'slow one', model: 'Neon', timeoutMs: 30000 });
  assert.equal(res.answer, 'slow answer');
  assert.equal(res.model, 'Neon');
  assert.equal(res.elapsedMs, 9000);
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
