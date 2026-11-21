import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 8765;
const DEFAULT_STATUS_URL = 'http://127.0.0.1:8765/status';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 1_500;
function sleep(ms) {
return new Promise((resolve) => setTimeout(resolve, ms));
}
/*
解析 netstat -ano 输出，找出所有处于 LISTENING 且本地端口匹配 port 的 PID。
*/
export async function findListeningPidsOnPort(
port = DEFAULT_PORT,
{ execFileImpl = execFileAsync } = {},
) {
const { stdout } = await execFileImpl('netstat', ['-ano'], {
windowsHide: true,
encoding: 'utf8',
});
const pids = new Set();
const portSuffix = `:${port}`;
for (const rawLine of String(stdout || '').split(/\r?\n/)) {
const line = rawLine.trim();
if (!line || !/\bLISTENING\b/i.test(line)) continue;
const cols = line.split(/\s+/);
// 典型格式: TCP    127.0.0.1:8765    0.0.0.0:0    LISTENING    12345
if (cols.length < 5) continue;
const localAddr = cols[1];
const state = cols[3];
const pid = Number.parseInt(cols[4], 10);
if (
state.toUpperCase() === 'LISTENING' &&
localAddr.endsWith(portSuffix) &&
Number.isInteger(pid) &&
pid > 0
) {
pids.add(pid);
}
}
return [...pids];
}
/*
用 tasklist 确认指定 PID 的映像名是否为 node.exe。
*/
export async function isNodeProcess(
pid,
{ execFileImpl = execFileAsync } = {},
) {
const { stdout } = await execFileImpl(
'tasklist',
['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
{ windowsHide: true, encoding: 'utf8' },
);
for (const rawLine of String(stdout || '').split(/\r?\n/)) {
const line = rawLine.trim();
if (!line || !line.startsWith('"')) continue;
const firstCol = line.split('","')[0].replace(/^"|"$/g, '').toLowerCase();
if (firstCol === 'node.exe') return true;
}
return false;
}
/*
强制结束指定 PID。
*/
export async function killPid(pid, { execFileImpl = execFileAsync } = {}) {
await execFileImpl('taskkill', ['/PID', String(pid), '/F'], {
windowsHide: true,
encoding: 'utf8',
});
}
/*
以 detached 方式拉起桥进程，不阻塞当前 runner 退出。
*/
export function startBridgeDetached(
installDir,
{ spawnImpl = spawn, nodePath = process.execPath } = {},
) {
const entry = path.join(installDir, 'bin', 'yixiubridge.mjs');
const child = spawnImpl(nodePath, [entry, 'bridge'], {
cwd: installDir,
detached: true,
stdio: 'ignore',
windowsHide: true,
});
child.unref();
return child.pid ?? null;
}
/*
轮询 http://127.0.0.1:8765/status，直到通且（若指定）version 匹配。
*/
export async function waitForBridgeReady({
expectedVersion = null,
timeoutMs = DEFAULT_TIMEOUT_MS,
pollIntervalMs = DEFAULT_POLL_MS,
statusUrl = DEFAULT_STATUS_URL,
fetchImpl = globalThis.fetch,
} = {}) {
const deadline = Date.now() + timeoutMs;
let lastError = '等待桥就绪超时';
while (Date.now() < deadline) {
try {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3_000);
let res;
try {
res = await fetchImpl(statusUrl, { signal: controller.signal });
} finally {
clearTimeout(timer);
}
  if (res.ok) {
    const data = await res.json();
    if (!expectedVersion || data?.version === expectedVersion) {
      return { ok: true, status: data };
    }
    lastError = `桥版本未切换（当前 ${data?.version ?? 'unknown'}，期望 ${expectedVersion}）`;
  } else {
    lastError = `桥 /status 返回 HTTP ${res.status}`;
  }
} catch (err) {
  lastError = err?.message || String(err);
}
const remaining = deadline - Date.now();
if (remaining <= 0) break;
await sleep(Math.min(pollIntervalMs, remaining));
}
return { ok: false, error: lastError };
}
/*
Windows 下停掉占 8765 端口的旧 node.exe 桥进程，拉起新桥并验证版本。
非 Windows 平台直接跳过（由调用方记日志）。
*/
export async function restartBridge({
installDir,
expectedVersion,
port = DEFAULT_PORT,
timeoutMs = DEFAULT_TIMEOUT_MS,
platform = process.platform,
execFileImpl = execFileAsync,
spawnImpl = spawn,
fetchImpl = globalThis.fetch,
nodePath = process.execPath,
} = {}) {
if (platform !== 'win32') {
return { ok: true, skipped: true, reason: `非 Windows 平台 (${platform})` };
}
const killedPids = [];
const pids = await findListeningPidsOnPort(port, { execFileImpl });
for (const pid of pids) {
if (pid === process.pid) continue;
const isNode = await isNodeProcess(pid, { execFileImpl });
if (!isNode) continue;
await killPid(pid, { execFileImpl });
killedPids.push(pid);
}
if (killedPids.length > 0) {
await sleep(500);
}
const newPid = startBridgeDetached(installDir, { spawnImpl, nodePath });
const ready = await waitForBridgeReady({
expectedVersion,
timeoutMs,
fetchImpl,
});
if (!ready.ok) {
return {
ok: false,
skipped: false,
killedPids,
newPid,
error: ready.error,
};
}
return {
ok: true,
skipped: false,
killedPids,
newPid,
version: ready.status?.version ?? expectedVersion,
};
}
