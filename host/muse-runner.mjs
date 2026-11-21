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
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import C from '../kernel/shared/constants.js';
import {
  checkForUpdate,
  planUpdate,
  applyUpdate,
  rollback,
  isStableRelease,
} from './online-updater.mjs';
import {
  restartBridge,
  startBridgeDetached,
  waitForBridgeReady,
} from './bridge-restart.mjs';

export const REPO = 'yixiulab/YixiuBridge';
export const GITHUB_API = 'https://api.github.com';
export const DEFAULT_MODEL = 'Neon'; // recommended high model (highest unlocked item)
// Thinking level default (user's standing preference, 2026-11-21):
// Gemini's 思考等级 prefers 高. A task may override it per task.
export const DEFAULT_THINKING = '高';
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_DATA_DIR = join(homedir(), '.yixiubridge');
export const RUNNER_CLIENT_ID = 'muse-runner/' + C.EXTENSION_VERSION;

// A single ask_gemini call through the bridge is capped at 300s server-side
// (timeout_s + 60, max 300). The runner caps its own requests at 240s so
// the bridge never fires first; longer answers come back via the bridge's
// task store (GET /tasks/:id), which the runner polls. v0.3.4 (task -007):
// the bridge timeout used to resolve with a bare error and NO task_id, so
// the runner wrote a failed file while the answer was sitting in the tab.
// Now a bridge timeout carries the task_id (the router registers it at ask
// start) and the runner polls get_answer until the answer resolves — up to
// 15 minutes from the ask start. Long code answers are the normal case.
const MAX_ASK_TIMEOUT_S = 240;
const POLL_OVERALL_CAP_MS = 900000; // 15 minutes from the ask start
const POLL_INTERVAL_MS = 15000; // poll get_answer every 15s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatLogLine(msg) {
  return '[' + new Date().toISOString() + '] ' + msg;
}

export function logLine(msg) {
  console.log(formatLogLine(msg));
}

// ---------- config (shared with the CLI) ----------

export async function loadConfig(dataDir = DEFAULT_DATA_DIR) {
  try {
    const raw = await readFile(join(dataDir, 'config.json'), 'utf8');
    // Tolerate a leading BOM: Windows PowerShell 5.1 Set-Content
    // -Encoding UTF8 writes one, and JSON.parse chokes on it (v0.3.4,
    // 2026-11-21: the updater's step-7 cache write BOM'd config.json and
    // the runner then failed to start with "no github_token" although the
    // token was still in the file). Strip it before parsing.
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const cfg = JSON.parse(text);
    return (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  } catch (e) {
    return {};
  }
}

// Merge `patch` into the existing config file (other fields preserved) and
// save it with 0600 permissions (POSIX; best effort on Windows).
// Atomic write (v0.3.4): temp file + rename, so a crash mid-write can
// never truncate config.json and lose the github_token.
export async function saveConfig(dataDir, patch) {
  await mkdir(dataDir, { recursive: true });
  const cfg = { ...(await loadConfig(dataDir)), ...patch };
  const path = join(dataDir, 'config.json');
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { await chmod(tmp, 0o600); } catch (e) { /* Windows: best effort */ }
  await rename(tmp, path);
  return cfg;
}

// ---------- task files (pure) ----------

// Validate + normalise a task file's JSON. Throws a clear error on bad input.
export function parseThinking(value, sourceName) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('task thinking must be a string （高/中/低） in ' + (sourceName || 'task'));
  }
  const t = value.trim();
  const alias = { high: '高', medium: '中', low: '低' };
  const norm = alias[t.toLowerCase()] || t;
  if (norm !== '高' && norm !== '中' && norm !== '低') {
    throw new Error('task thinking must be 高/中/低 (got "' + t + '") in ' + (sourceName || 'task'));
  }
  return norm;
}

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
    thinking: parseThinking(data.thinking, sourceName),
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

