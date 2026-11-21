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

  var EXTENSION_ID = 'alcjfcjfkhfacgofhgoenljfenbcgcel';

  // Is this a Chrome profile directory name? 'Default' or 'Profile <n>'.
  // Anything else (e.g. 'System Profile', 'Guest Profile') is not a
  // user profile and is never scanned.
  function isProfileDirName(name) {
    if (name === 'Default') return true;
    return /^Profile \d+$/.test(name);
  }

  // Parse a preferences-format JSON text (Secure Preferences or the
  // regular Preferences file — same schema) and return its
  // extensions.settings object, or null when the text is unparsable or
  // has no settings object. Never throws.
  function settingsObject(prefsText) {
    if (typeof prefsText !== 'string') return null;
    try {
      var prefs = JSON.parse(prefsText);
      var settings = prefs && prefs.extensions && prefs.extensions.settings;
      if (settings && typeof settings === 'object') return settings;
    } catch (e) { /* unparsable: no settings object */ }
    return null;
  }

  // CONFIRMED match: the extension ID is an OWN KEY of
  // extensions.settings in this file — a live install record.
  // This is the only match that counts as certain. A bare substring
  // search is NOT enough: Chrome also keeps the ID as a key in
  // protection/macs/extensions/settings (and .../settings_encrypted_hash)
  // — integrity hashes for the settings entry — and those MAC entries
  // can OUTLIVE the install record itself (a profile that once had the
  // extension, or still has its MACs, matches a substring search while
  // having no live record). Verified 2026-11-21 from the user's real
  // Profile 21 Secure Preferences file: the ID appears 3 times — once
  // as the settings key, twice as a protection-MAC key. So a profile
  // whose settings entry was removed still contains the ID twice.
  function settingsHasId(prefsText) {
    var settings = settingsObject(prefsText);
    return settings !== null
      && Object.prototype.hasOwnProperty.call(settings, EXTENSION_ID);
  }

  // Unconfirmed substring presence: the ID appears somewhere in the text
  // (settings key, protection MACs, or anywhere else). Useful only as a
  // weak hint — never as proof of a live install.
  function textHasId(prefsText) {
    return typeof prefsText === 'string' && prefsText.indexOf(EXTENSION_ID) !== -1;
  }

  // Full match status for one profile's evidence.
  // evidence: { securePrefsText, prefsText, localExtSettingsExists }.
  // Returns { confirmed, unconfirmed, evidence } where evidence lists the
  // signals that fired in priority order; a file signal whose ID is only
  // a substring (not a settings key) is marked ' (unconfirmed)'.
  // - confirmed: the ID is a settings key in Secure Preferences or in
  //   Preferences, OR the profile has a Local Extension Settings/<id>
  //   directory (the extension ran there and used local storage — a
  //   directory literally named by the ID can only exist if it did).
  // - unconfirmed: no confirmed signal, but the ID appears as a substring
  //   in one of the files (e.g. stale protection MACs after the install
  //   record was removed).
  function profileExtensionStatus(evidence) {
    var out = { confirmed: false, unconfirmed: false, evidence: [] };
    if (!evidence) return out;
    var secureConfirmed = settingsHasId(evidence.securePrefsText);
    var prefsConfirmed = settingsHasId(evidence.prefsText);
    var secureText = textHasId(evidence.securePrefsText);
    var prefsText = textHasId(evidence.prefsText);
    var les = !!evidence.localExtSettingsExists;
    if (secureConfirmed) out.evidence.push('Secure Preferences');
    else if (secureText) out.evidence.push('Secure Preferences (unconfirmed)');
    if (les) out.evidence.push('Local Extension Settings');
    if (prefsConfirmed) out.evidence.push('Preferences');
    else if (prefsText) out.evidence.push('Preferences (unconfirmed)');
    out.confirmed = secureConfirmed || prefsConfirmed || les;
    out.unconfirmed = !out.confirmed && (secureText || prefsText);
    return out;
  }

  // Does this profile show evidence of the extension? Any signal counts
  // (confirmed or unconfirmed) — callers that need certainty must use
  // profileExtensionStatus().confirmed instead.
  // Signals, in priority order:
  // (1) the extension ID is a settings key in the profile's Secure
  //     Preferences — the PRIMARY signal: Chrome records extension
  //     installs under extensions.settings.<id> (with a `location` and
  //     a `path` field) in Secure Preferences, NOT in the regular
  //     Preferences file. Verified 2026-11-21 from the user's real
  //     Profile 21 Secure Preferences file: the record IS there
  //     (location 4, path C:\software\myself\YixiuBridge-main\extension,
  //     from_webstore False, service worker 0.3.2) — and the user's real
  //     Profile 21 Preferences file (90 KB JSON) has NO
  //     extensions.settings key at all. The 0.3.2 switch to Preferences
  //     as primary was WRONG. And the 0.3.1 scan matching 0 of 72
  //     profiles is now SOLVED too: every scan searched for a
  //     33-character ID (alcjfcjfkfhfacgofhgoenljfenbcgcel — an extra
  //     'f', misread from a chrome://extensions screenshot). A real
  //     Chrome extension ID is always exactly 32 characters, so that
  //     string could never match anything. The correct ID is
  //     alcjfcjfkhfacgofhgoenljfenbcgcel (32 chars, a-p only) — see the
  //     regression test in tests/auto-update.test.mjs.
  // (2) the profile has a "Local Extension Settings/<id>" directory
  //     (the extension has used local storage there) — backup evidence;
  // (3) the ID appears in the regular Preferences text — a WEAK signal,
  //     kept only because some Chromium-based browsers (Brave, Chromium
  //     itself) record extensions there instead of in Secure Preferences.
  //     On Google Chrome it never fires (verified above) and is harmless.
  // (4) v0.3.5: a substring-only hit in Secure Preferences is NOT a
  //     confirmed match (see settingsHasId): the ID also lives in
  //     protection/macs, which can outlive the install record.
  function profileHasExtension(evidence) {
    var st = profileExtensionStatus(evidence);
    return st.confirmed || st.unconfirmed;
  }

  // Which evidence matched, in priority order. [] when nothing matched.
  // A substring-only file signal is marked ' (unconfirmed)' so the next
  // failure is self-diagnosing from the output alone. The PowerShell
  // script prints this for the chosen profile.
  function matchedEvidence(evidence) {
    return profileExtensionStatus(evidence).evidence;
  }

  // Find the object starting at the '{' at index `open` and return the
  // index just past its matching '}' (strings and escapes respected), or
  // -1 when the braces never balance. Used by the regex fallback so a
  // "path" search never crosses an entry boundary.
  function matchingBraceEnd(text, open) {
    var depth = 0;
    var inStr = false;
    var esc = false;
    for (var i = open; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
    }
    return -1;
  }

  // Anchored regex fallback for extensionPathFromPrefs: the preferences
  // text would not parse as JSON, so locate the ID's own settings entry
  // — the occurrence of "<id>" followed by ':' and '{' — and search for
  // "path" ONLY inside that entry's braces. Returns the path string or
  // null. Never returns another entry's path: an entry without a "path"
  // yields null even when the next entry has one.
  function extensionPathFromEntryRegex(prefsText) {
    var needle = '"' + EXTENSION_ID + '"';
    var from = 0;
    while (true) {
      var idIdx = prefsText.indexOf(needle, from);
      if (idIdx === -1) return null;
      var j = idIdx + needle.length;
      while (j < prefsText.length && /\s/.test(prefsText[j])) j++;
      if (prefsText[j] !== ':') { from = idIdx + needle.length; continue; }
      j++;
      while (j < prefsText.length && /\s/.test(prefsText[j])) j++;
      if (prefsText[j] !== '{') { from = idIdx + needle.length; continue; }
      var end = matchingBraceEnd(prefsText, j);
      if (end === -1) return null;
      var entryText = prefsText.slice(j, end);
      var m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(entryText);
      if (!m) return null;
      try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
    }
  }

  // The folder Chrome actually loads the unpacked extension from, read
  // from the profile's preferences-format JSON text:
  // extensions.settings.<id>.path (present for location 4 / unpacked).
  // Callers pass the Secure Preferences text first (primary — that is
  // where Chrome records installs) and the regular Preferences text as a
  // fallback; the schema is the same in both files. Returns the path
  // string, or null when absent / unparsable / the ID has no path in its
  // OWN entry. Never throws, and never returns another extension's path
  // (v0.3.5: the old unanchored regex — ID followed by up to 5000 chars
  // then the first "path" — could span entry boundaries and return a
  // neighbouring entry's path, e.g. Chrome's built-in
  // network_speech_synthesis/mv3, when the ID's own entry had no path
  // or the file did not parse).
  function extensionPathFromPrefs(prefsText) {
    if (typeof prefsText !== 'string' || prefsText.indexOf(EXTENSION_ID) === -1) return null;
    try {
      var prefs = JSON.parse(prefsText);
      var settings = prefs && prefs.extensions && prefs.extensions.settings;
      if (settings && typeof settings === 'object') {
        // Parsed authoritatively: the settings object is the whole truth.
        // No entry for this ID, or an entry without a path, means null —
        // the ID's other occurrences (protection MACs) are not installs.
        var entry = settings[EXTENSION_ID];
        if (entry && typeof entry.path === 'string' && entry.path) return entry.path;
        return null;
      }
      // Parsed but no settings object at all: fall through to the
      // anchored regex (a Preferences file with a different shape).
    } catch (e) { /* unparsable: anchored regex below */ }
    return extensionPathFromEntryRegex(prefsText);
  }

  // Escape a string for use inside a RegExp.
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Does this chrome.exe command line show the given profile directory?
  // The browser process only carries --profile-directory when it was
  // ORIGINALLY launched with that flag: when Chrome is already running,
  // a new profile window opens by handoff / the in-Chrome profile
  // switcher and no running process carries the flag at all — that is
  // why the v0.3.1–v0.3.4 exact-match check (`--profile-directory="X"`)
  // never fired on the user's machine (0.3.3 also picked Profile 21 by
  // mtime luck, not by "running"). This helper is therefore tolerant —
  // flag with '=' or a space, quotes optional, and a path-segment form
  // (--user-data-dir=...\Profile 21) — but a missing flag still means
  // "not detected", never "not running": callers must not treat a
  // no-match here as proof the profile is idle. The dir name is matched
  // with a boundary (quote / whitespace / slash / end) so 'Profile 2'
  // never matches a 'Profile 21' command line.
  function profileDirInCommandLine(cmdline, profileDir) {
    if (typeof cmdline !== 'string' || !cmdline || !profileDir) return false;
    var dir = escapeRegExp(profileDir);
    var flagRe = new RegExp('--profile-directory\\s*=?\\s*"?'+ dir + '(?=["\\s]|$)', 'i');
    if (flagRe.test(cmdline)) return true;
    var pathRe = new RegExp('[\\\\/]' + dir + '(?=[\\\\/"\\s]|$)', 'i');
    return pathRe.test(cmdline);
  }

  // Pick which matched profile to open.
  // profiles: [{ exe, profileDir, userData, modifiedMs, confirmed,
  //   loadedPath, evidence }] — modifiedMs is the Preferences mtime in
  //   ms, or null when unknown; confirmed defaults to true when absent
  //   (older callers); loadedPath defaults to null.
  // runningProfileDirs: profile dir names with a running chrome.exe
  //   process (tolerant command-line match — see
  //   profileDirInCommandLine; a missing flag means "not detected").
  // cachedProfileDir: last chosen dir (tiebreak hint only), may be null.
  // opts: { installExtDir } — the extension folder the updater maintains
  //   (e.g. C:\software\myself\YixiuBridge-main\extension); a profile
  //   whose loaded path equals it (case-insensitive, Windows paths) is
  //   loading OUR copy and outranks a merely-recently-modified profile.
  // Returns { chosen, why, running, confirmed } or null when there is
  // nothing to open.
  // Rules (same order as the PowerShell script):
  //   (a) prefer a CONFIRMED profile with a running process (first in
  //       input order when several are running);
  //   (b) otherwise a CONFIRMED profile whose loaded path is the
  //       updater's install dir (it loads the copy we maintain);
  //   (c) otherwise the CONFIRMED profile whose Preferences was most
  //       recently modified (unknown mtime counts as oldest);
  //   (d) on an exact mtime tie, the cached profile wins when it is one
  //       of the tied profiles;
  //   (e) when there is NO confirmed match at all, the same order
  //       applies to unconfirmed matches, and the result is flagged
  //       confirmed:false so the caller can say so out loud.
  // It NEVER falls back to a profile that is not in `profiles`: an empty
  // input returns null, and a cached dir that is not listed is ignored.
  // v0.3.5: the old order (running, then mtime) picked the WRONG profile
  // on the real machine (2026-11-21: 2 matches, Profile 18 won on
  // "Preferences 最近修改过" because the running check never fires —
  // see profileDirInCommandLine — and Profile 18's match was only a
  // substring hit in stale protection MACs). Confirmed-first plus the
  // loads-our-copy tiebreak fix both halves: Profile 21 is confirmed
  // AND loads the maintained copy, Profile 18 is neither.
  function selectChromeProfile(profiles, runningProfileDirs, cachedProfileDir, opts) {
    if (!profiles || profiles.length === 0) return null;
    var installExtDir = opts && opts.installExtDir ? String(opts.installExtDir).toLowerCase() : null;
    function isConfirmed(p) {
      return p.confirmed === undefined || p.confirmed === null ? true : !!p.confirmed;
    }
    function loadsOurCopy(p) {
      return !!installExtDir && typeof p.loadedPath === 'string' && p.loadedPath
        && p.loadedPath.toLowerCase() === installExtDir;
    }
    function modMs(p) {
      return (p.modifiedMs === null || p.modifiedMs === undefined) ? -Infinity : p.modifiedMs;
    }
    function pickFrom(pool, confirmedFlag) {
      if (!pool || pool.length === 0) return null;
      var runningSet = {};
      (runningProfileDirs || []).forEach(function (d) { runningSet[d] = true; });
      var running = [];
      pool.forEach(function (p) { if (runningSet[p.profileDir]) running.push(p); });
      if (running.length > 0) {
        return {
          chosen: running[0],
          why: running.length > 1 ? 'running-multiple' : 'running',
          running: true,
          confirmed: confirmedFlag,
        };
      }
      var ours = pool.filter(loadsOurCopy);
      if (ours.length > 0) {
        var oursSorted = ours.slice().sort(function (a, b) { return modMs(b) - modMs(a); });
        return {
          chosen: oursSorted[0],
          why: 'loads-our-copy',
          running: false,
          confirmed: confirmedFlag,
        };
      }
      var sorted = pool.slice().sort(function (a, b) { return modMs(b) - modMs(a); });
      var top = sorted[0];
      if (sorted.length > 1 && modMs(sorted[0]) === modMs(sorted[1]) && cachedProfileDir) {
        for (var i = 0; i < sorted.length; i++) {
          if (sorted[i].profileDir === cachedProfileDir) {
            return { chosen: sorted[i], why: 'tie-cached', running: false, confirmed: confirmedFlag };
          }
        }
      }
      return { chosen: top, why: 'recently-modified', running: false, confirmed: confirmedFlag };
    }
    var confirmedPool = profiles.filter(isConfirmed);
    var picked = pickFrom(confirmedPool, true);
    if (picked) return picked;
    var unconfirmedPool = profiles.filter(function (p) { return !isConfirmed(p); });
    return pickFrom(unconfirmedPool, false);
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
    settingsObject: settingsObject,
    settingsHasId: settingsHasId,
    textHasId: textHasId,
    profileExtensionStatus: profileExtensionStatus,
    profileHasExtension: profileHasExtension,
    matchedEvidence: matchedEvidence,
    extensionPathFromPrefs: extensionPathFromPrefs,
    extensionPathFromEntryRegex: extensionPathFromEntryRegex,
    profileDirInCommandLine: profileDirInCommandLine,
    selectChromeProfile: selectChromeProfile,
    needsSelfUpdate: needsSelfUpdate,
  };
});
