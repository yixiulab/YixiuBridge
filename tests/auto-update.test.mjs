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
  assert.equal(C.EXTENSION_VERSION, '0.3.2');
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

// --- Preferences evidence (v0.3.2 fix) ---
// Ground truth 2026-11-21: Profile 21's Secure Preferences has no trace
// of the extension ID, yet the extension is loaded there — Chrome records
// an unpacked (developer-mode) extension under extensions.settings.<id>
// (location 4 + path) in the regular Preferences file, not in Secure
// Preferences. The 0.3.1 scan only looked at Secure Preferences and
// matched 0 of 72 profiles. Preferences text is now the primary signal.

function prefsWithExtension(id, extra) {
  const entry = Object.assign({ location: 4, path: 'C:\\software\\myself\\YixiuBridge-main\\extension' }, extra || {});
  const settings = {};
  settings[id] = entry;
  return JSON.stringify({ extensions: { settings: settings } });
}

test('profileHasExtension matches an unpacked extension via Preferences text', () => {
  const id = D.EXTENSION_ID;
  assert.equal(D.profileHasExtension({ prefsText: prefsWithExtension(id), securePrefsText: '{}', localExtSettingsExists: false }), true, 'ID in Preferences only — Secure Preferences has no trace of it');
  assert.equal(D.profileHasExtension({ prefsText: prefsWithExtension('otherid0000000000000000000000'), securePrefsText: '{}', localExtSettingsExists: false }), false, 'a different ID in Preferences is not a match');
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: '{}', localExtSettingsExists: false }), false, 'ID in neither file');
  assert.equal(D.profileHasExtension({ prefsText: null, securePrefsText: null, localExtSettingsExists: false }), false, 'both files unreadable');
});

test('matchedEvidence lists every signal that fired, in priority order', () => {
  const id = D.EXTENSION_ID;
  assert.deepEqual(D.matchedEvidence({ prefsText: prefsWithExtension(id), securePrefsText: '"...' + id + '..."', localExtSettingsExists: true }),
    ['Preferences', 'Secure Preferences', 'Local Extension Settings'], 'all three');
  assert.deepEqual(D.matchedEvidence({ prefsText: prefsWithExtension(id), securePrefsText: '{}', localExtSettingsExists: false }),
    ['Preferences'], 'Preferences only — the unpacked-extension case');
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: '{}', localExtSettingsExists: false }), [], 'none');
  assert.deepEqual(D.matchedEvidence(null), [], 'no evidence object');
});

test('extensionPathFromPrefs reads the loaded folder from Preferences JSON', () => {
  const id = D.EXTENSION_ID;
  assert.equal(D.extensionPathFromPrefs(prefsWithExtension(id)), 'C:\\software\\myself\\YixiuBridge-main\\extension');
  assert.equal(D.extensionPathFromPrefs(prefsWithExtension(id, { path: undefined })), null, 'entry without a path');
  assert.equal(D.extensionPathFromPrefs(JSON.stringify({ extensions: { settings: { otherid0000000000000000000000: { location: 4, path: 'C:\\x' } } } })), null, 'only a different ID present');
  assert.equal(D.extensionPathFromPrefs('{"extensions":{"settings":{"' + id + '":{"location":4,"path":"C:\\\\x"'), null, 'malformed JSON never throws, just no path');
  assert.equal(D.extensionPathFromPrefs('{}'), null, 'valid JSON, no extensions at all');
  assert.equal(D.extensionPathFromPrefs(null), null);
  assert.equal(D.extensionPathFromPrefs(''), null);
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
