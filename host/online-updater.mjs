import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const REPO_OWNER = 'yixiulab';
const REPO_NAME = 'YixiuBridge';
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const SKIP_PREFIXES = ['extension/kernel/'];
const MAX_BACKUPS = 2;
function buildHeaders(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('GitHub token is required');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function githubRequest(endpoint, { token, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is not available');
  }
  const url = `${API_BASE}${endpoint}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: buildHeaders(token),
    });
  } catch (err) {
    throw new Error(`GitHub API network error (${endpoint}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API request failed (${endpoint}): HTTP ${res.status} ${res.statusText || ''}`.trim());
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`GitHub API invalid JSON (${endpoint}): ${err.message}`);
  }
}
function encodeRepoPath(repoPath) {
  return repoPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
function assertSafeRepoPath(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Invalid repository file path');
  }
  const normalized = repoPath.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Unsafe repository file path: ${repoPath}`);
  }
}
function toLocalPath(baseDir, repoPath) {
  assertSafeRepoPath(repoPath);
  return path.join(baseDir, ...repoPath.split('/'));
}
function shouldSkipPath(repoPath) {
  return SKIP_PREFIXES.some(
    (prefix) => repoPath === prefix.slice(0, -1) || repoPath.startsWith(prefix)
  );
}
function computeGitBlobSha(buffer) {
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${buffer.length}\0`);
  hash.update(buffer);
  return hash.digest('hex');
}
async function fetchRemoteFileBuffer(repoPath, { token, fetchImpl }) {
  assertSafeRepoPath(repoPath);
  const data = await githubRequest(`/contents/${encodeRepoPath(repoPath)}`, {
    token,
    fetchImpl,
  });
  if (!data || typeof data.content !== 'string' || data.encoding !== 'base64') {
    throw new Error(`Unexpected GitHub contents response for ${repoPath}`);
  }
  return Buffer.from(data.content, 'base64');
}
async function fetchRemoteVersion({ token, fetchImpl }) {
  const buf = await fetchRemoteFileBuffer('package.json', { token, fetchImpl });
  let pkg;
  try {
    pkg = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`Failed to parse remote package.json: ${err.message}`);
  }
  if (!pkg || typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error('Remote package.json is missing a valid version field');
  }
  return pkg.version.trim();
}
async function atomicWriteBuffer(targetPath, buffer, fs) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  try {
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
async function defaultExecFile(file, args) {
  return execFileAsync(file, args, { windowsHide: true });
}
async function walkFiles(rootDir, fs, currentRel = '') {
  const fullDir = currentRel ? path.join(rootDir, ...currentRel.split('/')) : rootDir;
  const entries = await fs.readdir(fullDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await walkFiles(rootDir, fs, relPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}
async function pruneOldBackups(parentDir, baseName, keepDir, fs) {
  const prefix = `${baseName}.bak-`;
  const entries = await fs.readdir(parentDir, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const fullPath = path.join(parentDir, entry.name);
    const stat = await fs.stat(fullPath);
    backups.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept = new Set([path.resolve(keepDir)]);
  for (const item of backups) {
    const resolved = path.resolve(item.fullPath);
    if (kept.size < MAX_BACKUPS) {
      kept.add(resolved);
    } else if (!kept.has(resolved)) {
      await fs.rm(item.fullPath, { recursive: true, force: true });
    }
  }
}
export async function getLocalVersion(installDir, { fsImpl = fsPromises } = {}) {
  if (!installDir) return null;
  const pkgPath = path.join(installDir, 'package.json');
  try {
    const raw = await fsImpl.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}
export function compareSemver(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('+')[0]
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
export async function checkForUpdate({
  token,
  installDir,
  fetchImpl = globalThis.fetch,
  fsImpl = fsPromises,
}) {
  const remoteVersion = await fetchRemoteVersion({ token, fetchImpl });
  const localVersion = await getLocalVersion(installDir, { fsImpl });
  const updateAvailable =
    localVersion === null || compareSemver(remoteVersion, localVersion) > 0;
  return {
    updateAvailable,
    remoteVersion,
    localVersion,
  };
}
export async function planUpdate({
  token,
  installDir,
  fetchImpl = globalThis.fetch,
  fsImpl = fsPromises,
}) {
  const data = await githubRequest('/git/trees/main?recursive=1', {
    token,
    fetchImpl,
  });
  if (!data || !Array.isArray(data.tree)) {
    throw new Error('Unexpected GitHub tree response');
  }
  if (data.truncated) {
    throw new Error('GitHub tree response was truncated; refusing partial update');
  }
  const changed = [];
  for (const item of data.tree) {
    if (item.type !== 'blob') continue;
    if (shouldSkipPath(item.path)) continue;
    assertSafeRepoPath(item.path);
    const localPath = toLocalPath(installDir, item.path);
    let localSha = null;
    try {
      const buf = await fsImpl.readFile(localPath);
      localSha = computeGitBlobSha(buf);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`Failed to read local file ${item.path}: ${err.message}`);
      }
    }
    if (localSha !== item.sha) {
      changed.push({
        path: item.path,
        sha: item.sha,
        size: item.size ?? 0,
      });
    }
  }
  return changed;
}
export async function applyUpdate({
  token,
  installDir,
  stagingDir,
  fetchImpl = globalThis.fetch,
  execImpl = defaultExecFile,
  fsImpl = fsPromises,
}) {
  if (!installDir) {
    throw new Error('installDir is required');
  }
  const resolvedInstallDir = path.resolve(installDir);
  const parentDir = path.dirname(resolvedInstallDir);
  const baseName = path.basename(resolvedInstallDir);
  const resolvedStagingDir =
    stagingDir || path.join(parentDir, `${baseName}.staging-${Date.now()}`);
  const remoteVersion = await fetchRemoteVersion({ token, fetchImpl });
  const localVersion = await getLocalVersion(resolvedInstallDir, { fsImpl });
  const changed = await planUpdate({
    token,
    installDir: resolvedInstallDir,
    fetchImpl,
    fsImpl,
  });
  await fsImpl.rm(resolvedStagingDir, { recursive: true, force: true });
  await fsImpl.mkdir(resolvedStagingDir, { recursive: true });
  try {
    // 1. Download changed files to stagingDir
    for (const file of changed) {
      const buf = await fetchRemoteFileBuffer(file.path, { token, fetchImpl });
      const actualSha = computeGitBlobSha(buf);
      if (file.sha && actualSha !== file.sha) {
        throw new Error(`SHA mismatch for ${file.path}: expected ${file.sha}, got ${actualSha}`);
      }
      const stagedPath = toLocalPath(resolvedStagingDir, file.path);
      await fsImpl.mkdir(path.dirname(stagedPath), { recursive: true });
      await fsImpl.writeFile(stagedPath, buf);
    }
    // 2. Validate staged files
    let stagedPkgVersion = null;
    for (const file of changed) {
      const stagedPath = toLocalPath(resolvedStagingDir, file.path);
      const ext = path.extname(file.path).toLowerCase();
      if (ext === '.js' || ext === '.mjs') {
        try {
          await execImpl(process.execPath, ['--check', stagedPath]);
        } catch (err) {
          throw new Error(`Syntax check failed for ${file.path}: ${err.stderr || err.message}`);
        }
      } else if (ext === '.json') {
        const raw = await fsImpl.readFile(stagedPath, 'utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(`JSON validation failed for ${file.path}: ${err.message}`);
        }
        if (file.path === 'package.json') {
          stagedPkgVersion = parsed?.version ?? null;
        }
      }
    }
    // Verify package.json version matches remoteVersion
    const effectiveVersion = stagedPkgVersion ?? localVersion;
    if (effectiveVersion !== remoteVersion) {
      throw new Error(
        `package.json version mismatch: expected ${remoteVersion}, got ${effectiveVersion}`
      );
    }
  } catch (err) {
    await fsImpl.rm(resolvedStagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // 3. Backup files that will be overwritten
  const backupTag = localVersion || 'unknown';
  let backupDir = path.join(parentDir, `${baseName}.bak-${backupTag}`);
  try {
    await fsImpl.access(backupDir);
    backupDir = path.join(parentDir, `${baseName}.bak-${backupTag}-${Date.now()}`);
  } catch {
    // backupDir does not exist yet
  }
  await fsImpl.mkdir(backupDir, { recursive: true });
  // Files in `changed` that did not exist locally are new files the
  // update adds (not overwrites): there is nothing to back up, and a
  // later rollback must delete them again (fix by Muse, 2026-11-21:
  // the draft's rollback only restored backed-up files, so an added
  // file would linger after a rollback).
  const added = [];
  for (const file of changed) {
    const srcPath = toLocalPath(resolvedInstallDir, file.path);
    try {
      const buf = await fsImpl.readFile(srcPath);
      const dstPath = toLocalPath(backupDir, file.path);
      await fsImpl.mkdir(path.dirname(dstPath), { recursive: true });
      await fsImpl.writeFile(dstPath, buf);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`Backup failed for ${file.path}: ${err.message}`);
      }
      added.push(file.path);
    }
  }
  await pruneOldBackups(parentDir, baseName, backupDir, fsImpl);
  // 4. Atomically replace files in installDir
  const updated = [];
  for (const file of changed) {
    const stagedPath = toLocalPath(resolvedStagingDir, file.path);
    const targetPath = toLocalPath(resolvedInstallDir, file.path);
    const buf = await fsImpl.readFile(stagedPath);
    await atomicWriteBuffer(targetPath, buf, fsImpl);
    updated.push(file.path);
  }
  await fsImpl.rm(resolvedStagingDir, { recursive: true, force: true }).catch(() => {});
  return {
    version: remoteVersion,
    updated,
    added,
    backupDir,
  };
}
export async function rollback({ installDir, backupDir, addedFiles = [], fsImpl = fsPromises }) {
  if (!installDir || !backupDir) {
    throw new Error('installDir and backupDir are required');
  }
  const resolvedInstallDir = path.resolve(installDir);
  const resolvedBackupDir = path.resolve(backupDir);
  const files = await walkFiles(resolvedBackupDir, fsImpl);
  const restored = [];
  for (const relPath of files) {
    const srcPath = toLocalPath(resolvedBackupDir, relPath);
    const targetPath = toLocalPath(resolvedInstallDir, relPath);
    const buf = await fsImpl.readFile(srcPath);
    await atomicWriteBuffer(targetPath, buf, fsImpl);
    restored.push(relPath);
  }
  // Files the update added (they had no backup) must be removed again,
  // otherwise a rollback leaves the new files behind.
  for (const relPath of addedFiles) {
    await fsImpl.rm(toLocalPath(resolvedInstallDir, relPath), { force: true }).catch(() => {});
  }
  return restored;
}
