// YixiuBridge — auto-update decision tests (Node native runner).
// Proves the version comparison and auto-reload decision used by the
// service worker (see kernel/shared/constants.js). The actual chrome.alarms
// wiring cannot run in Node; the decision function is the part that must
// never misfire (a wrong reload loops the extension, a missed reload
// leaves the user on old code). No real Chrome, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../kernel/shared/constants.js');
const D = require('../kernel/shared/chrome-discovery.js');

test('compareSemver orders versions numerically, not lexicographically', () => {
  assert.equal(C.compareSemver('0.3.1', '0.2.0'), 1);
  assert.equal(C.compareSemver('0.2.0', '0.3.1'), -1);
  assert.equal(C.compareSemver('0.3.1', '0.3.1'), 0);
  assert.equal(C.compareSemver('0.10.0', '0.9.0'), 1, '10 > 9, not "1" < "9"');
  assert.equal(C.compareSemver('1.2.3', '1.2.10'), -1);
  assert.equal(C.compareSemver('0.3', '0.3.0'), 0, 'missing parts count as 0');
  assert.equal(C.compareSemver('0.3.1', '0.3'), 1);
});

test('shouldAutoReload fires only when the disk is strictly newer', () => {
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.1', null), true);
  assert.equal(C.shouldAutoReload('0.3.1', '0.3.1', null), false, 'same version: no reload');
  assert.equal(C.shouldAutoReload('0.3.1', '0.2.0', null), false, 'disk older: no reload');
  assert.equal(C.shouldAutoReload('0.3.1', null, null), false, 'no disk version (bridge down/old): no reload');
  assert.equal(C.shouldAutoReload('0.2.0', '', null), false, 'empty disk version: no reload');
});

test('shouldAutoReload never loops on a version it already reloaded for', () => {
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.1', '0.3.1'), false, 'already reloaded for 0.3.1');
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.2', '0.3.1'), true, 'a still-newer disk version reloads again');
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.1', '0.2.0'), true, 'last reloaded was an older version');
});

test('constants carry the current version', () => {
  assert.equal(C.EXTENSION_VERSION, '0.3.1');
});

// --- Chrome profile discovery (v0.3.1 fix) ---
// These prove the selection rules the PowerShell one-click script must
// follow. The v0.3.1 script stored scan results in $matches — a PowerShell
// automatic variable that -match overwrites — so the selection picked an
// empty object (no profile name, null chrome.exe). The script now uses a
// plain variable and [regex]::IsMatch; the rules below are the same rules.

test('isProfileDirName accepts Default and Profile N only', () => {
  assert.equal(D.isProfileDirName('Default'), true);
  assert.equal(D.isProfileDirName('Profile 21'), true);
  assert.equal(D.isProfileDirName('Profile 1'), true);
  assert.equal(D.isProfileDirName('System Profile'), false);
  assert.equal(D.isProfileDirName('Guest Profile'), false);
  assert.equal(D.isProfileDirName('Profile'), false);
  assert.equal(D.isProfileDirName('Profile x'), false);
  assert.equal(D.isProfileDirName(''), false);
});

test('profileHasExtension accepts either evidence signal', () => {
  const id = D.EXTENSION_ID;
  assert.equal(D.profileHasExtension({ securePrefsText: '..."extensions":{"settings":{"' + id + '":{}}...', localExtSettingsExists: false }), true, 'ID in Secure Preferences');
  assert.equal(D.profileHasExtension({ securePrefsText: '{}', localExtSettingsExists: true }), true, 'Local Extension Settings dir');
  assert.equal(D.profileHasExtension({ securePrefsText: '{}', localExtSettingsExists: false }), false, 'neither signal');
  assert.equal(D.profileHasExtension({ securePrefsText: null, localExtSettingsExists: false }), false, 'unreadable prefs, no dir');
  assert.equal(D.profileHasExtension(null), false);
  assert.equal(D.profileHasExtension({}), false);
});

function profile(dir, modifiedMs, exe) {
  return { exe: exe || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profileDir: dir, userData: 'C:\\Users\\at\\AppData\\Local\\Google\\Chrome\\User Data', modifiedMs: modifiedMs === undefined ? 1000 : modifiedMs };
}

test('selectChromeProfile returns null when nothing matched — never falls back to an arbitrary profile', () => {
  assert.equal(D.selectChromeProfile([], [], null), null, 'empty input');
  assert.equal(D.selectChromeProfile([], ['Profile 21'], 'Profile 21'), null, 'a running profile that is not in the matched list is not picked');
  assert.equal(D.selectChromeProfile(null, [], null), null);
});

test('selectChromeProfile prefers the most recently modified when none is running', () => {
  const r = D.selectChromeProfile([profile('Profile 21', 1000), profile('Profile 2', 2000)], [], null);
  assert.equal(r.chosen.profileDir, 'Profile 2');
  assert.equal(r.why, 'recently-modified');
  assert.equal(r.running, false);
});

test('selectChromeProfile prefers a running profile over a newer non-running one', () => {
  const r = D.selectChromeProfile([profile('Profile 21', 1000), profile('Profile 2', 2000)], ['Profile 21'], null);
  assert.equal(r.chosen.profileDir, 'Profile 21');
  assert.equal(r.why, 'running');
  assert.equal(r.running, true);
});

test('selectChromeProfile takes the first running profile when several run', () => {
  const r = D.selectChromeProfile([profile('Profile 2', 2000), profile('Profile 21', 1000)], ['Profile 2', 'Profile 21'], null);
  assert.equal(r.chosen.profileDir, 'Profile 2');
  assert.equal(r.why, 'running-multiple');
});

test('selectChromeProfile treats unknown mtime as oldest', () => {
  const r = D.selectChromeProfile([profile('Profile 21', null), profile('Profile 2', 500)], [], null);
  assert.equal(r.chosen.profileDir, 'Profile 2');
});

test('selectChromeProfile breaks an mtime tie with the cached profile', () => {
  const a = profile('Profile 21', 1000);
  const b = profile('Profile 2', 1000);
  const r = D.selectChromeProfile([a, b], [], 'Profile 2');
  assert.equal(r.chosen.profileDir, 'Profile 2');
  assert.equal(r.why, 'tie-cached');
});

test('selectChromeProfile ignores a cached dir that is not in the list', () => {
  const r = D.selectChromeProfile([profile('Profile 21', 1000), profile('Profile 2', 1000)], [], 'Profile 99');
  assert.equal(r.chosen.profileDir, 'Profile 21', 'tie without a listed cached dir takes the first');
  assert.equal(r.why, 'recently-modified');
});

test('needsSelfUpdate fires only when both hashes exist and differ', () => {
  assert.equal(D.needsSelfUpdate('aaa', 'bbb'), true);
  assert.equal(D.needsSelfUpdate('aaa', 'aaa'), false, 'same hash: no handoff');
  assert.equal(D.needsSelfUpdate('AAA', 'aaa'), false, 'case-insensitive');
  assert.equal(D.needsSelfUpdate(null, 'bbb'), false);
  assert.equal(D.needsSelfUpdate('aaa', ''), false);
  assert.equal(D.needsSelfUpdate('', ''), false);
});
