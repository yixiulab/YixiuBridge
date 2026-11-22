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
  assert.equal(C.EXTENSION_VERSION, '0.4.15');
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
  assert.equal(D.profileHasExtension({ securePrefsText: prefsWithExtension(id), localExtSettingsExists: false }), true, 'ID as a settings key in Secure Preferences (confirmed)');
  assert.equal(D.profileHasExtension({ securePrefsText: '{}', localExtSettingsExists: true }), true, 'Local Extension Settings dir');
  assert.equal(D.profileHasExtension({ securePrefsText: '"...' + id + '..."', localExtSettingsExists: false }), true, 'substring-only hit still counts — as a weak, unconfirmed match, not proof');
  assert.equal(D.profileHasExtension({ securePrefsText: '{}', localExtSettingsExists: false }), false, 'neither signal');
  assert.equal(D.profileHasExtension({ securePrefsText: null, localExtSettingsExists: false }), false, 'unreadable prefs, no dir');
  assert.equal(D.profileHasExtension(null), false);
  assert.equal(D.profileHasExtension({}), false);
});

// --- Evidence order (v0.3.3 fix — the 0.3.2 claim was WRONG) ---
// 0.3.2 said Chrome records unpacked extensions in the regular Preferences
// file (extensions.settings.<id>, location 4 + path) and NOT in Secure
// Preferences, citing Profile 21's Secure Preferences search. That was a
// misreading: Chrome records extension installs in Secure Preferences;
// the user's real Profile 21 Preferences file (90 KB JSON, read directly
// 2026-11-21) has NO extensions.settings key at all and the ID appears 0
// times. Secure Preferences is the primary signal again; Local Extension
// Settings is the backup; Preferences is a WEAK signal kept only for
// Chromium-based browsers that record extensions there. And the 0.3.1
// scan matching 0 of 72 profiles is now SOLVED: it was not a file or
// evidence problem at all — every scan searched for a 33-character ID
// (alcjfcjfkfhfacgofhgoenljfenbcgcel, an extra 'f' misread from a
// chrome://extensions screenshot), and a real Chrome extension ID is
// always exactly 32 characters. The user's real Profile 21 Secure
// Preferences file (read directly 2026-11-21) DOES contain the record
// under the correct ID alcjfcjfkhfacgofhgoenljfenbcgcel (location 4,
// path C:\software\myself\YixiuBridge-main\extension). The 0.3.3 scan
// still prints Secure Preferences readability counts, so a future
// 0-match run is diagnosable from the output alone.

function prefsWithExtension(id, extra) {
  const entry = Object.assign({ location: 4, path: 'C:\\software\\myself\\YixiuBridge-main\\extension' }, extra || {});
  const settings = {};
  settings[id] = entry;
  return JSON.stringify({ extensions: { settings: settings } });
}

test('profileHasExtension matches via Secure Preferences (primary) and still via Preferences (weak fallback)', () => {
  const id = D.EXTENSION_ID;
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: prefsWithExtension(id), localExtSettingsExists: false }), true, 'ID in Secure Preferences only — the Chrome case');
  assert.equal(D.profileHasExtension({ prefsText: prefsWithExtension(id), securePrefsText: '{}', localExtSettingsExists: false }), true, 'ID in Preferences only — weak signal for Chromium-based browsers');
  assert.equal(D.profileHasExtension({ prefsText: prefsWithExtension('otherid0000000000000000000000'), securePrefsText: '{}', localExtSettingsExists: false }), false, 'a different ID in Preferences is not a match');
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: '{}', localExtSettingsExists: false }), false, 'ID in neither file');
  assert.equal(D.profileHasExtension({ prefsText: null, securePrefsText: null, localExtSettingsExists: false }), false, 'both files unreadable');
});

