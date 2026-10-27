import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLocalChatGptRelay } from './local-chatgpt-relay.mjs';
import { acceptsLocalChatGptToken } from './local-chatgpt-attach.mjs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { startLocalMcpService } from '../dist/mcp-service.js';
import { workflowContract } from '../dist/mcp-tools.js';
import { backupSQLite } from '../dist/sqlite-storage.js';

// Foreground, operator-started test connection. The database is an existing
// private SQLite file; this program never initializes or substitutes one.
const databasePath = process.env.WAYFINDER_DATABASE_PATH;
if (!databasePath || !isAbsolute(databasePath)) {
  console.error('Set WAYFINDER_DATABASE_PATH to the existing absolute SQLite path.');
  process.exit(1);
}

const relayPort = 18765;
const servicePort = 18766;
const backupEveryMs = 30 * 60 * 1000;
const tunnelConfig = join(homedir(), '.cloudflared', 'config.yml');
// With WAYFINDER_ATTACH_TOKEN the runner relays to the service already running on
// the service port (started by the wayfinder launcher), which authors this
// token's writes under its own Client ID; otherwise it starts and owns one.
const attachToken = process.env.WAYFINDER_ATTACH_TOKEN;
if (attachToken !== undefined && !/^[A-Za-z0-9._~-]{32,256}$/.test(attachToken)) {
  console.error('WAYFINDER_ATTACH_TOKEN is not a valid local token.');
  process.exit(1);
}
const token = attachToken ?? randomBytes(48).toString('hex');

function backup() {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const destination = join(dirname(databasePath), 'backups',
    `maps-${timestamp}-${randomBytes(4).toString('hex')}.sqlite`);
  // Attach mode may back up an older running service: never migrate its source.
  backupSQLite(databasePath, destination);
  console.log('Consistent SQLite backup completed.');
}

if (attachToken !== undefined && !await acceptsLocalChatGptToken(servicePort, token)) {
  console.error('No running local service accepted the attach token; start it with `wayfinder serve`.');
  process.exit(1);
}
const service = attachToken !== undefined ? undefined : await startLocalMcpService({
  databasePath,
  port: servicePort,
  token,
  actorId: 'ChatGPT-Test-Operator',
  clientId: 'ChatGPT-Test',
  allowedOrigins: [],
  // ChatGPT shows its model the tool definitions, never the server instructions.
  toolsOnly: true,
});

try {
  // Refuse to publish the relay when the first backup cannot be confirmed.
  backup();
} catch {
  await service?.stop();
  console.error('Initial backup failed; the public test connection was not started.');
  process.exit(1);
}

const relay = createLocalChatGptRelay(servicePort, token);

try {
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(relayPort, '127.0.0.1', () => {
      relay.removeListener('error', reject);
      resolve();
    });
  });
} catch {
  await service?.stop();
  console.error('Local relay could not listen; the existing session may still be running.');
  process.exit(1);
}

let stopping = false;
let tunnel;
let reconnectTimer;
let reconnectDelayMs = 1000;
const backupTimer = setInterval(() => {
  try { backup(); }
  catch { console.error('Scheduled SQLite backup failed; check free space and storage permissions.'); }
}, backupEveryMs);

function startTunnel() {
  if (stopping) return;
  const startedAt = Date.now();
  tunnel = spawn('/opt/homebrew/bin/cloudflared', [
    'tunnel', '--config', tunnelConfig, 'run', 'opencode',
  ], { stdio: 'ignore' });
  let failed = false;
  const reconnect = () => {
    if (failed || stopping) return;
    failed = true;
    if (Date.now() - startedAt > 60_000) reconnectDelayMs = 1000;
    console.error(`Cloudflare connection exited; retrying in ${reconnectDelayMs / 1000}s.`);
    reconnectTimer = setTimeout(startTunnel, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  };
  tunnel.once('error', reconnect);
  tunnel.once('exit', reconnect);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(backupTimer);
  clearTimeout(reconnectTimer);
  if (tunnel && tunnel.exitCode === null) tunnel.kill('SIGTERM');
  try {
    await new Promise(resolve => relay.close(resolve));
    await service?.stop();
    backup();
  } catch {
    process.exitCode = 1;
    console.error('Shutdown or final backup failed; inspect storage before the next session.');
  }
  console.log('Local ChatGPT test session stopped.');
}

process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.once('SIGHUP', () => { void stop(); });
startTunnel();
console.log(`Local ChatGPT test session running; version=${workflowContract.version}; press Ctrl-C to stop.`);
if (service === undefined) console.log('Attached to the running local service; stopping this session leaves that service running.');
console.log('This on-demand Cloudflare endpoint has no user authentication; close it when not testing.');
