// Exclusive, foreground use of the existing opencode tunnel. Only cloudflared reads its credentials.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface TunnelConfig { id: string; credentialsFile: string }

/** Deliberately supports only the two scalar settings needed here, never loads a credential file or YAML tags. */
export function readTunnelConfig(path: string): TunnelConfig {
  const text = readFileSync(path, 'utf8');
  const scalar = (key: string) => {
    const matches = [...text.matchAll(new RegExp(`^${key}:\\s*(.+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Tunnel config needs one scalar ${key}`);
    const raw = matches[0]![1]!.trim();
    const value = raw.startsWith('"') ? JSON.parse(raw) as unknown : raw.startsWith("'") ? /^'([^']+)'$/.exec(raw)?.[1] : raw;
    if (typeof value !== 'string' || /[\n\r#{}\[\]&*!]/.test(value)) throw new Error(`Unsupported ${key} scalar`);
    return value;
  };
  const id = scalar('tunnel');
  const credentialsFile = scalar('credentials-file');
  if (!uuid.test(id) || !isAbsolute(credentialsFile)) throw new Error('Use a tunnel UUID and an absolute credentials-file path');
  return { id, credentialsFile };
}

// Do not inherit TUNNEL_TOKEN, TUNNEL_URL or other routing/authentication overrides.
const childEnv = () => ({ PATH: process.env.PATH ?? '', HOME: homedir() });

export function hasLocalConnector(stdout: string, ownPid?: number): boolean {
  return stdout.split('\n').some(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === ownPid) return false;
    const command = match[2]!;
    return /(?:^|\/)cloudflared\s+.*\btunnel\b.*\brun\b/.test(command)
      || /(?:^|\s|\/)node(?:\s+[^\n]*?)?\s+(?:[^\s]*\/)?scripts\/local-chatgpt-test\.mjs(?:\s|$)/.test(command);
  });
}
export async function assertNoLocalConnector(ownPid?: number) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,command='], { timeout: 5000 });
  // Never print process command lines: another process can carry a secret in argv.
  if (hasLocalConnector(stdout, ownPid)) throw new Error('Another local tunnel connector or daily ChatGPT runner is active; ask its operator to stop it');
}

/** Unknown remote state fails closed; pending reconnects also count as occupied. */
export function connectorsFrom(text: string, id: string): string[] {
  const info = JSON.parse(text) as { id?: unknown; name?: unknown; conns?: { id?: unknown; conns?: unknown }[] | null };
  if (info.id !== id || info.name !== 'opencode' || !(info.conns === null || Array.isArray(info.conns)))
    throw new Error('Cannot confirm the opencode tunnel identity and connectors');
  const ids: string[] = [];
  for (const c of info.conns ?? []) {
    if (typeof c.id !== 'string' || !uuid.test(c.id) || !Array.isArray(c.conns)) throw new Error('Unknown connector record');
    if (c.conns.length) ids.push(c.id);
  }
  return ids;
}

export interface TunnelLease {
  config: TunnelConfig;
  start(relayPort: number): Promise<void>;
  check(): Promise<void>;
  stop(): Promise<void>;
}

export const fakeExecutable = fileURLToPath(new URL('./fake-cloudflared.mjs', import.meta.url));
export async function acquireTunnel(options: { root: string; dir: string; configPath: string; hostname: string; fake?: boolean }): Promise<TunnelLease> {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(options.hostname)) throw new Error('Expected the existing connector hostname, without a scheme or path');
  const config = readTunnelConfig(options.configPath);
  if (options.fake) {
    const root = realpathSync(options.root);
    for (const path of [options.configPath, config.credentialsFile]) {
      const parent = realpathSync(dirname(path));
      if (parent !== root && !parent.startsWith(root + sep)) throw new Error('Fake tunnel fixtures must stay under the verification root');
    }
  }
  // No arbitrary executable or bypass switch: fake mode always runs the checked-in non-networking double.
  const executable = options.fake ? fakeExecutable : '/opt/homebrew/bin/cloudflared';
  const localCheck = options.fake ? async () => {} : assertNoLocalConnector;
  const lock = join(options.root, `opencode-${config.id}.lock`);
  // No stale-lock stealing: a lost owner must be investigated before another connector starts.
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, run: options.dir }), { mode: 0o600 });
  const configPath = join(options.dir, 'tunnel.yml');
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let connectorId: string | undefined;
  let stopped = false;
  const remote = async () => {
    try {
      const { stdout } = await exec(executable, ['tunnel', '--config', options.configPath, 'info', '--output', 'json', config.id],
        { env: childEnv(), timeout: 15_000, maxBuffer: 1024 * 1024 });
      return connectorsFrom(stdout, config.id);
    } catch { throw new Error('Cannot confirm exclusive opencode ownership with cloudflared tunnel info'); }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(configPath, { force: true });
    rmSync(lock, { recursive: true, force: true });
  };
  try {
    await localCheck();
    if ((await remote()).length) throw new Error('opencode already has a connector; refusing to split ChatGPT traffic');
  } catch (error) { await stop(); throw error; }
  const check = async () => {
    if (stopped || !child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Tunnel is not running');
    await localCheck(child.pid);
    const ids = await remote();
    if (ids.length !== 1 || ids[0] !== connectorId) throw new Error('Exclusive tunnel ownership lost or unverifiable');
  };
  return { config,
    async start(relayPort) {
      if (stopped || child) throw new Error('Tunnel lease is not startable');
      if ([18765, 18766].includes(relayPort)) throw new Error('Everyday ports are forbidden');
      await localCheck();
      if ((await remote()).length) throw new Error('A connector appeared before startup');
      // A fresh config redirects only this hostname; the original config, credentials and DNS stay unchanged.
      writeFileSync(configPath, JSON.stringify({ tunnel: config.id, 'credentials-file': config.credentialsFile,
        ingress: [{ hostname: options.hostname, service: `http://127.0.0.1:${relayPort}` }, { service: 'http_status:404' }] }), { mode: 0o600 });
      child = spawn(executable, ['tunnel', '--config', configPath, '--no-autoupdate', 'run', config.id],
        { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      exited = new Promise(resolve => { child!.once('exit', () => resolve()); child!.once('error', () => resolve()); });
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Tunnel registration timed out')), 30_000);
        const data = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-65536);
          connectorId = /Generated Connector ID: ([0-9a-f-]{36})/i.exec(output)?.[1];
          if (connectorId && output.includes('Registered tunnel connection')) { clearTimeout(timer); resolve(); }
        };
        child!.stdout!.on('data', data); child!.stderr!.on('data', data);
        child!.once('error', () => { clearTimeout(timer); reject(new Error('Cannot start cloudflared')); });
        void exited!.then(() => { clearTimeout(timer); reject(new Error('Tunnel exited')); });
      });
      await check();
    },
    check, stop,
  };
}