test('matchedEvidence lists every signal that fired, in priority order (Secure Preferences first)', () => {
  const id = D.EXTENSION_ID;
  assert.deepEqual(D.matchedEvidence({ prefsText: prefsWithExtension(id), securePrefsText: '"...' + id + '..."', localExtSettingsExists: true }),
    ['Secure Preferences (unconfirmed)', 'Local Extension Settings', 'Preferences'], 'unparsable Secure Preferences text is only a substring hit — marked unconfirmed');
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: prefsWithExtension(id), localExtSettingsExists: false }),
    ['Secure Preferences'], 'Secure Preferences only, as a parsed settings key — the Chrome case');
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: '"...' + id + '..."', localExtSettingsExists: false }),
    ['Secure Preferences (unconfirmed)'], 'substring-only Secure Preferences hit');
  assert.deepEqual(D.matchedEvidence({ prefsText: prefsWithExtension(id), securePrefsText: '{}', localExtSettingsExists: false }),
    ['Preferences'], 'Preferences only — the weak fallback case');
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: '{}', localExtSettingsExists: false }), [], 'none');
  assert.deepEqual(D.matchedEvidence(null), [], 'no evidence object');
});

test('EXTENSION_ID is a valid Chrome extension ID: exactly 32 chars, a-p only (regression guard for the 33-char typo)', () => {
  assert.equal(typeof D.EXTENSION_ID, 'string');
  assert.equal(D.EXTENSION_ID.length, 32, 'a Chrome extension ID is always exactly 32 characters — the 0.3.1/0.3.2 scans searched a 33-char typo and matched 0/72');
  assert.match(D.EXTENSION_ID, /^[a-p]{32}$/, 'Chrome extension IDs use only lowercase a-p');
  assert.equal(D.EXTENSION_ID, 'alcjfcjfkhfacgofhgoenljfenbcgcel', "the real ID from the user's Profile 21 Secure Preferences file (2026-11-21)");
});

test('the real Profile 21 Secure Preferences record matches (location 4, path = install dir) — the 0/72 case', () => {
  const id = D.EXTENSION_ID;
  // The real record from the user's Profile 21 Secure Preferences file
  // (read directly 2026-11-21): extensions.settings.<id> with location 4
  // and path C:\software\myself\YixiuBridge-main\extension (the updater's
  // install dir + extension). prefsWithExtension builds exactly that
  // shape (location 4 + path).
  const secureText = prefsWithExtension(id);
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false }), true);
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false }), ['Secure Preferences']);
  const expectedPath = JSON.parse(secureText).extensions.settings[id].path;
  assert.equal(D.extensionPathFromPrefs(secureText), expectedPath, 'the loaded path is extracted from the Secure Preferences record');
  assert.ok(expectedPath.indexOf('YixiuBridge-main') !== -1 && expectedPath.endsWith('extension'), 'the loaded path equals the updater install dir — no path-mismatch warning should fire');
});

test('a file containing only the old 33-char typo ID does NOT match (the 0/72 regression)', () => {
  const typoId = 'alcjfcjfkfhfacgofhgoenljfenbcgcel'; // 33 chars, extra 'f' — misread from a screenshot
  assert.equal(typoId.length, 33);
  const secureText = prefsWithExtension(typoId);
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false }), false, 'the typo ID must never match the real constant');
  assert.deepEqual(D.matchedEvidence({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false }), []);
  assert.equal(D.extensionPathFromPrefs(secureText), null);
});

test('extensionPathFromPrefs reads the loaded folder from preferences-format JSON (Secure Preferences text or Preferences text — same schema)', () => {
  const id = D.EXTENSION_ID;
  assert.equal(D.extensionPathFromPrefs(prefsWithExtension(id)), 'C:\\software\\myself\\YixiuBridge-main\\extension');
  assert.equal(D.extensionPathFromPrefs(prefsWithExtension(id, { path: undefined })), null, 'entry without a path');
  assert.equal(D.extensionPathFromPrefs(JSON.stringify({ extensions: { settings: { otherid0000000000000000000000: { location: 4, path: 'C:\\x' } } } })), null, 'only a different ID present');
  assert.equal(D.extensionPathFromPrefs('{"extensions":{"settings":{"' + id + '":{"location":4,"path":"C:\\\\x"'), null, 'malformed JSON never throws, just no path');
  assert.equal(D.extensionPathFromPrefs('{}'), null, 'valid JSON, no extensions at all');
  assert.equal(D.extensionPathFromPrefs(null), null);
  assert.equal(D.extensionPathFromPrefs(''), null);
});

