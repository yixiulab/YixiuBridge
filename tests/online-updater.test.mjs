// Tests for host/online-updater.mjs (v0.4.0, drafted by Gemini via the
// bridge, reviewed + fixed + tested by Muse).
// GitHub access is fully faked; the filesystem is real temp dirs on disk,
// so staging / backup / atomic-replace behaviour is exercised for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkForUpdate,
  compareSemver,
  getLocalVersion,
  isStableRelease,
  planUpdate,
  applyUpdate,
  rollback,
} from '../host/online-updater.mjs';

function blobSha(text) {
  const buf = Buffer.from(text, 'utf8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const jsonRes = (obj) => ({ ok: true, status: 200, statusText: 'OK', json: async () => obj });

// Fake GitHub: `files` maps repo path -> content string; `pkgVersion` is
// the version inside the fake remote package.json. Tree SHAs are computed
// with the same git blob formula the module uses.
function makeFetch({ pkgVersion, files }) {
  const tree = Object.entries(files).map(([p, content]) => ({
    path: p, type: 'blob', sha: blobSha(content), size: Buffer.byteLength(content),
  }));
  // The contents endpoint must return exactly the bytes the tree SHA
  // was computed from — otherwise the module (correctly) reports a
  // SHA mismatch.
  const pkgJson = Object.prototype.hasOwnProperty.call(files, 'package.json')
    ? files['package.json']
    : JSON.stringify({ name: 'yixiubridge', version: pkgVersion });
  return async (url) => {
    if (url.includes('/git/trees/main')) return jsonRes({ tree, truncated: false });
    const m = /\/contents\/(.+)$/.exec(url);
    if (m) {
      const p = decodeURIComponent(m[1]);
      if (p === 'package.json') return jsonRes({ content: b64(pkgJson), encoding: 'base64' });
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        return jsonRes({ content: b64(files[p]), encoding: 'base64' });
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    throw new Error('unexpected url ' + url);
  };
}

async function makeInstall(files) {
  const dir = await mkdtemp(join(tmpdir(), 'yixiubridge-install-'));
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, ...p.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

function recordingExec({ failOn = null } = {}) {
  const calls = [];
  const execImpl = async (file, args) => {
    calls.push({ file, args });
    if (failOn && args.some((a) => String(a).includes(failOn))) {
      const e = new Error('mock syntax error');
      e.stderr = 'mock syntax error in ' + failOn;
      throw e;
    }
  };
  return { execImpl, calls };
}

test('compareSemver orders versions numerically', () => {
  assert.equal(compareSemver('0.10.0', '0.9.0'), 1);
  assert.equal(compareSemver('0.3.7', '0.3.7'), 0);
  assert.equal(compareSemver('0.3.6', '0.3.7'), -1);
  assert.equal(compareSemver('v0.4.0', '0.4.0'), 0);
  assert.equal(compareSemver('1.0', '1.0.1'), -1);
  assert.equal(compareSemver('0.4', '0.4.0'), 0);
});

test('getLocalVersion reads the version, null when missing or broken', async () => {
  const dir = await makeInstall({ 'package.json': JSON.stringify({ version: '0.3.7' }) });
  assert.equal(await getLocalVersion(dir), '0.3.7');
  assert.equal(await getLocalVersion(join(dir, 'nope')), null);
  const bad = await makeInstall({ 'package.json': '{not json' });
  assert.equal(await getLocalVersion(bad), null);
  await rm(dir, { recursive: true, force: true });
  await rm(bad, { recursive: true, force: true });
});

test('checkForUpdate: newer remote, same version, missing local', async () => {
  const dir = await makeInstall({ 'package.json': JSON.stringify({ version: '0.3.7' }) });
  const newer = await checkForUpdate({
    token: 'fake', installDir: dir,
    fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: {} }),
  });
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.remoteVersion, '0.4.0');
  assert.equal(newer.localVersion, '0.3.7');
  const same = await checkForUpdate({
    token: 'fake', installDir: dir,
    fetchImpl: makeFetch({ pkgVersion: '0.3.7', files: {} }),
  });
  assert.equal(same.updateAvailable, false);
  const missing = await checkForUpdate({
    token: 'fake', installDir: join(dir, 'nope'),
    fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: {} }),
  });
  assert.equal(missing.updateAvailable, true);
  assert.equal(missing.localVersion, null);
  await rm(dir, { recursive: true, force: true });
});

