// Tests for the v0.4.0 idle online update in host/muse-runner.mjs
// (runIdleOnlineUpdate + helpers). The bridge, the updater and the
// restarter are all faked; the config + last-update.json live in real
// temp dirs, so the state-file behaviour is exercised for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runIdleOnlineUpdate,
  needsRunnerSelfRestart,
  writeLastUpdateRecord,
} from '../host/muse-runner.mjs';

async function makeDataDir(token = 'fake-token') {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-data-'));
  if (token !== null) await writeFile(join(dir, 'config.json'), JSON.stringify({ github_token: token }), 'utf8');
  return dir;
}

function fakeBridge({ up = true, extensions = 1, version = '0.3.7' } = {}) {
  return { status: async () => ({ up, extensions, version, diskVersion: version }) };
}

function fakeUpdater({ updateAvailable = false, stable = true, applyResult = null } = {}) {
  const calls = [];
  return {
    calls,
    checkForUpdate: async ({ installDir }) => {
      calls.push(['checkForUpdate', installDir]);
      return { localVersion: '0.3.7', remoteVersion: '0.4.0', updateAvailable };
    },
    planUpdate: async () => { calls.push(['planUpdate']); return { version: '0.4.0', changed: ['host/a.mjs'] }; },
    applyUpdate: async ({ installDir }) => {
      calls.push(['applyUpdate', installDir]);
      return applyResult || { version: '0.4.0', updated: ['host/a.mjs'], added: [], backupDir: '/tmp/bak-0.3.7' };
    },
    rollback: async (args) => { calls.push(['rollback', args]); },
    isStableRelease: async ({ version }) => { calls.push(['isStableRelease', version]); return stable; },
  };
}

function fakeRestarter({ restartResult = { ok: true, skipped: false, killedPids: [123], newPid: 456, version: '0.4.0' } } = {}) {
  const calls = [];
  return {
    calls,
    restartBridge: async (args) => { calls.push(['restartBridge', args]); return restartResult; },
    startBridgeDetached: (dir) => { calls.push(['startBridgeDetached', dir]); return 456; },
    waitForBridgeReady: async () => { calls.push(['waitForBridgeReady']); return { ok: true, status: { version: '0.3.7' } }; },
  };
}

async function readRecord(dir) {
  return JSON.parse(await readFile(join(dir, 'last-update.json'), 'utf8'));
}

test('no token: update never runs', async () => {
  const dir = await makeDataDir(null);
  const updater = fakeUpdater({ updateAvailable: true });
  const logs = [];
  const res = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m), updater,
  });
  assert.deepEqual(res, { checked: false });
  assert.equal(updater.calls.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('bridge down or no extension: update skipped, not counted as a check', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({ updateAvailable: true });
  const logs = [];
  const r1 = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge({ up: false }), log: (m) => logs.push(m), updater,
  });
  assert.deepEqual(r1, { checked: false });
  const r2 = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge({ extensions: 0 }), log: (m) => logs.push(m), updater,
  });
  assert.deepEqual(r2, { checked: false });
  assert.equal(updater.calls.length, 0);
  assert.ok(logs.some((m) => m.includes('桥未就绪') || m.includes('无法获取桥状态')));
  await rm(dir, { recursive: true, force: true });
});

test('up to date: record written, nothing applied', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({ updateAvailable: false });
  const logs = [];
  const res = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m), updater,
  });
  assert.deepEqual(res, { checked: true, updated: false });
  assert.ok(!updater.calls.some((c) => c[0] === 'applyUpdate'));
  const rec = await readRecord(dir);
  assert.equal(rec.updated, false);
  assert.equal(rec.version, '0.3.7');
  assert.ok(logs.some((m) => m.includes('已是最新版本')));
  await rm(dir, { recursive: true, force: true });
});

test('update available but not stable: never applied', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({ updateAvailable: true, stable: false });
  const logs = [];
  const res = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m), updater,
  });
  assert.deepEqual(res, { checked: true, updated: false });
  assert.ok(updater.calls.some((c) => c[0] === 'isStableRelease' && c[1] === '0.4.0'));
  assert.ok(!updater.calls.some((c) => c[0] === 'applyUpdate'));
  assert.ok(logs.some((m) => m.includes('还不是稳定版')));
  await rm(dir, { recursive: true, force: true });
});