function profile(dir, modifiedMs, exe, extra) {
  return Object.assign({ exe: exe || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profileDir: dir, userData: 'C:\\Users\\at\\AppData\\Local\\Google\\Chrome\\User Data', modifiedMs: modifiedMs === undefined ? 1000 : modifiedMs }, extra || {});
}

// --- Chrome profile discovery (v0.3.5 fix — wrong profile + wrong path) ---
// 2026-11-21 17:56, real machine, 0.3.4 .bat run: the scan found 2 matches
// and picked Profile 18 on "Preferences 最近修改过", printing a WRONG
// loaded path (Chrome's built-in network_speech_synthesis/mv3). The real
// Gemini + YixiuBridge profile is Profile 21 (confirmed repeatedly). Two
// compounding causes, both proven from the user's real Profile 21 Secure
// Preferences file (read directly 2026-11-21):
// (a) the extension ID appears in that file THREE times — once as the
//     extensions.settings key (the live install record) and twice as a
//     key in protection/macs/extensions/settings and
//     .../settings_encrypted_hash (integrity hashes Chrome keeps per
//     extension). Those MAC entries can OUTLIVE the install record, so a
//     substring search matches a profile that no longer has the extension
//     installed. A match is only CONFIRMED when the ID is a key of
//     extensions.settings.
// (b) the running-process check required the literal string
//     '--profile-directory="Profile 21"' in a chrome.exe command line,
//     but the browser process only carries that flag when it was
//     ORIGINALLY launched with it — a profile window opened by handoff
//     or the in-Chrome profile switcher leaves no such flag anywhere, so
//     the check silently matched nothing and the weak "most recently
//     modified Preferences" rule decided (and Profile 18's Preferences
//     happened to be newer).
// The fix: confirmed-first ordering, a "loads our copy" tiebreak (loaded
// path == the updater's install dir), a tolerant command-line match, and
// a path that only ever comes from the ID's OWN settings entry.

// Realistic Secure Preferences file modelled on the user's real Profile 21
// file (read directly 2026-11-21): 8 extensions.settings entries plus
// protection/macs entries that ALSO contain the extension ID as a key.
function realisticSecurePrefs() {
  const id = D.EXTENSION_ID;
  const settings = {
    admccjkmockfdflocgggjfgdacdodkdf: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\glic_extension' },
    aeblhjpbbbfkoajniogpmecgbbnfpech: { location: 4, path: 'C:\\Users\\at\\AppData\\Local\\ZvcLoXMLgTsTc' },
    dhoheoocepdilnabcjlefemdejcmhkje: { location: 4, path: 'C:\\software\\myself\\注册muse脚本\\phone\\US-Proxy-Switcher' },
    fignfifoniblkonapihmkfakmlgkbkcf: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\network_speech_synthesis/mv3' },
    mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\pdf' },
    nkeimhogjdpnpccoofpliimaahmaaome: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\hangout_services' },
    nmmhkkegccagdldgiimedpiccmgmieda: { location: 10, path: 'nmmhkkegccagdldgiimedpiccmgmieda\\1.0.0.6_0', from_webstore: true },
  };
  settings[id] = { location: 4, path: 'C:\\software\\myself\\YixiuBridge-main\\extension', from_webstore: false };
  const macs = {};
  macs[id] = 'EC165F0C339634B965DFCB79CB25C567F00B1C9C0F54441E8212741A4';
  return JSON.stringify({
    extensions: { settings: settings, ui: { developer_mode: true } },
    protection: { macs: { extensions: { settings: macs, settings_encrypted_hash: macs } } },
  });
}

