#!/usr/bin/env node
// YixiuBridge — CLI.
//   install  write ~/.yixiubridge/config.json and print the MCP block
//   config   print the MCP JSON block for this machine
//   status   probe the bridge (is it up? which extensions are connected?)
//   bridge   run the local bridge server (foreground)
//   mcp      run the MCP stdio server (spawned by the AI client)
//   pair     open a 30-minute pairing window on the bridge
// Usage: node bin/yixiubridge.mjs <command>
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import C from '../kernel/shared/constants.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(homedir(), '.yixiubridge');
const BRIDGE_URL = process.env.YIXIUBRIDGE_BRIDGE_URL || C.BRIDGE_URL;

function mcpConfig() {
  return {
    mcpServers: {
      YixiuBridge: {
        command: 'node',
        args: [join(REPO_ROOT, 'host', 'mcp-server.mjs')],
        env: { YIXIUBRIDGE_BRIDGE_URL: BRIDGE_URL },
      },
    },
  };
}

async function cmdInstall() {
  await mkdir(DATA_DIR, { recursive: true });
  const cfg = mcpConfig();
  await writeFile(join(DATA_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
  console.log('Wrote ' + join(DATA_DIR, 'config.json'));
  console.log('');
  console.log('Merge this block into your MCP client config, then enable/trust it there:');
  console.log(JSON.stringify(cfg, null, 2));
  console.log('');
  console.log('Then load the extension in Chrome (chrome://extensions -> Developer mode ->');
  console.log('Load unpacked -> select ' + join(REPO_ROOT, 'extension') + '),');
  console.log('start the bridge with `node bin/yixiubridge.mjs bridge`, and copy the');
  console.log('connection prompt from the side panel to pair your AI.');
}

function cmdConfig() {
  console.log(JSON.stringify(mcpConfig(), null, 2));
}

async function cmdStatus() {
  try {
    const res = await fetch(BRIDGE_URL + '/status');
    const st = await res.json();
    console.log('bridge: ' + BRIDGE_URL + ' OK (v' + st.version + ')');
    console.log('extensions connected: ' + (st.extensions || []).map((e) => e.label + ' (' + e.id + ')').join(', ') || 'none');
    console.log('controller: ' + (st.controller || 'idle'));
    console.log('pairing window open: ' + (st.intakeOpen ? 'yes' : 'no'));
    console.log('tools: ' + (st.tools || []).join(', '));
  } catch (e) {
    console.log('bridge: NOT RUNNING at ' + BRIDGE_URL);
    console.log('start it with: node bin/yixiubridge.mjs bridge');
    process.exitCode = 1;
  }
}

async function cmdPair() {
  try {
    const res = await fetch(BRIDGE_URL + '/pair/start', { method: 'POST' });
    const data = await res.json();
    console.log('Pairing window open for 30 minutes (until ' + new Date(data.until).toLocaleTimeString() + ').');
    console.log('The first unknown AI to connect inside the window is trusted automatically.');
  } catch (e) {
    console.log('pair failed: bridge not running? Start it with: node bin/yixiubridge.mjs bridge');
    process.exitCode = 1;
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'install': await cmdInstall(); break;
    case 'config': cmdConfig(); break;
    case 'status': await cmdStatus(); break;
    case 'pair': await cmdPair(); break;
    case 'bridge': {
      const { createBridgeServer } = await import('../host/bridge-server.mjs');
      const b = await createBridgeServer({ port: C.BRIDGE_PORT, dataDir: DATA_DIR, repoRoot: REPO_ROOT });
      console.log('YixiuBridge bridge listening on http://127.0.0.1:' + b.port + ' (local only)');
      break;
    }
    case 'mcp': {
      const { runMcpServer } = await import('../host/mcp-server.mjs');
      await runMcpServer();
      break;
    }
    default:
      console.log('YixiuBridge v' + C.EXTENSION_VERSION);
      console.log('Usage: node bin/yixiubridge.mjs <install|config|status|bridge|mcp|pair>');
      process.exitCode = 2;
  }
}

main();