test('planUpdate: unchanged / changed / missing / skipped extension/kernel', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
    'host/a.mjs': 'old a',
    'empty.txt': '',
  });
  const remote = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'host/a.mjs': 'new a',
    'host/new.mjs': 'brand new',
    'empty.txt': '',
    'extension/kernel/x.js': 'different but skipped',
  };
  const changed = await planUpdate({
    token: 'fake', installDir: dir,
    fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: remote }),
  });
  const paths = changed.map((c) => c.path).sort();
  assert.deepEqual(paths, ['host/a.mjs', 'host/new.mjs', 'package.json']);
  // Known git blob vector: the empty file's SHA must match the real one.
  assert.ok(!paths.includes('empty.txt'));
  await rm(dir, { recursive: true, force: true });
});

test('applyUpdate happy path: updates, backs up, reports added, cleans staging', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
    'host/a.mjs': 'old a',
  });
  const remote = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'host/a.mjs': 'new a',
    'host/new.mjs': 'brand new',
  };
  const { execImpl, calls } = recordingExec();
  const res = await applyUpdate({
    token: 'fake', installDir: dir,
    fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: remote }),
    execImpl,
  });
  assert.equal(res.version, '0.4.0');
  assert.deepEqual(res.updated.sort(), ['host/a.mjs', 'host/new.mjs', 'package.json']);
  assert.deepEqual(res.added, ['host/new.mjs']);
  assert.equal(await readFile(join(dir, 'host/a.mjs'), 'utf8'), 'new a');
  assert.equal(await readFile(join(dir, 'host/new.mjs'), 'utf8'), 'brand new');
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, '0.4.0');
  // Backup holds the old contents.
  const backupPkg = await readFile(join(res.backupDir, 'package.json'), 'utf8');
  assert.equal(JSON.parse(backupPkg).version, '0.3.7');
  assert.equal(await readFile(join(res.backupDir, 'host/a.mjs'), 'utf8'), 'old a');
  // Every .js/.mjs was syntax-checked, staging is gone.
  assert.ok(calls.some((c) => c.args.includes('--check')));
  assert.ok(!(await readdir(dir)).some((n) => n.includes('.staging-')));
  await rm(dir, { recursive: true, force: true });
  await rm(res.backupDir, { recursive: true, force: true });
});

test('applyUpdate validation failure: install dir untouched, staging cleaned', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
    'host/a.mjs': 'old a',
  });
  const remote = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'host/a.mjs': 'new a',
  };
  const { execImpl } = recordingExec({ failOn: 'a.mjs' });
  await assert.rejects(
    applyUpdate({ token: 'fake', installDir: dir, fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: remote }), execImpl }),
    /Syntax check failed for host\/a\.mjs/,
  );
  assert.equal(await readFile(join(dir, 'host/a.mjs'), 'utf8'), 'old a');
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, '0.3.7');
  assert.ok(!(await readdir(dir)).some((n) => n.includes('.staging-') || n.includes('.bak-')));
  await rm(dir, { recursive: true, force: true });
});