export function buildLogEntry({ task, status, elapsedMs = null, error = null, askedModel = null, askedThinking = null, answeredModel = null, adapterVersion = null, bridgeVersion = null, bridgeTaskId = null }) {
  return {
    id: task.id,
    status, // 'done' | 'failed'
    prompt: task.prompt.length > 200 ? task.prompt.slice(0, 200) + '…' : task.prompt,
    asked_model: askedModel,
    asked_thinking: askedThinking,
    answered_model: answeredModel,
    adapter_version: adapterVersion,
    bridge_version: bridgeVersion,
    bridge_task_id: bridgeTaskId,
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

// ---------- auto-open Chrome when no extension is connected (v0.3.7) ----------
// Background: 2026-11-21, the 0.3.6 update. The user double-clicked
// 一键启动.bat at 19:10; the bridge restarted, but from 19:11 to 19:23
// the runner logged "bridge is up but no Chrome extension is connected"
// once a minute and did nothing about it. The loop only closed at 19:27
// when the user opened Profile 21's Chrome by hand and the plugin
// reconnected (-010 then answered in 43s). Whether Chrome was closed or
// the service worker never woke, no component on the PC tried to recover.
// The runner is the only piece that is always running, so it now opens
// Chrome itself — but ONLY when a task is actually waiting and no
// extension is connected, so it never pops a browser window up for
// nothing. The profile rules are the testable half of
// kernel/shared/chrome-discovery.js (same confirmed-first rule: the
// extension ID must be an own key of extensions.settings, or the profile
// must have a Local Extension Settings/<id> directory — a bare substring
// hit, e.g. stale protection MACs, is unconfirmed and ranks below any
// confirmed profile). The PowerShell updater keeps the fuller rule set
// (running-process first, loads-our-copy tiebreak); the runner uses the
// cached last_chrome_profile + recency, which on the real machine picks
// Profile 21 over Profile 18's stale MACs.
export const EXTENSION_ID = 'alcjfcjfkhfacgofhgoenljfenbcgcel';
export const CHROME_OPEN_MIN_INTERVAL_MS = 180000; // 3 min between attempts
export const CHROME_OPEN_MAX_ATTEMPTS_PER_TASK = 3; // then stop trying for that task
export const GEMINI_URL = 'https://gemini.google.com';

function isProfileDirName(name) {
  if (name === 'Default') return true;
  return /^Profile \d+$/.test(name);
}

function prefsSettingsObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const prefs = JSON.parse(text);
    const settings = prefs && prefs.extensions && prefs.extensions.settings;
    if (settings && typeof settings === 'object') return settings;
  } catch (e) { /* unparsable: no settings object */ }
  return null;
}

