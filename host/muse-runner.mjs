// YixiuBridge — muse-runner (Muse's hands on the user's PC).
// Polls the private GitHub repo yixiulab/YixiuBridge for task files in
// tasks/pending/*.json, asks the local bridge (ask_gemini) for each one,
// and writes the answer back to tasks/done/<id>.answer.json (or an error
// file to tasks/failed/ on failure). One task per cycle, oldest first.
// Appends one entry per task to the daily quota log
// tasks/log/YYYY-MM-DD.json.
//
// Version self-check (v0.3.1): before every ask it logs the bridge
// version (bridge /status) and after the ask the adapter version that
// answered; a mismatch is flagged in the log in plain language, and both
// versions are stored in the done/failed file and the quota log.
//
// The GitHub token is read ONLY from ~/.yixiubridge/config.json field
// `github_token` (set once with `node bin/yixiubridge.mjs github-token`).
// It is never printed, never written to the repo, and is sent only to
// api.github.com. The bridge stays 127.0.0.1-only; the runner is a trusted
// local client (clientId "muse-runner/<version>") started explicitly by the
// user — it does not go through the MCP pairing window, because it is not
// an MCP client at all.
//
// Structure for testability: pure helpers + processOneTask with injected
// github/bridge clients. The polling loop only runs when this file is
// executed directly (or via runRunner from the CLI).
//
// Run: node bin/yixiubridge.mjs runner [--interval <seconds>]
//      node host/muse-runner.mjs [--interval <seconds>]
// Needs: bridge running, extension loaded, github_token saved.
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import C from '../kernel/shared/constants.js';

export const REPO = 'yixiulab/YixiuBridge';
export const GITHUB_API = 'https://api.github.com';
export const DEFAULT_MODEL = 'Neon'; // recommended high model (highest unlocked item)
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_DATA_DIR = join(homedir(), '.yixiubridge');
export const RUNNER_CLIENT_ID = 'muse-runner/' + C.EXTENSION_VERSION;

