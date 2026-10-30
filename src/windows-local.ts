// Independent Windows instance: no .env.local, daily harness configuration,
// production service, scheduled task or global Agent configuration is touched.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { initializeSQLite, backupSQLite } from './sqlite-storage.js';
import { startLocalMcpService } from './mcp-service.js';
import { workflowContract } from './workflow.generated.js';
import { assertCanonicalPrivatePath, assertPrivate, assertPrivateFileParent, makePrivateDirectory } from './private-paths.js';
import { openWindowsDesk } from './windows-browser.js';
import { connectWindowsMcpStdio } from './windows-mcp-stdio.js';

const root = process.env.WAYFINDER_WINDOWS_HOME ?? join(homedir(), '.wayfinder-windows');
const configPath = join(root, 'config.json'); const servicePath = join(root, 'service.json');
const keyPath = join(root, 'answer-desk-key');
const pipe = `\\\\.\\pipe\\wayfinder-local-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32)}`;
interface Config { schema: 'wayfinder-windows/1'; port: number; token: string }
const databasePath = join(root, 'data', 'maps.sqlite');
const newToken = () => randomBytes(32).toString('base64url');
function readPrivate(path: string) { assertPrivateFileParent(path); return JSON.parse(readFileSync(path, 'utf8')); }
function writePrivate(path: string, value: unknown, exclusive = false) {
  assertPrivateFileParent(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  assertPrivate(path, false);
}
function configuration(): Config {
  const c = readPrivate(configPath);
  if (c.schema !== 'wayfinder-windows/1' || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535
    || !/^[A-Za-z0-9_-]{43}$/.test(c.token)) throw Error('Invalid private Windows configuration');
  return c;
}
function control(action: 'status' | 'stop'): Promise<{ running: boolean; version?: string }> {
  if (!existsSync(servicePath)) return Promise.resolve({ running: false });
  const state = readPrivate(servicePath);
  return new Promise((resolve, reject) => {
    const socket = connect(pipe); let data = '';
    socket.setTimeout(30000, () => { socket.destroy(); reject(Error('Service control timed out')); });
    socket.once('connect', () => socket.write(JSON.stringify({ action, token: state.controlToken }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.length > 1024) socket.destroy(); });
    socket.once('end', () => { socket.end(); try { resolve(JSON.parse(data)); } catch { reject(Error('Service control failed')); } });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve({ running: false }); else reject(Error('Service control failed'));
    });
  });
}
async function serve(c: Config) {
  const controlToken = newToken(); let stopping = false; let service: Awaited<ReturnType<typeof startLocalMcpService>> | undefined;
  const server = createServer({ allowHalfOpen: true }, socket => {
    let data = ''; let handled = false; socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      data += chunk; if (data.length > 1024) { socket.destroy(); return; }
      if (handled || !data.endsWith('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(data);
        if (typeof request.token !== 'string' || request.token.length !== controlToken.length
          || !timingSafeEqual(Buffer.from(request.token), Buffer.from(controlToken)) || !['status', 'stop'].includes(request.action)) {
          socket.destroy(); return;
        }
        socket.setTimeout(0);
        if (request.action === 'stop') void stop().then(() => socket.end(JSON.stringify({ running: false })), () => socket.destroy());
        else socket.end(JSON.stringify({ running: !!service && !stopping, version: workflowContract.version }));
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
  });
  // A fixed per-root pipe prevents overlapping instances without killing PIDs
  // or trusting stale process IDs after a Windows restart.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  async function stop() {
    if (stopping) return;
    stopping = true;
    await service?.stop();
    try { if (readPrivate(servicePath).controlToken === controlToken) unlinkSync(servicePath); } catch { /* Stale state is harmless. */ }
    server.close();
    console.log('Wayfinder Windows stopped');
  }
  try {
    service = await startLocalMcpService({ databasePath, port: c.port, token: c.token, actorId: 'local-operator', clientId: 'Windows-MCP', answerDeskKeyPath: keyPath });
    writePrivate(servicePath, { controlToken });
    console.log(`Wayfinder Windows ready version=${workflowContract.version} http://127.0.0.1:${c.port}/`);
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  } catch (error) { await service?.stop(); server.close(); throw error; }
}

async function main() {
  if (process.platform !== 'win32' || process.versions.node !== '26.3.0') throw Error('Use Windows and Node.js 26.3.0');
  assertCanonicalPrivatePath(root);
  const [command, arg, ...extra] = process.argv.slice(2);
  if (command === undefined || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: npm run --silent windows -- init [port] | serve | status | stop | desk <mapId> | backup <fresh-absolute-file> | client-config | mcp-stdio');
    console.log('Independent instance: WAYFINDER_WINDOWS_HOME (default: user profile/.wayfinder-windows); see docs/windows.md'); return;
  }
  if (extra.length || !['init', 'serve', 'status', 'stop', 'desk', 'backup', 'client-config', 'mcp-stdio', '_desk'].includes(command ?? '')) {
    throw Error('Usage: windows-local init [port] | serve | status | stop | desk <mapId> | backup <fresh-absolute-file> | client-config | mcp-stdio');
  }
  if (!['init', 'desk', '_desk', 'backup'].includes(command!) && arg !== undefined) throw Error('Unexpected argument');
  if (command === 'init') {
    const port = arg === undefined ? 18876 : Number(arg);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Choose a port from 1024 through 65535');
    makePrivateDirectory(root);
    if (existsSync(configPath)) throw Error('Instance already initialized');
    initializeSQLite(databasePath);
    writePrivate(configPath, { schema: 'wayfinder-windows/1', port, token: newToken() }, true);
    console.log('Windows instance initialized; run serve, then client-config'); return;
  }
  const c = configuration();
  switch (command) {
    case 'serve': await serve(c); break;
    case 'mcp-stdio': await connectWindowsMcpStdio(c.port, c.token); break;
    case 'status': { const s = await control('status'); console.log(s.running ? `Wayfinder Windows running version=${s.version}` : 'Wayfinder Windows stopped'); break; }
    case 'stop': await control('stop'); console.log('Wayfinder Windows stopped'); break;
    case 'backup': if (!arg) throw Error('Fresh absolute backup destination required'); backupSQLite(databasePath, arg); console.log('SQLite backup completed'); break;
    case 'client-config':
      writePrivate(join(root, 'mcp-client.json'), { mcpServers: { wayfinder: { url: `http://127.0.0.1:${c.port}/mcp`, headers: { Authorization: `Bearer ${c.token}` } } } });
      console.log('Private mcp-client.json generated in WAYFINDER_WINDOWS_HOME; load it locally without printing its contents'); break;
    case 'desk':
      if (!arg || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(arg)) throw Error('Valid Map ID required');
      if (!(await control('status')).running) throw Error('Start this Windows instance first');
      {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_desk', arg], {
          env: process.env, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(Error('Browser handoff timed out')); }, 25000);
          child.once('message', message => { clearTimeout(timer); child.disconnect(); child.unref();
            if (message === 'ready') resolve(); else reject(Error('Browser handoff failed; install Chrome')); });
          child.once('error', () => { clearTimeout(timer); reject(Error('Browser helper failed')); });
          child.once('exit', () => { clearTimeout(timer); reject(Error('Browser handoff failed')); });
        });
        console.log(`Answer Desk opened http://127.0.0.1:${c.port}/maps/${arg}`);
      } break;
    case '_desk': {
      const browser = await openWindowsDesk({ port: c.port, mapId: arg!, keyPath, profile: join(root, 'browsers', newToken()) });
      process.send?.('ready'); await browser.closed; break;
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.send?.('failed');
    console.error('Wayfinder Windows command failed. Check the runtime, private NTFS path/ACL, initialization and port; see docs/windows.md.');
    process.exitCode = 1;
  });
}