// Profile-18-style file: the ID appears ONLY in protection/macs (stale
// hashes from a removed install) — no extensions.settings entry for it.
// Neighbour entries DO have paths (incl. network_speech_synthesis).
function profile18StyleSecurePrefs() {
  const id = D.EXTENSION_ID;
  const macs = {};
  macs[id] = 'EC165F0C339634B965DFCB79CB25C567F00B1C9C0F54441E8212741A4';
  return JSON.stringify({
    extensions: {
      settings: {
        fignfifoniblkonapihmkfakmlgkbkcf: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\network_speech_synthesis/mv3' },
        mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\pdf' },
      },
      ui: { developer_mode: true },
    },
    protection: { macs: { extensions: { settings: macs, settings_encrypted_hash: macs } } },
  });
}

test('realistic 8-entry Secure Preferences (real Profile 21 structure): path is the YixiuBridge one, match is confirmed', () => {
  const id = D.EXTENSION_ID;
  const secureText = realisticSecurePrefs();
  assert.equal(D.settingsHasId(secureText), true, 'ID is a key of extensions.settings');
  assert.equal(D.textHasId(secureText), true);
  const st = D.profileExtensionStatus({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false });
  assert.equal(st.confirmed, true);
  assert.equal(st.unconfirmed, false);
  assert.deepEqual(st.evidence, ['Secure Preferences']);
  assert.equal(D.extensionPathFromPrefs(secureText), 'C:\\software\\myself\\YixiuBridge-main\\extension');
});

test('stale protection MACs only (the Profile 18 case): substring match, but NOT confirmed, and NO path is returned', () => {
  const secureText = profile18StyleSecurePrefs();
  assert.equal(D.settingsHasId(secureText), false, 'no extensions.settings entry for the ID');
  assert.equal(D.textHasId(secureText), true, 'the ID is still in the file (protection MACs)');
  const st = D.profileExtensionStatus({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false });
  assert.equal(st.confirmed, false);
  assert.equal(st.unconfirmed, true);
  assert.deepEqual(st.evidence, ['Secure Preferences (unconfirmed)']);
  assert.equal(D.profileHasExtension({ prefsText: '{}', securePrefsText: secureText, localExtSettingsExists: false }), true, 'still counts as a (weak) match — just not a confirmed one');
  assert.equal(D.extensionPathFromPrefs(secureText), null, 'must NEVER return the neighbouring network_speech_synthesis path');
});

test('extensionPathFromPrefs never returns a neighbouring entry path when the ID entry has no path', () => {
  const id = D.EXTENSION_ID;
  // JSON parses, the ID entry exists but has no "path"; the next entry does.
  const noPath = JSON.stringify({ extensions: { settings: { [id]: { location: 4 }, fignfifoniblkonapihmkfakmlgkbkcf: { location: 5, path: 'C:\\Program Files\\Google\\Chrome\\Application\\156.0.8078.48\\resources\\network_speech_synthesis/mv3' } } } });
  assert.equal(D.extensionPathFromPrefs(noPath), null, 'parsed authoritatively: no path for this ID means null');
  // Unparsable JSON (truncated mid-file): the ID entry has no path, a
  // later entry does — the anchored regex must not cross the boundary.
  const truncatedNoPath = '{"extensions":{"settings":{"' + id + '":{"location":4},"fignfifoniblkonapihmkfakmlgkbkcf":{"location":5,"path":"C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\156.0.8078.48\\\\resources\\\\network_speech_synthesis/mv3"';
  assert.equal(D.extensionPathFromPrefs(truncatedNoPath), null, 'anchored regex must not cross into the next entry');
  // Positive regex case: unparsable JSON (outer braces missing), but the
  // ID entry itself IS balanced — the brace-counted fallback finds it.
  // (A file truncated mid-entry has no balanced entry: the fallback
  // returns null and the path prints "unknown" — the safe answer.)
  const truncatedWithPath = '{"extensions":{"settings":{"' + id + '":{"location":4,"path":"C:\\\\software\\\\myself\\\\YixiuBridge-main\\\\extension"}';
  assert.equal(D.extensionPathFromPrefs(truncatedWithPath), 'C:\\software\\myself\\YixiuBridge-main\\extension');
});

