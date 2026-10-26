// One isolated Wayfinder service per Attempt: a new database, a free port, the Controller's credential and one
// credential per session, run from this checkout's build. Never the everyday service or its database (R2).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const checkoutRoot = fileURLToPath(new URL('../../../', import.meta.url));
const observer = fileURLToPath(new URL('./protocol-observer.mjs', import.meta.url));
/** The everyday service and the ChatGPT relay in front of it. */
export const everydayPort = 18766;
export const reservedPorts = [18765, everydayPort];

export interface Credential { clientId: string; token: string }
export const newToken = () => randomBytes(32).toString('hex');

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    if (port && !reservedPorts.includes(port)) return port;
  }
}

export interface IsolatedService {
  port: number;
  pid: number;
  databasePath: string;
  /** Initialize results the service sent, one JSON line per MCP session (instructions, version, capabilities). */
  protocolReport: string;
  logs(): string;
  /** SIGTERM, then SIGKILL if the service has not exited after 10 s. */
  stop(): Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Start the service in `dir` (created, private). Every run credential, including the Controller, goes into
 * the credentials file as a digest, so each Revision names its writer. The service runs in its own process group, so a Ctrl-C to the runner reaches it only through `stop()`, after the
 * evidence has been read.
 */
export async function startService(dir: string, controller: Credential, others: Credential[]): Promise<IsolatedService> {
  mkdirSync(join(dir, 'db'), { recursive: true, mode: 0o700 });
  const databasePath = join(dir, 'db', 'maps.sqlite');
  const { initializeSQLite } = await import(pathToFileURL(join(checkoutRoot, 'dist/sqlite-storage.js')).href) as { initializeSQLite(path: string): unknown };
  await initializeSQLite(databasePath);
  const credentialsPath = join(dir, 'credentials.json');
  writeFileSync(credentialsPath, JSON.stringify({ credentials: [controller, ...others].map(c => ({ clientId: c.clientId,
    tokenSha256: createHash('sha256').update(c.token).digest('hex') })) }), { mode: 0o600 });
  const protocolReport = join(dir, 'protocol.jsonl');
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', observer, fileURLToPath(new URL('./service-process.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', WAYFINDER_DATABASE_PATH: databasePath, WAYFINDER_PORT: String(port),
      WAYFINDER_ACTOR_ID: 'behaviour-runner', WAYFINDER_CLIENT_ID: 'Behaviour.UnusedPrimary', WAYFINDER_ALLOWED_ORIGINS: '[]',
      WAYFINDER_CREDENTIALS_FILE: credentialsPath, WAYFINDER_PROTOCOL_REPORT: protocolReport },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let logs = '';
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      void exit.then(() => clearTimeout(timer));
    }
    return exit;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('service did not become ready in 20 s')), 20_000);
      child.stdout.on('data', (data: Buffer) => { logs += data; if (logs.includes('Wayfinder local MCP ready')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (data: Buffer) => { logs += data; });
      void exit.then(({ code }) => { clearTimeout(timer); reject(new Error(`service exited during startup (${code}): ${logs.trim()}`)); });
    });
  } catch (error) { await stop(); throw error; }
  return { port, pid: child.pid!, databasePath, protocolReport, logs: () => logs, stop };
}

/** Preserve the only history copy when export fails; temporary credentials never survive cleanup. */
export function cleanupServiceDirectory(dir: string, historyExported: boolean): { removed: boolean; retained: string | null } {
  rmSync(join(dir, 'credentials.json'), { force: true });
  if (historyExported) rmSync(dir, { recursive: true, force: true });
  return { removed: !existsSync(dir), retained: !historyExported && existsSync(join(dir, 'db', 'maps.sqlite')) ? join(dir, 'db', 'maps.sqlite') : null };
}
