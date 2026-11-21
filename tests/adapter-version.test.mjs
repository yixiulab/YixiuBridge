// YixiuBridge — adapter version self-check tests (Node native runner).
// Proves every ask/listModels result and error carries adapter_version,
// and that the version stamp stays in sync across the repo (adapter,
// manifest, package.json, shared constants). No real Chrome, no network.
//
// Background: on 2026-11-21 task -003 failed with the 0.2.0 send-button
// error text while the side panel showed 0.3.0 — the Gemini tab was still
// running the old adapter and nothing in the result said so. The stamp
// (v0.3.1) makes the next stale-tab failure self-diagnosing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createMockGeminiPage } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const Adapter = require('../kernel/adapters/gemini-web.js');

const FAST = { pollMs: 20, stableMs: 40, sendCheckMs: 10 };

test('adapter exposes ADAPTER_VERSION and it matches the release version everywhere', () => {
  assert.match(Adapter.ADAPTER_VERSION, /^\d+\.\d+\.\d+$/, 'ADAPTER_VERSION must be a semver string');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const constants = require('../kernel/shared/constants.js');
  const contentScript = fs.readFileSync(new URL('../extension/content/gemini-content.js', import.meta.url), 'utf8');
  const serviceWorker = fs.readFileSync(new URL('../extension/background/service-worker.js', import.meta.url), 'utf8');
  assert.equal(Adapter.ADAPTER_VERSION, pkg.version, 'adapter vs package.json');
  assert.equal(Adapter.ADAPTER_VERSION, manifest.version, 'adapter vs manifest');
  assert.equal(Adapter.ADAPTER_VERSION, constants.EXTENSION_VERSION, 'adapter vs shared constants');
  assert.ok(contentScript.includes("CONTENT_VERSION = '" + Adapter.ADAPTER_VERSION + "'"), 'content script version must match');
  assert.ok(serviceWorker.includes("VERSION = '" + Adapter.ADAPTER_VERSION + "'"), 'service worker version must match');
});

test('ask success carries adapter_version', async () => {
  const page = createMockGeminiPage({ chunks: ['4', ' is ', 'the answer.'], chunkMs: 10 });
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 5000 });
  const res = await adapter.ask('What is 2+2?');
  assert.equal(res.ok, true);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
});

test('ask failure (send button not found) carries adapter_version', async () => {
  const page = createMockGeminiPage();
  page.send.remove();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /send button not found/);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION,
    'the failure that bit us (-003) must name the adapter version that produced it');
});

test('ask failure (missing prompt box) carries adapter_version', async () => {
  const { FakeDocument } = await import('./fake-dom.mjs');
  const doc = new FakeDocument();
  const adapter = Adapter.createAdapter(doc, { win: {}, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello');
  assert.equal(res.ok, false);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
});

test('ask failure (locked model selected) carries adapter_version', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST, timeoutMs: 1000 });
  const res = await adapter.ask('hello', { model: 'Carbon' });
  assert.equal(res.ok, false);
  assert.match(res.error, /locked/);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
});

test('listModels success carries adapter_version', async () => {
  const page = createMockGeminiPage();
  const adapter = Adapter.createAdapter(page.doc, { win: page.win, ...FAST });
  const res = await adapter.listModels();
  assert.equal(res.ok, true);
  assert.equal(res.current, 'Neon');
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
});

test('listModels failure (no picker button) carries adapter_version', async () => {
  const { FakeDocument } = await import('./fake-dom.mjs');
  const doc = new FakeDocument();
  const adapter = Adapter.createAdapter(doc, { win: {}, ...FAST, timeoutMs: 1000 });
  const res = await adapter.listModels();
  assert.equal(res.ok, false);
  assert.match(res.error, /model picker button not found/);
  assert.equal(res.adapter_version, Adapter.ADAPTER_VERSION);
});
