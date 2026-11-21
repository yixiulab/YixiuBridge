// YixiuBridge — local bridge server.
// Binds 127.0.0.1 ONLY. Never 0.0.0.0, never a public port, never any
// external API. Three jobs:
//   1. SSE fan-out: extensions subscribe (GET /events) and receive tool_call
//      frames pushed by the MCP server's POST /call.
//   2. Correlation: every tool_call carries an id; the extension's POST
//      /result resolves the matching pending call (with timeout).
//   3. Safety: per-client trust (see host/trust.mjs), one-controller task
//      lock (a second client cannot take the browser while a task is busy),
//      and a task store so get_answer works after the original call timed out.
//
// Run directly:  node host/bridge-server.mjs [--port 8765]
// As a library:  import { createBridgeServer } from './bridge-server.mjs'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import C from '../kernel/shared/constants.js';
import TOOLS from '../kernel/control/host/tools.js';
import { TrustRegistry } from './trust.mjs';

const DEFAULT_DATA_DIR = join(homedir(), '.yixiubridge');

// Version on disk, read fresh from the repo's package.json on every call
// (never cached at startup). The extension's auto-update check compares
// this with its running manifest version: after 一键启动.bat downloads a
// newer ZIP over the install folder, the disk version goes up and the
// extension reloads itself. Returns null if the file cannot be read.
const REPO_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
function readDiskVersion() {
  try {
    const pkg = JSON.parse(readFileSync(REPO_PACKAGE_JSON, 'utf8'));
    return (pkg && typeof pkg.version === 'string') ? pkg.version : null;
  } catch (e) { return null; }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Match a `browser` param against a connected extension: exact id, exact
// label, or unambiguous substring match. Returns the extension or null.
function matchExtension(extensions, want) {
  if (!want) return extensions.values().next().value || null;
  const list = Array.from(extensions.values());
  let hit = list.find((e) => e.profile.id === want || e.profile.label === want);
  if (hit) return hit;
  const subs = list.filter((e) => e.profile.id.includes(want) || e.profile.label.includes(want));
  if (subs.length === 1) return subs[0];
  if (subs.length > 1) return { ambiguous: subs.map((e) => e.profile.label) };
  return null;
}

export async function createBridgeServer({ port = C.BRIDGE_PORT, dataDir = DEFAULT_DATA_DIR, repoRoot = null } = {}) {
  const trust = new TrustRegistry(dataDir);
  await trust.load();

  const extensions = new Map(); // connId -> { res, profile, lastSeen }
  const pending = new Map(); // callId -> { resolve, reject, timer, tool }
  const tasks = new Map(); // taskId -> { status, answer?, error?, ... }
  const controller = { clientId: null, busy: false };
  let nextId = 1;

  function pushToExtension(ext, frame) {
    ext.res.write('data: ' + JSON.stringify(frame) + '\n\n');
    ext.lastSeen = Date.now();
  }

  function releaseLock(clientId) {
    if (controller.clientId === clientId) {
      controller.clientId = null;
      controller.busy = false;
    }
  }

  async function routeCall({ tool, params, clientId }) {
    const spec = TOOLS.getTool(tool);
    if (!spec) return { ok: false, error: 'unknown tool: ' + tool };

    // get_answer is answered locally from the task store — no browser needed.
    if (tool === 'get_answer') {
      const t = tasks.get(params.task_id);
      if (!t) return { ok: true, result: { status: 'unknown', error: 'no such task: ' + params.task_id } };
      return { ok: true, result: t };
    }

    // ping never takes the lock and never needs a browser.
    if (tool === 'ping') {
      return { ok: true, result: { ok: true, bridge: 'connected', version: C.EXTENSION_VERSION, extensions: extensions.size } };
    }

    if (controller.busy && controller.clientId !== clientId) {
      return { ok: false, error: 'browser busy — a task is already running for ' + controller.clientId + '. Wait for it to finish, then retry.' };
    }
    if (extensions.size === 0) {
      return { ok: false, error: 'no Chrome extension connected — load YixiuBridge in Chrome (chrome://extensions -> Load unpacked) and make sure the bridge is running.' };
    }

    const want = params.browser || params.profile || null;
    const ext = matchExtension(extensions, want);
    if (!ext) {
      return { ok: false, error: 'no Chrome profile matches "' + want + '" — connected profiles: ' + Array.from(extensions.values()).map((e) => e.profile.label).join(', ') };
    }
    if (ext.ambiguous) {
      return { ok: false, error: 'ambiguous browser "' + want + '" — matches: ' + ext.ambiguous.join(', ') };
    }

    controller.clientId = clientId;
    controller.busy = true;
    const id = 'call_' + (nextId++) + '_' + Date.now().toString(36);
    const timeoutMs = tool === 'ask_gemini'
      ? Math.min(((params.timeout_s || 180) + 60) * 1000, C.TOOL_CALL_TIMEOUT_MS)
      : 60000;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        releaseLock(clientId);
        resolve({
          ok: false,
          error: tool + ' timed out after ' + Math.round(timeoutMs / 1000) + 's — the task may still be running in the browser; poll get_answer if it returned a task_id.',
        });
      }, timeoutMs);
      pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          releaseLock(clientId);
          resolve(frame);
        },
        tool,
      });
      pushToExtension(ext, { type: 'tool_call', id, tool, params, controller: clientId });
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      // ---- SSE subscription (extension side) ----
      if (req.method === 'GET' && url.pathname === '/events') {
        const profile = {
          id: url.searchParams.get('profile') || 'Profile-unknown',
          label: url.searchParams.get('label') || url.searchParams.get('profile') || 'Profile-unknown',
        };
        const connId = 'ext_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const ext = { res, profile, lastSeen: Date.now() };
        extensions.set(connId, ext);
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (e) { /* closed */ }
        }, 15000);
        req.on('close', () => { clearInterval(heartbeat); extensions.delete(connId); });
        return;
      }

      // ---- Tool result from the extension ----
      if (req.method === 'POST' && url.pathname === '/result') {
        const frame = await readBody(req);
        const call = pending.get(frame.id);
        if (call) {
          pending.delete(frame.id);
          call.resolve({ ok: !!frame.ok, result: frame.result, error: frame.error });
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- Long-task completion notice from the extension ----
      if (req.method === 'POST' && url.pathname === '/task-update') {
        const frame = await readBody(req);
        if (frame.taskId && frame.task) tasks.set(frame.taskId, frame.task);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- Tool call from the MCP server ----
      if (req.method === 'POST' && url.pathname === '/call') {
        const body = await readBody(req);
        const out = await routeCall({ tool: body.tool, params: body.params || {}, clientId: body.clientId || 'unknown' });
        sendJson(res, 200, out);
        return;
      }

      // ---- Trust check (MCP server, on initialize) ----
      if (req.method === 'POST' && url.pathname === '/trust/check') {
        const body = await readBody(req);
        const out = await trust.checkOrTrust(body.clientId, body.name, body.kind);
        sendJson(res, 200, out);
        return;
      }

      // ---- Pairing: open a 30-minute intake window ----
      if (req.method === 'POST' && url.pathname === '/pair/start') {
        const out = await trust.openIntake();
        sendJson(res, 200, { ok: true, until: out.until });
        return;
      }

      // ---- Task lookup ----
      if (req.method === 'GET' && url.pathname.startsWith('/tasks/')) {
        const id = decodeURIComponent(url.pathname.slice('/tasks/'.length));
        const t = tasks.get(id);
        sendJson(res, 200, t || { status: 'unknown', error: 'no such task: ' + id });
        return;
      }

      // ---- MCP config for this machine ----
      if (req.method === 'GET' && url.pathname === '/config') {
        const mcpServer = repoRoot
          ? join(repoRoot, 'host', 'mcp-server.mjs')
          : join(process.cwd(), 'host', 'mcp-server.mjs');
        sendJson(res, 200, {
          mcpServers: {
            YixiuBridge: {
              command: 'node',
              args: [mcpServer],
              env: { YIXIUBRIDGE_BRIDGE_URL: 'http://127.0.0.1:' + port },
            },
          },
        });
        return;
      }

      // ---- Status ----
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, {
          ok: true,
          version: C.EXTENSION_VERSION,
          disk_version: readDiskVersion(),
          extensions: Array.from(extensions.values()).map((e) => e.profile),
          controller: controller.busy ? controller.clientId : null,
          intakeOpen: trust.intakeOpen(),
          tasks: tasks.size,
          tools: TOOLS.TOOL_NAMES,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'unknown route: ' + req.method + ' ' + url.pathname });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    trust,
    close: () => new Promise((resolve) => server.close(resolve)),
    // Test hooks (not HTTP endpoints).
    _extensions: extensions,
    _tasks: tasks,
    _pending: pending,
  };
}

// Run directly: node host/bridge-server.mjs [--port 8765]
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.slice('--port='.length), 10) : C.BRIDGE_PORT;
  const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
  const b = await createBridgeServer({ port, repoRoot });
  console.log('YixiuBridge bridge listening on http://127.0.0.1:' + b.port + ' (local only)');
}
