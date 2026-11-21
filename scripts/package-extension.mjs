#!/usr/bin/env node
// YixiuBridge — package the extension for loading unpacked.
// The single source of truth for kernel files lives in code/kernel/.
// Chrome can only load files inside the extension directory, so this script
// copies kernel/shared, kernel/control and kernel/adapters into
// extension/kernel/ (build artifact, git-ignored). Run it before
// chrome://extensions -> Load unpacked, and after any kernel change.
// Usage: node scripts/package-extension.mjs
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'extension', 'kernel');

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });
for (const sub of ['shared', 'control', 'adapters']) {
  await cp(join(ROOT, 'kernel', sub), join(DEST, sub), { recursive: true });
}
console.log('extension packaged: kernel/ copied to extension/kernel/');
