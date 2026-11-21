// YixiuBridge — Chrome profile discovery decisions (testable reference).
// The Windows one-click script (scripts/update-and-start.ps1) implements
// the same rules in PowerShell; this module is the pure, testable version
// of the decision logic (no filesystem, no processes, no network).
// It exists because the PowerShell script cannot run in this Linux dev
// environment, yet the selection rules must never misfire: opening the
// wrong Chrome profile (or none) is the failure the user actually sees.
// UMD: works as an ES module import, a Node require, or a plain <script> global.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.YixiuBridgeChromeDiscovery = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EXTENSION_ID = 'alcjfcjfkfhfacgofhgoenljfenbcgcel';

  // Is this a Chrome profile directory name? 'Default' or 'Profile <n>'.
  // Anything else (e.g. 'System Profile', 'Guest Profile') is not a
  // user profile and is never scanned.
  function isProfileDirName(name) {
    if (name === 'Default') return true;
    return /^Profile \d+$/.test(name);
  }

  // Does this profile show evidence of the extension? Any one of three
  // signals counts as a match:
  // (1) the extension ID appears in the profile's regular Preferences
  //     text — the PRIMARY signal for an unpacked (developer-mode)
  //     extension: Chrome records it under extensions.settings.<id>
  //     (location 4, with a `path` field) in Preferences, NOT in Secure
  //     Preferences. Ground truth 2026-11-21: Profile 21's Secure
  //     Preferences has no trace of the ID although the extension is
  //     loaded there — the 0.3.1 scan matched 0 of 72 profiles because
  //     it only looked at Secure Preferences.
  // (2) the ID appears in Secure Preferences text (store-installed
  //     extensions land there);
  // (3) the profile has a "Local Extension Settings/<id>" directory
  //     (the extension has used local storage there).
  function profileHasExtension(evidence) {
    if (!evidence) return false;
    if (evidence.localExtSettingsExists) return true;
    var text = evidence.prefsText;
    if (typeof text === 'string' && text.indexOf(EXTENSION_ID) !== -1) return true;
    var secure = evidence.securePrefsText;
    if (typeof secure === 'string' && secure.indexOf(EXTENSION_ID) !== -1) return true;
    return false;
  }

  // Which evidence matched, in priority order. [] when nothing matched.
  // The PowerShell script prints this for the chosen profile so the next
  // failure is self-diagnosing from the output alone.
  function matchedEvidence(evidence) {
    var out = [];
    if (!evidence) return out;
    var text = evidence.prefsText;
    if (typeof text === 'string' && text.indexOf(EXTENSION_ID) !== -1) out.push('Preferences');
    var secure = evidence.securePrefsText;
    if (typeof secure === 'string' && secure.indexOf(EXTENSION_ID) !== -1) out.push('Secure Preferences');
    if (evidence.localExtSettingsExists) out.push('Local Extension Settings');
    return out;
  }

  // The folder Chrome actually loads the unpacked extension from, read
  // from the profile's Preferences JSON:
  // extensions.settings.<id>.path (present for location 4 / unpacked).
  // Returns the path string, or null when absent / unparsable / the ID
  // is not in the text at all. Never throws.
  function extensionPathFromPrefs(prefsText) {
    if (typeof prefsText !== 'string' || prefsText.indexOf(EXTENSION_ID) === -1) return null;
    try {
      var prefs = JSON.parse(prefsText);
      var settings = prefs && prefs.extensions && prefs.extensions.settings;
      var entry = settings && settings[EXTENSION_ID];
      if (entry && typeof entry.path === 'string' && entry.path) return entry.path;
    } catch (e) { /* unparsable Preferences: no path */ }
    return null;
  }

  // Pick which matched profile to open.
  // profiles: [{ exe, profileDir, userData, modifiedMs }] — modifiedMs is
  //   the Preferences mtime in ms, or null when unknown.
  // runningProfileDirs: profile dir names with a running chrome.exe process.
  // cachedProfileDir: last chosen dir (tiebreak hint only), may be null.
  // Returns { chosen, why, running } or null when there is nothing to open.
  // Rules (same order as the PowerShell script):
  //   (a) prefer a matched profile with a running process (first in input
  //       order when several are running);
  //   (b) otherwise the matched profile whose Preferences was most
  //       recently modified (unknown mtime counts as oldest);
  //   (c) on an exact mtime tie, the cached profile wins when it is one of
  //       the tied profiles.
  // It NEVER falls back to a profile that is not in `profiles`: an empty
  // input returns null, and a cached dir that is not listed is ignored.
  function selectChromeProfile(profiles, runningProfileDirs, cachedProfileDir) {
    if (!profiles || profiles.length === 0) return null;
    var runningSet = {};
    (runningProfileDirs || []).forEach(function (d) { runningSet[d] = true; });
    var running = [];
    profiles.forEach(function (p) { if (runningSet[p.profileDir]) running.push(p); });
    if (running.length > 0) {
      return {
        chosen: running[0],
        why: running.length > 1 ? 'running-multiple' : 'running',
        running: true,
      };
    }
    function modMs(p) {
      return (p.modifiedMs === null || p.modifiedMs === undefined) ? -Infinity : p.modifiedMs;
    }
    var sorted = profiles.slice().sort(function (a, b) { return modMs(b) - modMs(a); });
    var top = sorted[0];
    if (sorted.length > 1 && modMs(sorted[0]) === modMs(sorted[1]) && cachedProfileDir) {
      for (var i = 0; i < sorted.length; i++) {
        if (sorted[i].profileDir === cachedProfileDir) {
          return { chosen: sorted[i], why: 'tie-cached', running: false };
        }
      }
    }
    return { chosen: top, why: 'recently-modified', running: false };
  }

  // Should the running updater hand off to a newer script on disk?
  // True only when both hashes are present and different (case-insensitive).
  // Same hash, or a missing hash, means: keep running the current copy.
  function needsSelfUpdate(runningHash, diskHash) {
    if (!runningHash || !diskHash) return false;
    return String(runningHash).toLowerCase() !== String(diskHash).toLowerCase();
  }

  return {
    EXTENSION_ID: EXTENSION_ID,
    isProfileDirName: isProfileDirName,
    profileHasExtension: profileHasExtension,
    matchedEvidence: matchedEvidence,
    extensionPathFromPrefs: extensionPathFromPrefs,
    selectChromeProfile: selectChromeProfile,
    needsSelfUpdate: needsSelfUpdate,
  };
});
