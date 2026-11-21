#!/usr/bin/env node
// YixiuBridge — one-shot online update (v0.4.0).
// Used by 一键启动.bat / scripts/update-and-start.ps1 instead of the
// full ZIP download whenever this file exists on disk. Also runnable
// by hand: node scripts/online-update-cli.mjs [--install-dir <dir>]
//
// Exit 0: no update available, or the update was applied.
// Exit 1: the check or the apply failed (nothing was half-applied;
// applyUpdate verifies before swapping and leaves the old files in
// place on any failure).
// The token is read from ~/.yixiubridge/config.json and never printed.
// Unlike the runner's automatic hourly check, this CLI installs the
// latest release whatever its channel is — the user chose to run it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, planUpdate, applyUpdate } from '../host/online-updater.mjs';
import { loadConfig } from '../host/muse-runner.mjs';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--install-dir');
const installDir = dirIdx !== -1 && args[dirIdx + 1]
  ? resolve(args[dirIdx + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const cfg = await loadConfig();
const token = cfg.github_token;
if (!token) {
  console.log('online-update: no github_token in ~/.yixiubridge/config.json — run: node bin/yixiubridge.mjs github-token');
  process.exit(1);
}

let checkRes;
try {
  checkRes = await checkForUpdate({ token, installDir });
} catch (e) {
  console.log('online-update: 检查失败：' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
if (!checkRes.updateAvailable) {
  console.log('online-update: 已是最新版本 ' + (checkRes.localVersion ?? ''));
  process.exit(0);
}

console.log('online-update: 发现新版本 ' + checkRes.remoteVersion + '（当前 ' + checkRes.localVersion + '），开始更新');
try {
  await planUpdate({ token, installDir });
  const res = await applyUpdate({ token, installDir });
  console.log('online-update: 已更新至 ' + res.version
    + '（改了 ' + res.updated.length + ' 个文件'
    + (res.added.length ? '，新增 ' + res.added.length + ' 个' : '')
    + '，备份在 ' + res.backupDir + '）');
  process.exit(0);
} catch (e) {
  console.log('online-update: 更新失败（文件未改动）：' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
