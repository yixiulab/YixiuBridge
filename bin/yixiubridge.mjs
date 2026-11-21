#!/usr/bin/env node
// YixiuBridge — CLI.
//   install       write ~/.yixiubridge/config.json and print the MCP block
//   config        print the MCP JSON block for this machine
//   status        probe the bridge (is it up? which extensions are connected?)
//   bridge        run the local bridge server (foreground)
//   mcp           run the MCP stdio server (spawned by the AI client)
//   pair          open a 30-minute pairing window on the bridge
//   github-token  save a GitHub PAT once (hidden input) for the muse-runner
//   runner        run the muse-runner: poll GitHub tasks/pending, ask Gemini
// Usage: node bin/yixiubridge.mjs <command>
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import C from '../kernel/shared/constants.js';
import { loadConfig, saveConfig } from '../host/muse-runner.mjs';

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
  // Merge into the existing config (never clobber a saved github_token).
  const cfg = await saveConfig(DATA_DIR, mcpConfig());
  console.log('Wrote ' + join(DATA_DIR, 'config.json'));
  console.log('');
  console.log('Merge this block into your MCP client config, then enable/trust it there:');
  console.log(JSON.stringify(cfg.mcpServers, null, 2));
  console.log('');
  console.log('Then load the extension in Chrome (chrome://extensions -> Developer mode ->');
  console.log('Load unpacked -> select ' + join(REPO_ROOT, 'extension') + '),');
  console.log('start the bridge with `node bin/yixiubridge.mjs bridge`, and copy the');
  console.log('connection prompt from the side panel to pair your AI.');
}

// Read one line without echoing it (raw mode on TTY, plain line otherwise).
// The value is never printed. Ctrl-C exits without saving anything.
function readHiddenLine(promptText) {
  process.stdout.write(promptText);
  if (!process.stdin.isTTY) {
    return (async () => {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0].trim();
    })();
  }
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.exit(130); } // Ctrl-C
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
          continue;
        }
        buf += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

async function cmdGithubToken() {
  console.log('Create a classic Personal Access Token in GitHub:');
  console.log('  Settings -> Developer settings -> Personal access tokens -> Tokens (classic)');
  console.log('  -> Generate new token (classic), scope: repo.');
  console.log('Then paste it here. It is saved ONLY in ' + join(DATA_DIR, 'config.json'));
  console.log('(field github_token) and is never printed or sent anywhere except api.github.com.');
  const token = await readHiddenLine('Paste the token (hidden): ');
  if (!token || token.length < 20) {
    console.log('that does not look like a token — nothing saved.');
    process.exitCode = 1;
    return;
  }
  await saveConfig(DATA_DIR, { github_token: token });
  console.log('saved to ' + join(DATA_DIR, 'config.json') + ' (github_token field).');
  // Verify the token belongs to a GitHub account (best effort; the token
  // itself is never printed, including in error messages).
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'YixiuBridge/' + C.EXTENSION_VERSION,
      },
    });
    if (res.ok) {
      const u = await res.json();
      console.log('verified: token belongs to GitHub user "' + (u.login || '?') + '".');
    } else {
      console.log('warning: GitHub did not accept the token (HTTP ' + res.status + ') — check it and re-run this command if the runner fails.');
    }
  } catch (e) {
    console.log('warning: could not reach api.github.com to verify (' + e.message + ') — token saved anyway.');
  }
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
    case 'github-token': await cmdGithubToken(); break;
    case 'runner': {
      const { runRunner } = await import('../host/muse-runner.mjs');
      const arg = process.argv.find((a) => a.startsWith('--interval='));
      const idx = process.argv.indexOf('--interval');
      let intervalS;
      if (arg) intervalS = parseInt(arg.slice('--interval='.length), 10);
      else if (idx !== -1 && process.argv[idx + 1]) intervalS = parseInt(process.argv[idx + 1], 10);
      try {
        await runRunner({ dataDir: DATA_DIR, intervalS });
      } catch (e) {
        console.error('muse-runner failed to start: ' + (e && e.message ? e.message : String(e)));
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.log('YixiuBridge v' + C.EXTENSION_VERSION);
      console.log('Usage: node bin/yixiubridge.mjs <install|config|status|bridge|mcp|pair|github-token|runner [--interval <seconds>]');
      process.exitCode = 2;
  }
}

main();
