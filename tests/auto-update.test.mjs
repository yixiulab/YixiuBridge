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

test('compareSemver orders versions numerically, not lexicographically', () => {
  assert.equal(C.compareSemver('0.3.0', '0.2.0'), 1);
  assert.equal(C.compareSemver('0.2.0', '0.3.0'), -1);
  assert.equal(C.compareSemver('0.3.0', '0.3.0'), 0);
  assert.equal(C.compareSemver('0.10.0', '0.9.0'), 1, '10 > 9, not "1" < "9"');
  assert.equal(C.compareSemver('1.2.3', '1.2.10'), -1);
  assert.equal(C.compareSemver('0.3', '0.3.0'), 0, 'missing parts count as 0');
  assert.equal(C.compareSemver('0.3.1', '0.3'), 1);
});

test('shouldAutoReload fires only when the disk is strictly newer', () => {
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.0', null), true);
  assert.equal(C.shouldAutoReload('0.3.0', '0.3.0', null), false, 'same version: no reload');
  assert.equal(C.shouldAutoReload('0.3.0', '0.2.0', null), false, 'disk older: no reload');
  assert.equal(C.shouldAutoReload('0.3.0', null, null), false, 'no disk version (bridge down/old): no reload');
  assert.equal(C.shouldAutoReload('0.2.0', '', null), false, 'empty disk version: no reload');
});

test('shouldAutoReload never loops on a version it already reloaded for', () => {
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.0', '0.3.0'), false, 'already reloaded for 0.3.0');
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.1', '0.3.0'), true, 'a still-newer disk version reloads again');
  assert.equal(C.shouldAutoReload('0.2.0', '0.3.0', '0.2.0'), true, 'last reloaded was an older version');
});

test('constants carry the current version', () => {
  assert.equal(C.EXTENSION_VERSION, '0.3.0');
});
