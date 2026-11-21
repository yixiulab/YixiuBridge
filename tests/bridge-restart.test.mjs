// Tests for host/bridge-restart.mjs (v0.4.0, drafted by Gemini via the
// bridge, reviewed + fixed + tested by Muse).
// All process and network access is faked; nothing here touches a real
// bridge, netstat, or tasklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findListeningPidsOnPort,
  isNodeProcess,
  killPid,
  startBridgeDetached,
  waitForBridgeReady,
  restartBridge,
} from '../host/bridge-restart.mjs';

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       12345',
  '  TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       23456',
  '  TCP    127.0.0.1:18765        0.0.0.0:0              LISTENING       99999',
  '  TCP    127.0.0.1:8765         127.0.0.1:50000        ESTABLISHED     77777',
  '  UDP    0.0.0.0:5353           *:*                                    8888',
  '',
].join('\r\n');

function execStub({ netstatOut = NETSTAT, tasklistForPid = () => '', failOn = null } = {}) {
  const calls = [];
  const execFileImpl = async (file, args) => {
    calls.push({ file, args });
    if (failOn && file === failOn) throw new Error('mock ' + file + ' failed');
    if (file === 'netstat') return { stdout: netstatOut };
    if (file === 'tasklist') {
      const m = /PID eq (\d+)/.exec((args || []).join(' '));
      return { stdout: tasklistForPid(m ? Number(m[1]) : null) };
    }
    if (file === 'taskkill') return { stdout: '' };
    throw new Error('unexpected command ' + file);
  };
  return { execFileImpl, calls };
}

test('findListeningPidsOnPort: only LISTENING on the exact port', async () => {
  const { execFileImpl } = execStub();
  const pids = await findListeningPidsOnPort(8765, { execFileImpl });
  assert.deepEqual(pids.sort((a, b) => a - b), [12345, 23456]);
  // :18765 must NOT match :8765, and ESTABLISHED must not match.
  assert.ok(!pids.includes(99999));
  assert.ok(!pids.includes(77777));
});

test('isNodeProcess: tasklist CSV image name decides', async () => {
  const forPid = (pid) => (pid === 12345
    ? '"node.exe","12345","Console","1","10,000 K"\r\n'
    : '"chrome.exe","99999","Console","1","10,000 K"\r\n');
  const { execFileImpl: f1 } = execStub({ tasklistForPid: forPid });
  assert.equal(await isNodeProcess(12345, { execFileImpl: f1 }), true);
  assert.equal(await isNodeProcess(99999, { execFileImpl: f1 }), false);
  const { execFileImpl: f3 } = execStub({ tasklistForPid: () => 'INFO: No tasks are running\r\n' });
  assert.equal(await isNodeProcess(12345, { execFileImpl: f3 }), false);
});

test('killPid calls taskkill with /F', async () => {
  const { execFileImpl, calls } = execStub();
  await killPid(12345, { execFileImpl });
  assert.deepEqual(calls[0], { file: 'taskkill', args: ['/PID', '12345', '/F'] });
});

test('startBridgeDetached spawns node bin/yixiubridge.mjs bridge detached', async () => {
  const spawns = [];
  const spawnImpl = (file, args, opts) => {
    spawns.push({ file, args, opts });
    return { pid: 777, unref() {} };
  };
  const pid = startBridgeDetached('C:\\app\\YixiuBridge-main', { spawnImpl, nodePath: 'C:\\node\\node.exe' });
  assert.equal(pid, 777);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, 'C:\\node\\node.exe');
  // Entry is <installDir>/bin/yixiubridge.mjs (separator differs per OS).
  assert.ok(spawns[0].args[0].endsWith('yixiubridge.mjs'));
  assert.ok(spawns[0].args[0].includes('bin'));
  assert.deepEqual(spawns[0].args.slice(1), ['bridge']);
  assert.equal(spawns[0].opts.detached, true);
  assert.equal(spawns[0].opts.stdio, 'ignore');
});

test('waitForBridgeReady: succeeds when the version matches', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 3) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true, version: '0.4.0' }) };
  };
  const res = await waitForBridgeReady({ expectedVersion: '0.4.0', timeoutMs: 5000, pollIntervalMs: 5, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status.version, '0.4.0');
  assert.equal(n, 3);
});

test('waitForBridgeReady: wrong version never counts as ready', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '0.3.7' }) });
  const res = await waitForBridgeReady({ expectedVersion: '0.4.0', timeoutMs: 60, pollIntervalMs: 5, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /桥版本未切换/);
});

test('waitForBridgeReady: unreachable bridge times out', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const res = await waitForBridgeReady({ timeoutMs: 60, pollIntervalMs: 5, fetchImpl });
  assert.equal(res.ok, false);
});

test('restartBridge: skips on non-Windows', async () => {
  const res = await restartBridge({ installDir: 'C:\\app', expectedVersion: '0.4.0', platform: 'linux' });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});

test('restartBridge: happy path kills only the node listener and starts a new bridge', async () => {
  const tasklistForPid = (pid) => (pid === 12345
    ? '"node.exe","12345","Console","1","10,000 K"\r\n'
    : '"chrome.exe","23456","Console","1","10,000 K"\r\n');
  const { execFileImpl, calls } = execStub({ tasklistForPid });
  const spawns = [];
  const spawnImpl = (file, args, opts) => {
    spawns.push({ file, args, opts });
    return { pid: 555, unref() {} };
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '0.4.0' }) });
  const res = await restartBridge({
    installDir: 'C:\\app\\YixiuBridge-main', expectedVersion: '0.4.0', platform: 'win32',
    execFileImpl, spawnImpl, fetchImpl, nodePath: 'node.exe',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.killedPids, [12345]);
  assert.equal(res.newPid, 555);
  // 23456 was LISTENING on :8765 too, but its tasklist output says
  // chrome.exe, so it was checked and left alone.
  assert.ok(calls.some((c) => c.file === 'taskkill' && c.args.includes('12345')));
  assert.ok(!calls.some((c) => c.file === 'taskkill' && c.args.includes('23456')));
  assert.equal(spawns.length, 1);
});

test('restartBridge: never-ready bridge reports failure (caller rolls back)', async () => {
  const tasklistForPid = (pid) => (pid === 12345
    ? '"node.exe","12345","Console","1","10,000 K"\r\n'
    : '"chrome.exe","23456","Console","1","10,000 K"\r\n');
  const { execFileImpl } = execStub({ tasklistForPid });
  const spawnImpl = (file, args, opts) => ({ pid: 555, unref() {} });
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const res = await restartBridge({
    installDir: 'C:\\app\\YixiuBridge-main', expectedVersion: '0.4.0', platform: 'win32',
    execFileImpl, spawnImpl, fetchImpl, nodePath: 'node.exe', timeoutMs: 60, pollIntervalMs: 5,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.killedPids, [12345]);
  assert.equal(res.newPid, 555);
});