// Scan one Chrome User Data directory for profiles with the extension.
// Returns the best match { profileDir, confirmed, loadedPath, evidence }
// or null when no profile shows any trace of the extension.
// preferredProfileDir (config.json's last_chrome_profile) wins when it is
// a confirmed match; otherwise the most recently modified confirmed
// profile wins, then the most recently modified unconfirmed one.
// Never throws for unreadable files — a profile whose files cannot be
// read is skipped, not treated as a match.
export async function findExtensionProfile(userDataDir, {
  preferredProfileDir = null,
  readdir: readdirImpl = readdir,
  readFile: readFileImpl = readFile,
  stat: statImpl = stat,
} = {}) {
  let entries;
  try {
    entries = await readdirImpl(userDataDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  const matches = [];
  for (const entry of entries) {
    const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : !!entry.isDirectory;
    if (!isDir || !isProfileDirName(entry.name)) continue;
    const dir = join(userDataDir, entry.name);
    async function readPrefs(name) {
      try { return await readFileImpl(join(dir, name), 'utf8'); } catch (e) { return null; }
    }
    const secureText = await readPrefs('Secure Preferences');
    const prefsText = await readPrefs('Preferences');
    const secureSettings = prefsSettingsObject(secureText);
    const prefsSettings = prefsSettingsObject(prefsText);
    const hasSettingsKey = (s) => !!s && Object.prototype.hasOwnProperty.call(s, EXTENSION_ID);
    let lesExists = false;
    try { await statImpl(join(dir, 'Local Extension Settings', EXTENSION_ID)); lesExists = true; } catch (e) { /* no such directory */ }
    const confirmed = hasSettingsKey(secureSettings) || hasSettingsKey(prefsSettings) || lesExists;
    const unconfirmed = !confirmed
      && ((typeof secureText === 'string' && secureText.includes(EXTENSION_ID))
        || (typeof prefsText === 'string' && prefsText.includes(EXTENSION_ID)));
    if (!confirmed && !unconfirmed) continue;
    let loadedPath = null;
    const entryWithPath = (hasSettingsKey(secureSettings) && secureSettings[EXTENSION_ID])
      || (hasSettingsKey(prefsSettings) && prefsSettings[EXTENSION_ID]);
    if (entryWithPath && typeof entryWithPath.path === 'string') loadedPath = entryWithPath.path;
    let modifiedMs = null;
    try { modifiedMs = (await statImpl(join(dir, 'Secure Preferences'))).mtimeMs; } catch (e) { /* ignore */ }
    if (modifiedMs === null) {
      try { modifiedMs = (await statImpl(join(dir, 'Preferences'))).mtimeMs; } catch (e) { /* ignore */ }
    }
    matches.push({
      profileDir: entry.name,
      confirmed,
      loadedPath,
      evidence: confirmed ? 'Secure Preferences' : 'Secure Preferences (unconfirmed)',
      modifiedMs: modifiedMs === null ? -Infinity : modifiedMs,
    });
  }
  if (!matches.length) return null;
  if (preferredProfileDir) {
    const hit = matches.find((m) => m.profileDir === preferredProfileDir && m.confirmed);
    if (hit) return hit;
  }
  const confirmedPool = matches.filter((m) => m.confirmed);
  const pool = confirmedPool.length ? confirmedPool : matches;
  pool.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return pool[0];
}

// Find chrome.exe in the standard install locations. Returns the first
// path that exists, or null. (Same locations the PowerShell updater
// checks; the registry App Paths lookup stays in the updater.)
export async function findChromeExe({ env = process.env, stat: statImpl = stat } = {}) {
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const seen = new Set();
  for (const base of bases) {
    const exe = join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (seen.has(exe.toLowerCase())) continue;
    seen.add(exe.toLowerCase());
    try { await statImpl(exe); return exe; } catch (e) { /* not here */ }
  }
  return null;
}

// The auto-opener: stateful (throttle + per-task attempt cap) so a stuck
// machine never spams Chrome windows. All platform/filesystem/process
// access is injectable so tests can run on Linux; on a real PC the
// defaults are used and the opener only acts on Windows.
export function createChromeOpener({
  dataDir = DEFAULT_DATA_DIR,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  findProfileFn = findExtensionProfile,
  findExeFn = findChromeExe,
  now = () => Date.now(),
} = {}) {
  let lastAttemptAt = 0;
  const attemptsByTask = new Map();
  return {
    async ensureConnected({ taskId, log = () => {} } = {}) {
      if (platform !== 'win32') return { opened: false, reason: 'not-windows' };
      const nowMs = now();
      if (nowMs - lastAttemptAt < CHROME_OPEN_MIN_INTERVAL_MS) {
        return { opened: false, reason: 'throttled', nextRetryInMs: CHROME_OPEN_MIN_INTERVAL_MS - (nowMs - lastAttemptAt) };
      }
      const attempts = attemptsByTask.get(taskId) || 0;
      if (attempts >= CHROME_OPEN_MAX_ATTEMPTS_PER_TASK) {
        return { opened: false, reason: 'max-attempts' };
      }
      lastAttemptAt = nowMs;
      attemptsByTask.set(taskId, attempts + 1);
      const cfg = await loadConfig(dataDir);
      const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
      const userDataDir = join(localAppData, 'Google', 'Chrome', 'User Data');
      let profile;
      try {
        profile = await findProfileFn(userDataDir, { preferredProfileDir: cfg.last_chrome_profile || null });
      } catch (e) {
        log('自动打开 Chrome 失败：找插件身份时出错（' + (e && e.message ? e.message : String(e)) + '）— 任务继续等着，请手动打开平时用 Gemini 的那个 Chrome');
        return { opened: false, reason: 'profile-scan-failed' };
      }
      if (!profile) {
        log('没有插件连着，但没找到装了 YixiuBridge 的 Chrome 身份 — 任务继续等着，请手动打开平时用 Gemini 的那个 Chrome');
        return { opened: false, reason: 'no-profile' };
      }
      const exe = await findExeFn({ env });
      if (!exe) {
        log('没有插件连着，找到了身份 ' + profile.profileDir + ' 但没找到 chrome.exe — 任务继续等着，请手动打开平时用 Gemini 的那个 Chrome');
        return { opened: false, reason: 'no-chrome-exe' };
      }
      try {
        const child = spawnImpl(exe, ['--profile-directory=' + profile.profileDir, GEMINI_URL], { detached: true, stdio: 'ignore' });
        if (child && typeof child.unref === 'function') child.unref();
      } catch (e) {
        log('自动打开 Chrome 失败（' + (e && e.message ? e.message : String(e)) + '）— 任务继续等着，请手动打开平时用 Gemini 的那个 Chrome');
        return { opened: false, reason: 'spawn-failed' };
      }
      log('没有插件连着，正在帮你打开 Chrome（' + profile.profileDir + '）到 Gemini — 插件连上后任务 ' + taskId + ' 会自动接着做，不用你动手');
      return { opened: true, profileDir: profile.profileDir, confirmed: profile.confirmed };
    },
  };
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

export function createBridgeCaller({ bridgeUrl = C.BRIDGE_URL, fetchImpl = fetch, pollMs = POLL_INTERVAL_MS, overallCapMs = POLL_OVERALL_CAP_MS } = {}) {
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

  // Poll GET /tasks/:id until the task resolves. The overall cap runs from
  // the original ask start (the caller passes the deadline), NOT from the
  // poll start — a long answer that took 240s to stream still gets the
  // full remaining budget. Returns the answer (with bridgeTaskId); throws
  // on a genuine task failure or when the cap runs out. Every throw
  // carries e.bridgeTaskId so the failed file can name the bridge task
  // for a later get_answer (v0.3.4).
  async function pollTask(taskId, deadlineMs, capMs) {
    for (;;) {
      if (Date.now() >= deadlineMs) {
        const e = new Error('ask_gemini task ' + taskId + ' did not finish within ' + Math.round(capMs / 1000) + 's — poll get_answer with task_id ' + taskId + ' for the result');
        e.bridgeTaskId = taskId;
        throw e;
      }
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
        return { answer: t.answer, model: t.model || 'gemini-web', elapsedMs: t.elapsedMs || null, adapterVersion: t.adapterVersion || null, thinkingWarning: t.thinkingWarning || null, bridgeTaskId: taskId };
      }
      if (t.status === 'failed') {
        // Keep the version tag in the message (it lands in the failed
        // file) and as a property (processOneTask reads it directly).
        const msg = (t.error || 'Gemini answer failed')
          + (t.adapterVersion ? ' [adapter_version: ' + t.adapterVersion + ']' : '');
        const e = new Error(msg);
        e.adapterVersion = t.adapterVersion || null;
        e.bridgeTaskId = taskId;
        throw e;
      }
      // 'running' or 'unknown' — keep polling.
    }
  }

  async function ask({ prompt, model, thinking, timeoutMs }) {
    const timeoutS = Math.min(Math.max(Math.round((timeoutMs || 180000) / 1000), 5), MAX_ASK_TIMEOUT_S);
    // Overall budget for the whole ask, including polling after a
    // timeout/pending: 15 minutes from the ask start (v0.3.4, task -007 —
    // a long code answer that streams for 4+ minutes is normal, not a
    // failure).
    const overallDeadline = Date.now() + overallCapMs;
    const ctrl = new AbortController();
    const abortMs = Math.min((timeoutS + 90) * 1000, 300000);
    const timer = setTimeout(() => ctrl.abort(), abortMs);
    let out;
    try {
      const res = await fetchImpl(bridgeUrl + '/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'ask_gemini', params: { prompt, model, thinking, timeout_s: timeoutS }, clientId: RUNNER_CLIENT_ID }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('bridge /call failed: HTTP ' + res.status);
      out = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!out.ok) {
      // Bridge-side timeout WITH a task_id (v0.3.4): the ask is still
      // running in the browser — poll for the result instead of failing.
      // Without a task_id there is nothing to poll; fail as before
      // (connection error, no extension, browser busy).
      if (out.task_id) return pollTask(out.task_id, overallDeadline, overallCapMs);
      const e = new Error(out.error || 'bridge call failed');
      if (/browser busy/.test(out.error || '')) e.code = 'busy';
      // The router embeds "[adapter_version: X]" in its error strings;
      // pull it out so the failed file and the log carry it as a field.
      e.adapterVersion = adapterVersionFromError(out.error);
      throw e;
    }
    const r = out.result || {};
    if (r.status === 'pending' && r.task_id) return pollTask(r.task_id, overallDeadline, overallCapMs);
    if (r.answer) return { answer: r.answer, model: r.model || 'gemini-web', elapsedMs: r.elapsed_ms || null, adapterVersion: r.adapter_version || null, thinkingWarning: r.thinkingWarning || null, bridgeTaskId: r.task_id || null };
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
export async function processOneTask({ github, bridge, log = () => {}, chromeOpener = null } = {}) {
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
    // v0.3.7: don't just wait — open Chrome ourselves so the plugin can
    // reconnect and the task can proceed (the 2026-11-21 0.3.6 update
    // sat like this for 12 minutes until the user opened Chrome by
    // hand). Only when a task is actually waiting; the opener throttles
    // itself and gives up after 3 tries for one task. A failure to open
    // Chrome never fails the task — it stays pending either way.
    if (chromeOpener) {
      try {
        const opened = await chromeOpener.ensureConnected({ taskId: task.id, log });
        return { status: 'no-extension', id: task.id, chromeOpened: !!opened.opened, chromeProfile: opened.profileDir || null, chromeReason: opened.reason || null };
      } catch (e) {
        log('自动打开 Chrome 失败（' + (e && e.message ? e.message : String(e)) + '）— 任务继续等着');
      }
    }
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
  const askedThinking = task.thinking || DEFAULT_THINKING;
  let answer;
  try {
    answer = await bridge.ask({ prompt: task.prompt, model: askedModel, thinking: askedThinking, timeoutMs: task.timeout_ms || 180000 });
  } catch (e) {
    if (e.code === 'busy' || /browser busy/.test(e.message || '')) {
      log('browser busy — leaving task ' + task.id + ' pending');
      return { status: 'busy', id: task.id };
    }
    const errMsg = e.message || String(e);
    const adapterVersion = e.adapterVersion || adapterVersionFromError(errMsg);
    const bridgeTaskId = e.bridgeTaskId || null;
    logVersionMismatch(log, bridgeVersion, adapterVersion);
    // v0.3.4: the failed file carries the bridge task_id whenever one
    // exists, so the answer can still be retrieved later via get_answer
    // even when this run gave up (e.g. the 15-minute poll cap ran out).
    const failedDoc = { id: task.id, error: errMsg, adapter_version: adapterVersion, bridge_version: bridgeVersion, bridge_task_id: bridgeTaskId, asked_thinking: askedThinking, failed_at: new Date().toISOString() };
    await github.putFile(paths.failed, JSON.stringify(failedDoc, null, 2), 'muse-runner: task ' + task.id + ' failed');
    await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove failed task ' + task.id);
    await appendLog(github, buildLogEntry({ task, status: 'failed', error: errMsg, askedModel, askedThinking, adapterVersion, bridgeVersion, bridgeTaskId }), log);
    return { status: 'failed', id: task.id, error: errMsg, adapterVersion, bridgeVersion, bridgeTaskId };
  }

  const adapterVersion = answer.adapterVersion || null;
  const bridgeTaskId = answer.bridgeTaskId || null;
  logVersionMismatch(log, bridgeVersion, adapterVersion);
  const doneDoc = {
    id: task.id,
    answer: answer.answer,
    model: 'gemini-web',
    elapsed_ms: answer.elapsedMs || null,
    asked_model: askedModel,
    asked_thinking: askedThinking,
    answered_model: answer.model || null,
    thinking_warning: answer.thinkingWarning || null,
    adapter_version: adapterVersion,
    bridge_version: bridgeVersion,
    bridge_task_id: bridgeTaskId,
    answered_at: new Date().toISOString(),
  };
  await github.putFile(paths.done, JSON.stringify(doneDoc, null, 2), 'muse-runner: task ' + task.id + ' answered');
  await github.deleteFile(first.entry.path, first.sha, 'muse-runner: remove done task ' + task.id);
  await appendLog(github, buildLogEntry({ task, status: 'done', elapsedMs: answer.elapsedMs || null, askedModel, askedThinking, answeredModel: answer.model || null, adapterVersion, bridgeVersion, bridgeTaskId }), log);
  return { status: 'done', id: task.id, elapsedMs: answer.elapsedMs || null, askedModel, askedThinking, answeredModel: answer.model || null, adapterVersion, bridgeVersion, bridgeTaskId };
}

// ---------- run loop ----------

// File logger (v0.3.4): the runner starts minimized, so a dead/hung runner
// is invisible and its console output is unreachable (-008 sat unpicked
// for 8+ minutes with no window to look at). Every timestamped log line
// is appended to ~/.yixiubridge/muse-runner.log as well as stdout. The
// file rotates at 1 MiB (old content -> .log.1). Logging never throws —
// a logging failure must not kill the runner.
export const RUNNER_LOG_NAME = 'muse-runner.log';
export const RUNNER_LOG_MAX_BYTES = 1024 * 1024;
export const RUNNER_HEARTBEAT_NAME = 'muse-runner.heartbeat';
export const RUNNER_HEARTBEAT_MS = 30000; // a live runner refreshes this often
export const RUNNER_HEARTBEAT_STALE_MS = 180000; // no refresh this long = hung/dead

export async function createFileLogger(dataDir) {
  const logPath = join(dataDir, RUNNER_LOG_NAME);
  await mkdir(dataDir, { recursive: true });
  try {
    const st = await stat(logPath);
    if (st.size > RUNNER_LOG_MAX_BYTES) {
      try { await unlink(logPath + '.1'); } catch (e) { /* no old rotated file */ }
      try { await rename(logPath, logPath + '.1'); } catch (e) { /* fall through and append */ }
    }
  } catch (e) { /* no log file yet — fine */ }
  return {
    path: logPath,
    async log(line) {
      try { await appendFile(logPath, line + '\n'); } catch (e) { /* never crash on logging */ }
    },
  };
}

async function writeHeartbeat(dataDir) {
  try {
    await writeFile(join(dataDir, RUNNER_HEARTBEAT_NAME), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  } catch (e) { /* best effort */ }
}

async function readHeartbeat(dataDir) {
  try {
    const hb = JSON.parse(await readFile(join(dataDir, RUNNER_HEARTBEAT_NAME), 'utf8'));
    if (hb && Number.isFinite(hb.pid) && typeof hb.at === 'string') {
      const at = Date.parse(hb.at);
      if (Number.isFinite(at)) return { pid: hb.pid, at };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Single-instance lock with stale-lock takeover (v0.3.4, task -008): the
// old code refused to start whenever the lock file existed and its PID
// answered process.kill(pid, 0) — but a dead runner leaves the lock
// behind, and a recycled PID can answer "alive" even though the runner
// is gone. The lock file stays a bare PID on line 1 (the PowerShell
// updater reads it with a ^\d+$ regex). Liveness is proven by the
// heartbeat file instead: a live runner refreshes it every 30s.
//   - lock PID dead -> take over immediately.
//   - lock PID alive + heartbeat fresh (same pid, < 3 min) -> refuse.
//   - lock PID alive + heartbeat stale/missing -> the runner is hung, an
//     old version without heartbeats, or the PID was recycled: take over
//     and say so loudly in the log. The old process is NOT killed here —
//     stopping a hung runner is the updater's job (it verifies the
//     process name first); two runners can briefly coexist, and the
//     bridge lock + idempotency guard keep that from double-asking.
export async function acquireLock(dataDir, log = logLine) {
  const lockPath = join(dataDir, 'muse-runner.lock');
  const pid = String(process.pid);
  try {
    await writeFile(lockPath, pid + '\n', { flag: 'wx', mode: 0o600 });
    await writeHeartbeat(dataDir);
    return lockPath;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let oldPid = null;
    try { oldPid = parseInt((await readFile(lockPath, 'utf8')).trim(), 10); } catch (e2) { /* unreadable */ }
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (e3) { alive = false; }
      if (alive) {
        const hb = await readHeartbeat(dataDir);
        if (hb && hb.pid === oldPid && Date.now() - hb.at < RUNNER_HEARTBEAT_STALE_MS) {
          throw new Error('muse-runner is already running (pid ' + oldPid + ', heartbeat ' + Math.round((Date.now() - hb.at) / 1000) + 's ago, lock ' + lockPath + ')');
        }
        log('stale lock: pid ' + oldPid + ' is alive but its heartbeat is '
          + (hb ? 'stale (' + Math.round((Date.now() - hb.at) / 1000) + 's old)' : 'missing')
          + ' — the previous runner is hung, an old version, or the PID was recycled; taking over the lock (the old process was NOT killed)');
      } else {
        log('stale lock: pid ' + oldPid + ' is dead — taking over the lock');
      }
    }
    await writeFile(lockPath, pid + '\n', { mode: 0o600 });
    await writeHeartbeat(dataDir);
    return lockPath;
  }
}

// ---------- idle online update (v0.4.0) ----------
// When the runner is idle (a poll found no pending task), it checks once
// an hour whether a newer STABLE release is on GitHub main, pulls only
// the changed files, restarts the bridge, and restarts itself when its
// own files changed. The loop in runRunner is strictly sequential, so an
// update can never overlap a task ask — no mutex flags are needed.
// A failed update never loses a task: the pending file stays put and the
// next poll retries the task; a failed bridge restart rolls the files
// back and brings the old bridge up again.
// (Drafted by Gemini via the bridge as task 040-003, then reviewed and
// rewritten by Muse: the draft's processOneTask check was always true,
// its pending-tasks check read a local dir that never exists, it forgot
// to await loadConfig, and it invented timer/lock variable names that
// do not exist in runRunner.)

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const RUNNER_SELF_RESTART_FILES = new Set([
  'host/muse-runner.mjs',
  'kernel/shared/constants.js',
]);

// Writes ~/.yixiubridge/last-update.json. Failures are swallowed on
// purpose: a status-file write must never break the polling loop.
export async function writeLastUpdateRecord(dataDir, record, { writeFile: writeFileImpl = writeFile } = {}) {
  const payload = {
    checked_at: new Date().toISOString(),
    localVersion: record.localVersion ?? null,
    remoteVersion: record.remoteVersion ?? null,
    updated: Boolean(record.updated),
    version: record.version ?? null,
    backupDir: record.backupDir ?? null,
    error: record.error ?? null,
  };
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFileImpl(join(dataDir, 'last-update.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (e) { /* status file is best-effort only */ }
}

export function needsRunnerSelfRestart(applyResult) {
  const changed = [...(applyResult?.updated || []), ...(applyResult?.added || [])];
  return changed.some((relPath) => RUNNER_SELF_RESTART_FILES.has(String(relPath).replace(/\\/g, '/')));
}

// Respawns this runner detached (same argv), then the caller exits.
// Injected in tests so the real process never forks during a test run.
export function spawnDetachedSelf({ spawnImpl = spawn } = {}) {
  const child = spawnImpl(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (child && typeof child.unref === 'function') child.unref();
  return child && child.pid ? child.pid : null;
}

// One idle update cycle. `updater` / `restarter` / `spawnSelf` are
// injectable so tests can drive the whole flow without a real bridge,
// GitHub, or process exit.
export async function runIdleOnlineUpdate({
  dataDir,
  installDir,
  bridge,
  log = () => {},
  updater = { checkForUpdate, planUpdate, applyUpdate, rollback, isStableRelease },
  restarter = { restartBridge, startBridgeDetached, waitForBridgeReady },
  cleanupBeforeExit = null,
  spawnSelf = spawnDetachedSelf,
} = {}) {
  const cfg = await loadConfig(dataDir);
  const token = cfg.github_token;
  if (!token) return { checked: false };
  let status;
  try {
    status = await bridge.status();
  } catch (e) {
    log('在线更新跳过：无法获取桥状态（' + (e && e.message ? e.message : String(e)) + '）');
    return { checked: false };
  }
  if (!status || !status.up || status.extensions === 0) {
    log('在线更新跳过：桥未就绪或插件未连接');
    return { checked: false };
  }
  let checkRes;
  try {
    checkRes = await updater.checkForUpdate({ token, installDir });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log('在线更新检查失败：' + msg);
    await writeLastUpdateRecord(dataDir, { error: msg });
    return { checked: true, updated: false };
  }
  const localVersion = checkRes.localVersion ?? status.diskVersion ?? status.version ?? null;
  const remoteVersion = checkRes.remoteVersion ?? null;
  if (!checkRes.updateAvailable) {
    log('在线更新检查完成：已是最新版本' + (localVersion ? ' ' + localVersion : ''));
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: false, version: localVersion });
    return { checked: true, updated: false };
  }
  // Only install releases listed as stable in builds/builds.json.
  let stable = false;
  try {
    stable = await updater.isStableRelease({ token, version: remoteVersion });
  } catch (e) {
    log('在线更新跳过：读不到搭建库索引（' + (e && e.message ? e.message : String(e)) + '）');
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: false, version: localVersion, error: 'builds index unreadable' });
    return { checked: true, updated: false };
  }
  if (!stable) {
    log('在线更新跳过：新版本 ' + remoteVersion + ' 还不是稳定版，等验证通过再升');
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: false, version: localVersion });
    return { checked: true, updated: false };
  }
  log('发现稳定新版本 ' + remoteVersion + '（当前 ' + localVersion + '），开始更新');
  let applyRes;
  try {
    await updater.planUpdate({ token, installDir });
    const stagingDir = join(dirname(installDir), '.yixiubridge-update-staging');
    applyRes = await updater.applyUpdate({ token, installDir, stagingDir });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log('在线更新应用失败（文件未改动）：' + msg);
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: false, version: localVersion, error: msg });
    return { checked: true, updated: false };
  }
  const targetVersion = applyRes.version || remoteVersion;
  let restartRes;
  try {
    restartRes = await restarter.restartBridge({ installDir, expectedVersion: targetVersion, timeoutMs: 60000 });
  } catch (e) {
    restartRes = { ok: false, skipped: false, error: e && e.message ? e.message : String(e) };
  }
  if (restartRes.skipped) {
    log('在线更新已写入 ' + targetVersion + '（' + restartRes.reason + '，不自动重启桥）');
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: true, version: targetVersion, backupDir: applyRes.backupDir });
  } else if (!restartRes.ok) {
    const errMsg = '新桥启动验证失败：' + restartRes.error;
    log('在线更新回滚：' + errMsg);
    try {
      await updater.rollback({ installDir, backupDir: applyRes.backupDir, addedFiles: applyRes.added || [] });
      restarter.startBridgeDetached(installDir);
      const oldReady = await restarter.waitForBridgeReady({ timeoutMs: 30000 });
      if (oldReady.ok) {
        log('在线更新回滚完成：旧桥已恢复运行（' + (oldReady.status && oldReady.status.version ? oldReady.status.version : localVersion) + '）');
      } else {
        log('在线更新回滚警告：旧桥拉起后未在 30 秒内就绪（' + oldReady.error + '）');
      }
    } catch (rbErr) {
      log('在线更新回滚异常：' + (rbErr && rbErr.message ? rbErr.message : String(rbErr)));
    }
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: false, version: localVersion, backupDir: applyRes.backupDir, error: errMsg });
    return { checked: true, updated: false };
  } else {
    log('在线更新成功：已升级至 ' + targetVersion + ' 并重启桥');
    await writeLastUpdateRecord(dataDir, { localVersion, remoteVersion, updated: true, version: targetVersion, backupDir: applyRes.backupDir });
  }
  if (needsRunnerSelfRestart(applyRes)) {
    log('检测到 runner 核心文件已更新，正在释放锁并重启 runner');
    if (cleanupBeforeExit) await cleanupBeforeExit();
    spawnSelf();
    process.exit(0);
  }
  return { checked: true, updated: true };
}