// A single ask_gemini call through the bridge is capped at 300s server-side
// (timeout_s + 60, max 300). The runner caps its own requests at 240s so
// the bridge never fires first; longer answers come back via the bridge's
// task store (GET /tasks/:id), which the runner polls.
const MAX_ASK_TIMEOUT_S = 240;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function logLine(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ---------- config (shared with the CLI) ----------

export async function loadConfig(dataDir = DEFAULT_DATA_DIR) {
  try {
    const raw = await readFile(join(dataDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  } catch (e) {
    return {};
  }
}

// Merge `patch` into the existing config file (other fields preserved) and
// save it with 0600 permissions (POSIX; best effort on Windows).
export async function saveConfig(dataDir, patch) {
  await mkdir(dataDir, { recursive: true });
  const cfg = { ...(await loadConfig(dataDir)), ...patch };
  const path = join(dataDir, 'config.json');
  await writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { await chmod(path, 0o600); } catch (e) { /* Windows: best effort */ }
  return cfg;
}

// ---------- task files (pure) ----------

// Validate + normalise a task file's JSON. Throws a clear error on bad input.
export function parseTask(raw, sourceName) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('task JSON parse error in ' + (sourceName || 'task') + ': ' + e.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('task is not a JSON object (' + (sourceName || 'task') + ')');
  }
  if (!data.id || typeof data.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(data.id)) {
    throw new Error('task is missing a safe string "id" (letters, digits, -, _) in ' + (sourceName || 'task'));
  }
  if (!data.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
    throw new Error('task ' + data.id + ' is missing a non-empty "prompt"');
  }
  return {
    id: data.id,
    prompt: data.prompt,
    model: (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : null,
    timeout_ms: Number.isFinite(data.timeout_ms) ? data.timeout_ms : null,
    created_by: data.created_by || 'muse',
    created_at: data.created_at || null,
  };
}

export function taskFilePaths(id) {
  return {
    pending: 'tasks/pending/' + id + '.json',
    done: 'tasks/done/' + id + '.answer.json',
    failed: 'tasks/failed/' + id + '.error.json',
  };
}

export function logFilePath(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return 'tasks/log/' + y + '-' + m + '-' + day + '.json';
}

export function buildLogEntry({ task, status, elapsedMs = null, error = null, askedModel = null, answeredModel = null, adapterVersion = null, bridgeVersion = null }) {
  return {
    id: task.id,
    status, // 'done' | 'failed'
    prompt: task.prompt.length > 200 ? task.prompt.slice(0, 200) + '…' : task.prompt,
    asked_model: askedModel,
    answered_model: answeredModel,
    adapter_version: adapterVersion,
    bridge_version: bridgeVersion,
    elapsed_ms: elapsedMs,
    error: error || null,
    at: new Date().toISOString(),
  };
}

// The adapter version travels inside error strings as "[adapter_version:
// 0.3.1]" (the bridge error channel is plain text — see router
// _askGemini). Pull it back out for the failed file and the log, so a
// stale-adapter failure is diagnosed without guessing. Returns null when
// the error carries no version tag.
export function adapterVersionFromError(msg) {
  const m = /\[adapter_version:\s*([0-9A-Za-z.+-]+)\]/.exec(String(msg || ''));
  return m ? m[1] : null;
}

// Warn loudly when the adapter that answered is not the version the bridge
// is running: the Gemini tab is stale (opened before an extension update).
// Both null/unknown = nothing to compare — stay silent.
function logVersionMismatch(log, bridgeVersion, adapterVersion) {
  if (!bridgeVersion || !adapterVersion || bridgeVersion === adapterVersion) return;
  log('⚠ 版本不一致: bridge v' + bridgeVersion + '，但 Gemini 适配器 v' + adapterVersion
    + ' — 标签页里的适配器是旧的。请双击 一键启动.bat 更新（或关闭 Gemini 标签页重开一个）后再试。');
}

// ---------- GitHub API client (token only from local config) ----------

export function createGitHubClient({ token, fetchImpl = fetch, repo = REPO } = {}) {
  if (!token) {
    throw new Error('github_token is missing — run: node bin/yixiubridge.mjs github-token');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'YixiuBridge-muse-runner/' + C.EXTENSION_VERSION,
  };

  async function api(method, path, body) {
    const res = await fetchImpl(GITHUB_API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      const e = new Error('GitHub 404: ' + path);
      e.status = 404;
      throw e;
    }
    if (res.status === 403 || res.status === 429) {
      let waitMs = 60000;
      const retryAfter = res.headers && res.headers.get && res.headers.get('retry-after');
      const reset = res.headers && res.headers.get && res.headers.get('x-ratelimit-reset');
      if (retryAfter) waitMs = parseInt(retryAfter, 10) * 1000;
      else if (reset) waitMs = Math.max(0, parseInt(reset, 10) * 1000 - Date.now());
      const e = new Error('GitHub rate limit (HTTP ' + res.status + ') — backing off ' + Math.round(waitMs / 1000) + 's');
      e.status = res.status;
      e.retryAfterMs = waitMs;
      throw e;
    }
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('GitHub API ' + method + ' ' + path + ' failed: HTTP ' + res.status + ' ' + String(text).slice(0, 200));
    }
    return res.json();
  }

  return {
    // [] when the folder does not exist yet (GitHub 404 = no tasks).
    async listPending() {
      try {
        const items = await api('GET', '/repos/' + repo + '/contents/tasks/pending');
        return (Array.isArray(items) ? items : [])
          .filter((i) => i.type === 'file' && i.name.endsWith('.json'))
          .map((i) => ({ name: i.name, path: i.path, sha: i.sha }));
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
    },
    async getFile(path) {
      const f = await api('GET', '/repos/' + repo + '/contents/' + path);
      return { sha: f.sha, content: Buffer.from(f.content || '', 'base64').toString('utf8') };
    },
    // True when the file exists (404 = false; any other failure throws).
    // Used by the idempotency guard in processOneTask.
    async exists(path) {
      try {
        await api('GET', '/repos/' + repo + '/contents/' + path);
        return true;
      } catch (e) {
        if (e.status === 404) return false;
        throw e;
      }
    },
    async putFile(path, content, message, sha) {
      const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main' };
      if (sha) body.sha = sha;
      return api('PUT', '/repos/' + repo + '/contents/' + path, body);
    },
    async deleteFile(path, sha, message) {
      return api('DELETE', '/repos/' + repo + '/contents/' + path, { message, sha, branch: 'main' });
    },
  };
}

// ---------- bridge caller (local HTTP, 127.0.0.1 only) ----------

export function createBridgeCaller({ bridgeUrl = C.BRIDGE_URL, fetchImpl = fetch, pollMs = 5000 } = {}) {
  async function status() {
    try {
      const res = await fetchImpl(bridgeUrl + '/status');
      if (!res.ok) return { up: false, extensions: 0, version: null, diskVersion: null };
      const st = await res.json();
      // version = the bridge server's code version; diskVersion = the
      // version on disk (fresh from package.json). In a healthy setup
      // both equal the release version — and the adapter version too.
      return {
        up: !!st.ok,
        extensions: Array.isArray(st.extensions) ? st.extensions.length : 0,
        version: st.version || null,
        diskVersion: st.disk_version || null,
      };
    } catch (e) {
      return { up: false, extensions: 0, version: null, diskVersion: null };
    }
  }

  async function pollTask(taskId, timeoutS) {
    const deadline = Date.now() + (timeoutS + 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let t;
      try {
        const res = await fetchImpl(bridgeUrl + '/tasks/' + encodeURIComponent(taskId));
        if (!res.ok) continue;
        t = await res.json();
      } catch (e) {
        continue;
      }
      if (t.status === 'done') {
        return { answer: t.answer, model: t.model || 'gemini-web', elapsedMs: t.elapsedMs || null, adapterVersion: t.adapterVersion || null };
      }
      if (t.status === 'failed') {
        // Keep the version tag in the message (it lands in the failed
        // file) and as a property (processOneTask reads it directly).
        const msg = (t.error || 'Gemini answer failed')
          + (t.adapterVersion ? ' [adapter_version: ' + t.adapterVersion + ']' : '');
        const e = new Error(msg);
        e.adapterVersion = t.adapterVersion || null;
        throw e;
      }
      // 'running' or 'unknown' — keep polling.
    }
    throw new Error('ask_gemini task ' + taskId + ' did not finish in time');
  }

  async function ask({ prompt, model, timeoutMs }) {
    const timeoutS = Math.min(Math.max(Math.round((timeoutMs || 180000) / 1000), 5), MAX_ASK_TIMEOUT_S);
    const ctrl = new AbortController();
    const abortMs = Math.min((timeoutS + 90) * 1000, 300000);
    const timer = setTimeout(() => ctrl.abort(), abortMs);
    let out;
    try {
      const res = await fetchImpl(bridgeUrl + '/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'ask_gemini', params: { prompt, model, timeout_s: timeoutS }, clientId: RUNNER_CLIENT_ID }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('bridge /call failed: HTTP ' + res.status);
      out = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!out.ok) {
      const e = new Error(out.error || 'bridge call failed');
      if (/browser busy/.test(out.error || '')) e.code = 'busy';
      // The router embeds "[adapter_version: X]" in its error strings;
      // pull it out so the failed file and the log carry it as a field.
      e.adapterVersion = adapterVersionFromError(out.error);
      throw e;
    }
    const r = out.result || {};
    if (r.status === 'pending' && r.task_id) return pollTask(r.task_id, timeoutS);
    if (r.answer) return { answer: r.answer, model: r.model || 'gemini-web', elapsedMs: r.elapsed_ms || null, adapterVersion: r.adapter_version || null };
    throw new Error(r.error || 'ask_gemini returned no answer');
  }

  return { status, ask };
}

// ---------- one task cycle (injectable, testable) ----------

async function appendLog(github, entry, log) {
  const path = logFilePath(new Date());
  let items = [];
  let sha = null;
  try {
    const f = await github.getFile(path);
    sha = f.sha;
    const parsed = JSON.parse(f.content);
    if (Array.isArray(parsed)) items = parsed;
    else log('quota log ' + path + ' is not an array — starting fresh');
  } catch (e) {
    if (e.status !== 404) {
      log('quota log read failed (' + (e && e.message ? e.message : String(e)) + ') — entry not logged');
      return;
    }
    // 404: first entry of the day, create the file.
  }
  items.push(entry);
  try {
    await github.putFile(path, JSON.stringify(items, null, 2), 'muse-runner: log ' + entry.id + ' (' + entry.status + ')', sha);
  } catch (e) {
    log('quota log write failed (' + (e && e.message ? e.message : String(e)) + ') — entry not logged');
  }
}

// Process ONE pending task (the oldest). Returns a status object; never
// throws for a single bad task — only GitHub/bridge outages propagate
// (the run loop turns rate limits into backoff).
export async function processOneTask({ github, bridge, log = () => {} } = {}) {
  const list = await github.listPending();
  if (!list.length) return { status: 'empty' };

  // Fetch + parse everything, then pick one: malformed files first (clear
  // broken queue entries), then oldest created_at first.
  const parsed = [];
  for (const entry of list) {
    const f = await github.getFile(entry.path);
    try {
      parsed.push({ entry, sha: f.sha, task: parseTask(f.content, entry.name) });
    } catch (e) {
      parsed.push({ entry, sha: f.sha, task: null, parseError: e.message });
    }
  }
  parsed.sort((a, b) => {
    if (!a.task && b.task) return -1;
    if (a.task && !b.task) return 1;
    if (!a.task && !b.task) return a.entry.name.localeCompare(b.entry.name);
    return (a.task.created_at || '9999-12-31').localeCompare(b.task.created_at || '9999-12-31')
      || a.entry.name.localeCompare(b.entry.name);
  });

  const first = parsed[0];
  const id = first.task ? first.task.id : first.entry.name.replace(/\.json$/, '');
  const paths = taskFilePaths(id);

  if (!first.task) {
    const failedDoc = { id, error: first.parseError, failed_at: new Date().toISOString() };
    await github.putFile(paths.failed, JSON.stringify(failedDoc, null, 2), 'muse-runner: task ' + id + ' failed (bad JSON)');
    await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove malformed task ' + id);
    await appendLog(github, buildLogEntry({ task: { id, prompt: '' }, status: 'failed', error: first.parseError }), log);
    return { status: 'failed', id, error: first.parseError };
  }

  const task = first.task;

  // Idempotency guard (v0.3.3): the runner writes the done/failed file
  // FIRST and deletes the pending file AFTER. If it is stopped (or the
  // bridge restarts) in between, the next poll sees the same pending task
  // again — and would ask Gemini the same question a second time. A task
  // whose done/failed file already exists is resolved: drop the leftover
  // pending file and do NOT ask again. Never loses a task (the
  // answer/error file is already there) and never duplicates an ask.
  // Checked BEFORE the bridge status, so a leftover is cleared even while
  // the bridge is down.
  for (const resolvedPath of [paths.done, paths.failed]) {
    if (await github.exists(resolvedPath)) {
      log('task ' + task.id + ' already resolved (' + resolvedPath + ') — removing the leftover pending file, not asking again');
      await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove already-resolved task ' + task.id);
      return { status: 'already-resolved', id: task.id };
    }
  }

  const st = await bridge.status();
  if (!st.up) {
    log('bridge is down — leaving task ' + task.id + ' pending');
    return { status: 'bridge-down', id: task.id };
  }
  if (st.extensions === 0) {
    log('bridge is up but no Chrome extension is connected — leaving task ' + task.id + ' pending');
    return { status: 'no-extension', id: task.id };
  }

  // Version self-check (v0.3.1): log the bridge version before every ask.
  // The adapter version comes back with the answer; a mismatch between
  // the two means the Gemini tab is still running an old adapter — the
  // log says so plainly instead of failing with a stale-looking error.
  const bridgeVersion = st.version || null;
  const extWord = st.extensions === 1 ? '1 extension' : st.extensions + ' extensions';
  log('bridge v' + (bridgeVersion || '?') + ' (disk v' + (st.diskVersion || '?') + '), ' + extWord + ' connected — asking task ' + task.id);

  const askedModel = task.model || DEFAULT_MODEL;
  let answer;
  try {
    answer = await bridge.ask({ prompt: task.prompt, model: askedModel, timeoutMs: task.timeout_ms || 180000 });
  } catch (e) {
    if (e.code === 'busy' || /browser busy/.test(e.message || '')) {
      log('browser busy — leaving task ' + task.id + ' pending');
      return { status: 'busy', id: task.id };
    }
    const errMsg = e.message || String(e);
    const adapterVersion = e.adapterVersion || adapterVersionFromError(errMsg);
    logVersionMismatch(log, bridgeVersion, adapterVersion);
    const failedDoc = { id: task.id, error: errMsg, adapter_version: adapterVersion, bridge_version: bridgeVersion, failed_at: new Date().toISOString() };
    await github.putFile(paths.failed, JSON.stringify(failedDoc, null, 2), 'muse-runner: task ' + task.id + ' failed');
    await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove failed task ' + task.id);
    await appendLog(github, buildLogEntry({ task, status: 'failed', error: errMsg, askedModel, adapterVersion, bridgeVersion }), log);
    return { status: 'failed', id: task.id, error: errMsg, adapterVersion, bridgeVersion };
  }

  const adapterVersion = answer.adapterVersion || null;
  logVersionMismatch(log, bridgeVersion, adapterVersion);
  const doneDoc = {
    id: task.id,
    answer: answer.answer,
    model: 'gemini-web',
    elapsed_ms: answer.elapsedMs || null,
    asked_model: askedModel,
    answered_model: answer.model || null,
    adapter_version: adapterVersion,
    bridge_version: bridgeVersion,
    answered_at: new Date().toISOString(),
  };
  await github.putFile(paths.done, JSON.stringify(doneDoc, null, 2), 'muse-runner: task ' + task.id + ' answered');
  await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove done task ' + task.id);
  await appendLog(github, buildLogEntry({ task, status: 'done', elapsedMs: answer.elapsedMs || null, askedModel, answeredModel: answer.model || null, adapterVersion, bridgeVersion }), log);
  return { status: 'done', id: task.id, elapsedMs: answer.elapsedMs || null, askedModel, answeredModel: answer.model || null, adapterVersion, bridgeVersion };
}

// ---------- run loop ----------

async function acquireLock(dataDir) {
  const lockPath = join(dataDir, 'muse-runner.lock');
  const pid = String(process.pid);
  try {
    await writeFile(lockPath, pid + '\n', { flag: 'wx', mode: 0o600 });
    return lockPath;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Stale lock? The PID inside is dead -> take over. Alive -> refuse.
    let oldPid = null;
    try { oldPid = parseInt((await readFile(lockPath, 'utf8')).trim(), 10); } catch (e2) { /* unreadable */ }
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (e3) { alive = false; }
      if (alive) throw new Error('muse-runner is already running (pid ' + oldPid + ', lock ' + lockPath + ')');
    }
    await writeFile(lockPath, pid + '\n', { mode: 0o600 });
    return lockPath;
  }
}

export async function runRunner({ dataDir = DEFAULT_DATA_DIR, intervalS, fetchImpl = fetch, bridgeUrl = C.BRIDGE_URL } = {}) {
  const cfg = await loadConfig(dataDir);
  if (!cfg.github_token) {
    throw new Error('no github_token in ' + join(dataDir, 'config.json') + ' — run: node bin/yixiubridge.mjs github-token');
  }
  const interval = (Number.isFinite(intervalS) && intervalS > 0)
    ? intervalS
    : (cfg.runner_interval_s || DEFAULT_INTERVAL_S);
  const github = createGitHubClient({ token: cfg.github_token, fetchImpl });
  const bridge = createBridgeCaller({ bridgeUrl, fetchImpl });
  const lockPath = await acquireLock(dataDir);
  const cleanup = async () => { try { await unlink(lockPath); } catch (e) { /* already gone */ } };
  process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

  logLine('muse-runner started — polling ' + REPO + '/tasks/pending every ' + interval + 's (lock ' + lockPath + ')');
  let backoffUntil = 0;
  for (;;) {
    const now = Date.now();
    if (now < backoffUntil) {
      await sleep(Math.min(backoffUntil - now, 10000));
      continue;
    }
    try {
      const res = await processOneTask({ github, bridge, log: logLine });
      if (res.status === 'empty') logLine('poll: no pending tasks');
      else if (res.status === 'done' || res.status === 'failed' || res.status === 'already-resolved') {
        logLine('task ' + res.id + ': ' + res.status
          + (res.elapsedMs ? ' (' + res.elapsedMs + 'ms)' : '')
          + (res.adapterVersion ? ' — adapter v' + res.adapterVersion : '')
          + (res.error ? ' — ' + res.error : ''));
      }
      // bridge-down / no-extension / busy: already logged inside processOneTask.
    } catch (e) {
      if (e && e.retryAfterMs) {
        backoffUntil = Date.now() + e.retryAfterMs;
        logLine('GitHub rate limit — backing off ' + Math.round(e.retryAfterMs / 1000) + 's: ' + e.message);
      } else {
        logLine('poll error: ' + (e && e.message ? e.message : String(e)));
      }
    }
    await sleep(interval * 1000);
  }
}

// Run directly: node host/muse-runner.mjs [--interval <seconds>]
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv.find((a) => a.startsWith('--interval='));
  const idx = process.argv.indexOf('--interval');
  let intervalS;
  if (arg) intervalS = parseInt(arg.slice('--interval='.length), 10);
  else if (idx !== -1 && process.argv[idx + 1]) intervalS = parseInt(process.argv[idx + 1], 10);
  runRunner({ intervalS }).catch((e) => {
    console.error('muse-runner failed to start: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