test('stable update + healthy restart: applied and recorded', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({ updateAvailable: true, stable: true });
  const restarter = fakeRestarter();
  const logs = [];
  const res = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m), updater, restarter,
  });
  assert.deepEqual(res, { checked: true, updated: true });
  assert.ok(restarter.calls.some((c) => c[0] === 'restartBridge' && c[1].expectedVersion === '0.4.0'));
  const rec = await readRecord(dir);
  assert.equal(rec.updated, true);
  assert.equal(rec.version, '0.4.0');
  assert.equal(rec.backupDir, '/tmp/bak-0.3.7');
  assert.ok(logs.some((m) => m.includes('已升级至 0.4.0')));
  await rm(dir, { recursive: true, force: true });
});

test('restart failure: rolls back, brings the old bridge up, records the error', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({
    updateAvailable: true, stable: true,
    applyResult: { version: '0.4.0', updated: ['host/a.mjs'], added: ['host/new.mjs'], backupDir: '/tmp/bak-0.3.7' },
  });
  const restarter = fakeRestarter({ restartResult: { ok: false, skipped: false, error: '桥版本未切换' } });
  const logs = [];
  const res = await runIdleOnlineUpdate({
    dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m), updater, restarter,
  });
  assert.deepEqual(res, { checked: true, updated: false });
  const rb = updater.calls.find((c) => c[0] === 'rollback');
  assert.ok(rb);
  assert.equal(rb[1].backupDir, '/tmp/bak-0.3.7');
  assert.deepEqual(rb[1].addedFiles, ['host/new.mjs']);
  assert.ok(restarter.calls.some((c) => c[0] === 'startBridgeDetached'));
  assert.ok(restarter.calls.some((c) => c[0] === 'waitForBridgeReady'));
  const rec = await readRecord(dir);
  assert.equal(rec.updated, false);
  assert.match(rec.error, /新桥启动验证失败/);
  assert.ok(logs.some((m) => m.includes('回滚完成')));
  await rm(dir, { recursive: true, force: true });
});

test('self-restart: cleanup runs, a new runner is spawned, then exit', async () => {
  const dir = await makeDataDir();
  const updater = fakeUpdater({
    updateAvailable: true, stable: true,
    applyResult: { version: '0.4.0', updated: ['host/muse-runner.mjs'], added: [], backupDir: '/tmp/bak-0.3.7' },
  });
  const restarter = fakeRestarter();
  const logs = [];
  let cleaned = false;
  let spawned = false;
  let exitCode = null;
  const realExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT-CALLED'); };
  try {
    await assert.rejects(
      runIdleOnlineUpdate({
        dataDir: dir, installDir: '/tmp/install', bridge: fakeBridge(), log: (m) => logs.push(m),
        updater, restarter,
        cleanupBeforeExit: async () => { cleaned = true; },
        spawnSelf: () => { spawned = true; return 999; },
      }),
      /EXIT-CALLED/,
    );
  } finally {
    process.exit = realExit;
  }
  assert.equal(cleaned, true);
  assert.equal(spawned, true);
  assert.equal(exitCode, 0);
  assert.ok(logs.some((m) => m.includes('重启 runner')));
  await rm(dir, { recursive: true, force: true });
});

test('needsRunnerSelfRestart: matches runner files, tolerates Windows separators', () => {
  assert.equal(needsRunnerSelfRestart({ updated: ['host/muse-runner.mjs'], added: [] }), true);
  assert.equal(needsRunnerSelfRestart({ updated: [], added: ['kernel\\shared\\constants.js'] }), true);
  assert.equal(needsRunnerSelfRestart({ updated: ['host/bridge-restart.mjs'], added: [] }), false);
  assert.equal(needsRunnerSelfRestart({ updated: [], added: [] }), false);
  assert.equal(needsRunnerSelfRestart(null), false);
});

test('writeLastUpdateRecord writes valid JSON with the expected fields', async () => {
  const dir = await makeDataDir();
  await writeLastUpdateRecord(dir, { localVersion: '0.3.7', remoteVersion: '0.4.0', updated: true, version: '0.4.0', backupDir: '/tmp/bak' });
  const rec = await readRecord(dir);
  assert.equal(rec.localVersion, '0.3.7');
  assert.equal(rec.remoteVersion, '0.4.0');
  assert.equal(rec.updated, true);
  assert.equal(rec.version, '0.4.0');
  assert.equal(rec.backupDir, '/tmp/bak');
  assert.equal(rec.error, null);
  assert.ok(rec.checked_at);
  await rm(dir, { recursive: true, force: true });
});
