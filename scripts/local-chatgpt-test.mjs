import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { startLocalMcpService } from '../dist/mcp-service.js';
import { workflowContract } from '../dist/mcp-tools.js';
import { openSQLite } from '../dist/sqlite-storage.js';

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
const requestHeaders = [
  'accept', 'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version',
];
const responseHeaders = [
  'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version',
];

function backup() {
  const source = openSQLite(databasePath);
  try {
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const destination = join(dirname(databasePath), 'backups',
      `maps-${timestamp}-${randomBytes(4).toString('hex')}.sqlite`);
    source.backup(destination);
  } finally {
    source.close();
  }
  console.log('Consistent SQLite backup completed.');
}

async function attached() {
  const headers = {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  };
  try {
    const reply = await fetch(`http://127.0.0.1:${servicePort}/mcp`, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chatgpt-test-runner', version: '1' } },
    }) });
    const session = reply.headers.get('mcp-session-id');
    if (session) await fetch(`http://127.0.0.1:${servicePort}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } });
    return reply.ok;
  } catch { return false; }
}

if (attachToken !== undefined && !await attached()) {
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

const relay = createServer((incoming, outgoing) => {
  if (incoming.url !== '/mcp') {
    outgoing.writeHead(404).end();
    return;
  }
  if (!['POST', 'DELETE'].includes(incoming.method)) {
    outgoing.writeHead(405, { Allow: 'POST, DELETE' }).end();
    return;
  }
  if (incoming.headers.origin !== undefined) {
    outgoing.writeHead(403).end();
    return;
  }
  const headers = {
    host: `127.0.0.1:${servicePort}`,
    authorization: `Bearer ${token}`,
  };
  for (const name of requestHeaders) {
    if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
  }
  const upstream = httpRequest({
    hostname: '127.0.0.1', port: servicePort, path: '/mcp',
    method: incoming.method, headers,
  }, response => {
    const forwarded = {};
    for (const name of responseHeaders) {
      if (response.headers[name] !== undefined) forwarded[name] = response.headers[name];
    }
    outgoing.writeHead(response.statusCode ?? 502, forwarded);
    response.pipe(outgoing);
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502).end();
    else outgoing.destroy();
  });
  incoming.pipe(upstream);
});
relay.requestTimeout = 30_000;

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
