// YixiuBridge — MCP server (stdio, newline-delimited JSON-RPC 2.0).
// The AI client (Muse, Antigravity, Claude Code, Cursor, …) spawns this
// process; it forwards tools/list and tools/call to the local bridge over
// HTTP. It never talks to the internet and never stores credentials.
//
// Trust: on `initialize` the server asks the bridge to check the client id
// (client name + version). Unknown clients are trusted only inside an open
// 30-minute pairing window (see host/trust.mjs). Without trust, every tool
// call fails with a clear "not authorized" error.
//
// Run directly: node host/mcp-server.mjs
// Env: YIXIUBRIDGE_BRIDGE_URL (default http://127.0.0.1:8765)
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import C from '../kernel/shared/constants.js';
import TOOLS from '../kernel/control/host/tools.js';

const BRIDGE_URL = process.env.YIXIUBRIDGE_BRIDGE_URL || C.BRIDGE_URL;
const SERVER_INFO = { name: 'YixiuBridge', version: C.EXTENSION_VERSION };

let clientId = 'unknown';
let clientName = 'unknown';
let trusted = false;

async function bridgePost(path, body) {
  const res = await fetch(BRIDGE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('bridge ' + path + ' failed: HTTP ' + res.status);
  return res.json();
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function result(id, resultObj) {
  send({ jsonrpc: '2.0', id, result: resultObj });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleInitialize(id, params) {
  const info = (params && params.clientInfo) || {};
  clientName = info.name || 'unknown-client';
  clientId = clientName + '/' + (info.version || 'unknown');
  try {
    const check = await bridgePost('/trust/check', { clientId, name: clientName, kind: 'mcp' });
    trusted = !!check.trusted;
    if (!trusted) {
      error(id, -32000, check.error || 'not authorized');
      return;
    }
  } catch (e) {
    error(id, -32000, 'cannot reach the YixiuBridge bridge at ' + BRIDGE_URL + ' — is it running? Start it with: node bin/yixiubridge.mjs bridge (' + e.message + ')');
    return;
  }
  result(id, {
    protocolVersion: (params && params.protocolVersion) || '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  });
}

async function handleToolsCall(id, params) {
  if (!trusted) {
    error(id, -32000, 'not authorized — no open pairing window. In the YixiuBridge side panel click "复制连接提示词" to open a 30-minute window, then reconnect.');
    return;
  }
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!TOOLS.getTool(name)) {
    error(id, -32602, 'unknown tool: ' + name);
    return;
  }
  try {
    const out = await bridgePost('/call', { tool: name, params: args, clientId });
    result(id, {
      content: [{ type: 'text', text: JSON.stringify(out.ok ? out.result : { error: out.error }, null, 2) }],
      isError: !out.ok,
    });
  } catch (e) {
    error(id, -32603, 'bridge call failed: ' + e.message);
  }
}

async function handleRequest(msg) {
  const id = msg.id;
  const method = msg.method;
  // Notifications (no id) need no reply.
  if (id === undefined || id === null) return;
  try {
    switch (method) {
      case 'initialize':
        await handleInitialize(id, msg.params);
        break;
      case 'ping':
        result(id, {});
        break;
      case 'tools/list':
        result(id, { tools: TOOLS.TOOLS });
        break;
      case 'tools/call':
        await handleToolsCall(id, msg.params);
        break;
      default:
        error(id, -32601, 'method not found: ' + method);
    }
  } catch (e) {
    error(id, -32603, 'internal error: ' + e.message);
  }
}

export async function runMcpServer() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    handleRequest(msg).catch(() => { /* already replied with an error */ });
  });
  // Keep the process alive on stdin close only until the client goes away.
  process.stdin.on('end', () => process.exit(0));
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  runMcpServer();
}