export async function runRunner({ dataDir = DEFAULT_DATA_DIR, intervalS, fetchImpl = fetch, bridgeUrl = C.BRIDGE_URL } = {}) {
  const cfg = await loadConfig(dataDir);
  if (!cfg.github_token) {
    throw new Error('no github_token in ' + join(dataDir, 'config.json') + ' — run: node bin/yixiubridge.mjs github-token');
  }
  // File logger first (v0.3.4): the lock-takeover messages below must land
  // in the log file too, not just the (minimized, invisible) console.
  const fileLogger = await createFileLogger(dataDir);
  const log = (msg) => { const line = formatLogLine(msg); console.log(line); fileLogger.log(line); };
  const interval = (Number.isFinite(intervalS) && intervalS > 0)
    ? intervalS
    : (cfg.runner_interval_s || DEFAULT_INTERVAL_S);
  const github = createGitHubClient({ token: cfg.github_token, fetchImpl });
  const bridge = createBridgeCaller({ bridgeUrl, fetchImpl });
  // v0.3.7: the runner opens Chrome itself when a task is waiting and no
  // extension is connected (see createChromeOpener).
  const chromeOpener = createChromeOpener({ dataDir });
  // v0.4.0: online self-update. The install dir is the parent of host/.
  const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let lastUpdateCheckAt = 0;
  const lockPath = await acquireLock(dataDir, log);
  // Heartbeat (v0.3.4): proves this runner is alive. A later runner that
  // finds a stale lock uses it to tell a live runner from a dead one.
  // unref so it never keeps the process alive on its own.
  const heartbeatTimer = setInterval(() => { writeHeartbeat(dataDir); }, RUNNER_HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  const cleanup = async () => {
    clearInterval(heartbeatTimer);
    try { await unlink(lockPath); } catch (e) { /* already gone */ }
    try { await unlink(join(dataDir, RUNNER_HEARTBEAT_NAME)); } catch (e) { /* already gone */ }
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

  log('muse-runner started — polling ' + REPO + '/tasks/pending every ' + interval + 's (lock ' + lockPath + ', log ' + fileLogger.path + ')');
  let backoffUntil = 0;
  for (;;) {
    const now = Date.now();
    if (now < backoffUntil) {
      await sleep(Math.min(backoffUntil - now, 10000));
      continue;
    }
    try {
      const res = await processOneTask({ github, bridge, log, chromeOpener });
      if (res.status === 'empty') log('poll: no pending tasks');
      else if (res.status === 'done' || res.status === 'failed' || res.status === 'already-resolved') {
        log('task ' + res.id + ': ' + res.status
          + (res.elapsedMs ? ' (' + res.elapsedMs + 'ms)' : '')
          + (res.adapterVersion ? ' — adapter v' + res.adapterVersion : '')
          + (res.error ? ' — ' + res.error : ''));
      }
      // bridge-down / no-extension / busy: already logged inside processOneTask.
      // Idle online update (v0.4.0): only when this poll found no pending
      // task at all, and at most once an hour. The loop is strictly
      // sequential, so an update can never overlap a task ask.
      if (res.status === 'empty' && Date.now() - lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL_MS) {
        try {
          const upd = await runIdleOnlineUpdate({ dataDir, installDir, bridge, log, cleanupBeforeExit: cleanup });
          if (upd.checked) lastUpdateCheckAt = Date.now();
        } catch (e) {
          log('在线更新异常：' + (e && e.message ? e.message : String(e)));
        }
      }
    } catch (e) {
      if (e && e.retryAfterMs) {
        backoffUntil = Date.now() + e.retryAfterMs;
        log('GitHub rate limit — backing off ' + Math.round(e.retryAfterMs / 1000) + 's: ' + e.message);
      } else {
        log('poll error: ' + (e && e.message ? e.message : String(e)));
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