test('applyUpdate SHA mismatch: nothing is written', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
  });
  // Tree claims host/a.mjs has sha X, but the contents endpoint returns
  // different bytes (tampered in transit).
  const fetchImpl = async (url) => {
    if (url.includes('/git/trees/main')) {
      return jsonRes({ tree: [{ path: 'host/a.mjs', type: 'blob', sha: blobSha('expected'), size: 8 }], truncated: false });
    }
    if (url.includes('/contents/package.json')) {
      return jsonRes({ content: b64(JSON.stringify({ version: '0.4.0' })), encoding: 'base64' });
    }
    if (url.includes('/contents/host/a.mjs')) {
      return jsonRes({ content: b64('tampered!'), encoding: 'base64' });
    }
    throw new Error('unexpected url ' + url);
  };
  const { execImpl } = recordingExec();
  await assert.rejects(
    applyUpdate({ token: 'fake', installDir: dir, fetchImpl, execImpl }),
    /SHA mismatch for host\/a\.mjs/,
  );
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, '0.3.7');
  await rm(dir, { recursive: true, force: true });
});

test('rollback restores old files and removes files the update added', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
    'host/a.mjs': 'old a',
  });
  const remote = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'host/a.mjs': 'new a',
    'host/new.mjs': 'brand new',
  };
  const { execImpl } = recordingExec();
  const res = await applyUpdate({
    token: 'fake', installDir: dir,
    fetchImpl: makeFetch({ pkgVersion: '0.4.0', files: remote }),
    execImpl,
  });
  const restored = await rollback({ installDir: dir, backupDir: res.backupDir, addedFiles: res.added });
  assert.ok(restored.includes('host/a.mjs'));
  assert.equal(await readFile(join(dir, 'host/a.mjs'), 'utf8'), 'old a');
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, '0.3.7');
  await assert.rejects(readFile(join(dir, 'host/new.mjs'), 'utf8'));
  await rm(dir, { recursive: true, force: true });
  await rm(res.backupDir, { recursive: true, force: true });
});

test('applyUpdate keeps at most 2 backups', async () => {
  const dir = await makeInstall({
    'package.json': JSON.stringify({ version: '0.3.7' }),
    'host/a.mjs': 'a0',
  });
  const parent = join(dir, '..');
  const base = dir.split('/').pop();
  const { execImpl } = recordingExec();
  for (const v of ['0.4.0', '0.4.1', '0.4.2']) {
    await applyUpdate({
      token: 'fake', installDir: dir,
      fetchImpl: makeFetch({ pkgVersion: v, files: { 'package.json': JSON.stringify({ version: v }), 'host/a.mjs': 'a-' + v } }),
      execImpl,
    });
    assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version, v);
  }
  // Three updates ran; the prune step must have kept only the newest 2.
  const names = (await readdir(parent)).filter((n) => n.startsWith(base + '.bak-'));
  assert.equal(names.length, 2, 'expected 2 backups, got ' + names.join(','));
  for (const n of names) await rm(join(parent, n), { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

const INDEX = JSON.stringify({
  builds: [
    { version: '0.3.7', channel: 'stable' },
    { version: '0.4.0', channel: 'beta' },
  ],
});

test('isStableRelease: only channel stable counts', async () => {
  const fetchImpl = makeFetch({ pkgVersion: '0.4.0', files: { 'builds/builds.json': INDEX } });
  assert.equal(await isStableRelease({ token: 'fake', version: '0.3.7', fetchImpl }), true);
  assert.equal(await isStableRelease({ token: 'fake', version: '0.4.0', fetchImpl }), false);
  assert.equal(await isStableRelease({ token: 'fake', version: '9.9.9', fetchImpl }), false);
});

test('isStableRelease: missing or broken index fails closed', async () => {
  const missing = makeFetch({ pkgVersion: '0.4.0', files: {} });
  assert.equal(await isStableRelease({ token: 'fake', version: '0.3.7', fetchImpl: missing }), false);
  const broken = makeFetch({ pkgVersion: '0.4.0', files: { 'builds/builds.json': 'not json{' } });
  assert.equal(await isStableRelease({ token: 'fake', version: '0.3.7', fetchImpl: broken }), false);
});