test('selectChromeProfile picks the confirmed profile loading our copy over a newer unconfirmed one (the 0.3.4 Profile 18 case)', () => {
  const installDir = 'C:\\software\\myself\\YixiuBridge-main\\extension';
  const p18 = profile('Profile 18', 2000, null, { confirmed: false, loadedPath: null });
  const p21 = profile('Profile 21', 1000, null, { confirmed: true, loadedPath: installDir });
  const r = D.selectChromeProfile([p18, p21], [], null, { installExtDir: installDir });
  assert.equal(r.chosen.profileDir, 'Profile 21');
  assert.equal(r.why, 'loads-our-copy');
  assert.equal(r.confirmed, true);
  assert.equal(r.running, false);
});

test('selectChromeProfile: a confirmed profile beats an unconfirmed running one', () => {
  const p18 = profile('Profile 18', 1000, null, { confirmed: false });
  const p21 = profile('Profile 21', 1000, null, { confirmed: true });
  const r = D.selectChromeProfile([p18, p21], ['Profile 18'], null);
  assert.equal(r.chosen.profileDir, 'Profile 21', 'running is only consulted inside the confirmed pool');
  assert.equal(r.confirmed, true);
});

test('selectChromeProfile: running still beats loads-our-copy', () => {
  const installDir = 'C:\\software\\myself\\YixiuBridge-main\\extension';
  const p18 = profile('Profile 18', 1000, null, { confirmed: true, loadedPath: installDir });
  const p21 = profile('Profile 21', 2000, null, { confirmed: true, loadedPath: installDir });
  const r = D.selectChromeProfile([p18, p21], ['Profile 18'], null, { installExtDir: installDir });
  assert.equal(r.chosen.profileDir, 'Profile 18');
  assert.equal(r.why, 'running');
});

test('selectChromeProfile: with only unconfirmed matches it still picks one, flagged unconfirmed', () => {
  const r = D.selectChromeProfile([profile('Profile 18', 1000, null, { confirmed: false })], [], null);
  assert.equal(r.chosen.profileDir, 'Profile 18');
  assert.equal(r.confirmed, false);
});

test('selectChromeProfile: loads-our-copy comparison is case-insensitive (Windows paths)', () => {
  const installDir = 'C:\\software\\myself\\YixiuBridge-main\\extension';
  const p21 = profile('Profile 21', 1000, null, { confirmed: true, loadedPath: 'c:\\SOFTWARE\\MYSELF\\yixiubridge-main\\EXTENSION' });
  const p18 = profile('Profile 18', 2000, null, { confirmed: true, loadedPath: 'C:\\other\\place' });
  const r = D.selectChromeProfile([p18, p21], [], null, { installExtDir: installDir });
  assert.equal(r.chosen.profileDir, 'Profile 21');
  assert.equal(r.why, 'loads-our-copy');
});

test('profileDirInCommandLine tolerates flag quoting and never confuses Profile 2 with Profile 21', () => {
  const f = D.profileDirInCommandLine;
  assert.equal(f('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="Profile 21" --source-shortcut-location=desktop', 'Profile 21'), true, 'quoted flag (the user shortcut form)');
  assert.equal(f('chrome.exe --profile-directory=Profile 21', 'Profile 21'), true, 'unquoted flag');
  assert.equal(f('chrome.exe --profile-directory "Profile 21"', 'Profile 21'), true, 'space form');
  assert.equal(f('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --user-data-dir="C:\\Users\\at\\AppData\\Local\\Google\\Chrome\\User Data"', 'Profile 21'), false, 'no flag anywhere: not detected — never proof the profile is idle');
  assert.equal(f('chrome.exe --profile-directory="Profile 2"', 'Profile 21'), false);
  assert.equal(f('chrome.exe --profile-directory="Profile 21"', 'Profile 2'), false, 'Profile 2 must not match a Profile 21 command line');
  assert.equal(f('chrome.exe --user-data-dir="C:\\Users\\at\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 21"', 'Profile 21'), true, 'full profile path form');
  assert.equal(f('', 'Profile 21'), false);
  assert.equal(f(null, 'Profile 21'), false);
});

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
