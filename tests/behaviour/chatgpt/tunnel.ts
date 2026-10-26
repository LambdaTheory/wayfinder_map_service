// Exclusive, foreground use of the existing opencode tunnel. Only cloudflared reads its credentials.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { reservedPorts } from '../runner/service.ts';

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

type LocalTunnelTarget = TunnelConfig & { configPath: string };

function isConnectorCommand(command: string): boolean {
  const executable = /^(?:\S*\/)?cloudflared(?:\s|$)/.exec(command);
  if (!executable) return false;
  const args = command.slice(executable[0].length);
  const value = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
  const tunnel = /(?:^|\s)tunnel(?:\s|$)/.exec(args);
  if (tunnel) {
    // A visible target identity is unsafe unless the entire command is a known read-only
    // inspection. In particular, unknown options must not hide a connector or masquerade
    // as a diagnostic action through their values. No launch-option allowlist is needed.
    const inspection = `${args.slice(0, tunnel.index)} ${args.slice(tunnel.index + tunnel[0].length)}`;
    const argument = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
    if (inspection.replace(argument, '').trim()) return true; // Unbalanced quotes are ambiguous too.
    const tokens = inspection.match(argument) ?? [];
    const positional: string[] = [];
    let help = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token.startsWith('-')) { positional.push(token); continue; }
      if (['--help', '-h', '--version'].includes(token)) { help = true; continue; }
      if (/^--no-autoupdate(?:=(?:true|false))?$/.test(token)) continue;
      if (!/^(?:--(?:name|config|credentials-file|output|loglevel)|-n|-o|-config)(?:=.+)?$/.test(token)) return true;
      if (!token.includes('=')) {
        if (!tokens[i + 1] || tokens[i + 1]!.startsWith('-')) return true;
        i++;
      }
    }
    if (help) return false;
    return !(['info', 'list', 'token'].includes(positional[0] ?? '')
      || positional[0] === 'ingress' && ['validate', 'rule'].includes(positional[1] ?? ''));
  }
  if (/(?:^|\s)(?:--help|-h|--version)(?=\s|$)/.test(args)) return false;
  // Legacy config-only launch: known options, no positional subcommand such as "service".
  const option = String.raw`(?:--(?:no-autoupdate|hello-world)|--(?:config|credentials-file|token|token-file)(?:=|\s+)${value})`;
  return new RegExp(String.raw`^${option}(?:\s+${option})*$`).test(args);
}

export function hasLocalConnector(stdout: string, target: LocalTunnelTarget, ownPid?: number): boolean {
  const identifiers = [target.id, target.credentialsFile, target.configPath, 'opencode'].map((value, index) =>
    new RegExp(`(?:^|[\\s="'])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s"'])`, index === 0 || index === 3 ? 'i' : ''));
  return stdout.split('\n').some(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === ownPid) return false;
    const command = match[2]!;
    // Token-only connectors have no visible tunnel identity; the remote inventory decides ownership.
    return (isConnectorCommand(command) && identifiers.some(id => id.test(command)))
      || /(?:^|\s|\/)node(?:\s+[^\n]*?)?\s+(?:[^\s]*\/)?scripts\/local-chatgpt-test\.mjs(?:\s|$)/.test(command);
  });
}
export async function assertNoLocalConnector(target: LocalTunnelTarget, ownPid?: number, fakeProcesses?: string) {
  const stdout = fakeProcesses ?? (await exec('ps', ['-axo', 'pid=,command='], { timeout: 5000 })).stdout;
  // Never print process command lines: another process can carry a secret in argv.
  if (hasLocalConnector(stdout, target, ownPid)) throw new Error('Another local tunnel connector or daily ChatGPT runner is active; ask its operator to stop it');
}

/** Unknown remote state fails closed; pending reconnects also count as occupied. */
export function connectorsFrom(text: string, id: string): string[] {
  const info = JSON.parse(text) as { id?: unknown; name?: unknown; conns?: { id?: unknown; conns?: unknown }[] | null };
  if (typeof info.id !== 'string' || info.id.toLowerCase() !== id.toLowerCase()
    || info.name !== 'opencode' || !(info.conns === null || Array.isArray(info.conns)))
    throw new Error('Cannot confirm the opencode tunnel identity and connectors');
  const ids: string[] = [];
  for (const c of info.conns ?? []) {
    if (typeof c.id !== 'string' || !uuid.test(c.id) || !Array.isArray(c.conns)) throw new Error('Unknown connector record');
    ids.push(c.id); // Registered but currently disconnected clients still occupy the tunnel.
  }
  return ids;
}

export interface TunnelLease {
  config: TunnelConfig;
  start(relayPort: number): Promise<void>;
  check(): Promise<void>;
  stop(): Promise<void>;
  stopSync(): void;
}

export const fakeExecutable = fileURLToPath(new URL('./fake-cloudflared.mjs', import.meta.url));
export async function acquireTunnel(options: { root: string; dir: string; configPath: string; hostname: string; fake?: boolean; fakeProcesses?: string }): Promise<TunnelLease> {
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
  // Synthetic process inventories apply only to the non-networking fake; real runs always query ps.
  const localCheck = (ownPid?: number) => assertNoLocalConnector({ ...config, configPath: options.configPath }, ownPid,
    options.fake ? options.fakeProcesses ?? '' : undefined);
  const lock = join(options.root, `opencode-${config.id}.lock`);
  // No stale-lock stealing: a lost owner must be investigated before another connector starts.
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Tunnel lease exists: inspect ${join(lock, 'owner.json')}; verify its owner and connector PIDs, stop only a confirmed orphan, then remove that lease and its recorded temporary config before retrying`);
    throw error;
  }
  const configPath = join(options.dir, 'tunnel.yml');
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let connectorId: string | undefined;
  let stopped = false;
  const cleanupFiles = () => { rmSync(configPath, { force: true }); rmSync(lock, { recursive: true, force: true }); };
  const stopSync = () => {
    // process.exit cannot await the normal cleanup. Give only our child a short grace period, then force it down.
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          try { process.kill(child.pid, 0); } catch { break; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    } finally { cleanupFiles(); }
  };
  process.on('exit', stopSync);
  const remote = async () => {
    try {
      const { stdout } = await exec(executable, ['tunnel', '--config', options.configPath, 'info', '--output', 'json', config.id],
        { env: childEnv(), timeout: 15_000, maxBuffer: 1024 * 1024 });
      return connectorsFrom(stdout, config.id);
    } catch { throw new Error('Cannot confirm exclusive opencode ownership with cloudflared tunnel info'); }
  };
  let stopping: Promise<void> | undefined;
  const stop = async () => stopping ??= (async () => {
    if (stopped) return;
    stopped = true;
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    try {
      // Avoid starting the next Attempt while Cloudflare still lists this retired connector.
      if (connectorId) {
        const deadline = Date.now() + 5000;
        while ((await remote()).includes(connectorId)) {
          if (Date.now() >= deadline) throw new Error('Stopped connector is still registered; inspect tunnel info before retrying');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } finally {
      cleanupFiles();
      process.removeListener('exit', stopSync);
    }
  })();
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, run: options.dir, configPath }), { mode: 0o600 });
    await localCheck();
    if ((await remote()).length) throw new Error('opencode already has a registered connector; inspect cloudflared tunnel info and the lease owner before restarting any route, stop only a confirmed orphan or ask the active operator to stop, then retry');
  } catch (error) { await stop(); throw error; }
  // A turn and the monitor can overlap. Share one in-flight inspection and its outcome.
  // Diagnostic subprocesses are excluded by their action, independently of this sharing.
  let checking: Promise<void> | undefined;
  const check = () => checking ??= (async () => {
    if (stopped || !child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Tunnel is not running');
    await localCheck(child.pid);
    const ids = await remote();
    if (ids.length !== 1 || ids[0] !== connectorId) throw new Error('Exclusive tunnel ownership lost or unverifiable');
  })().finally(() => { checking = undefined; });
  return { config,
    async start(relayPort) {
      if (stopped || child) throw new Error('Tunnel lease is not startable');
      if (reservedPorts.includes(relayPort)) throw new Error('Everyday ports are forbidden');
      await localCheck();
      if ((await remote()).length) throw new Error('A connector appeared before startup');
      // A fresh config redirects only this hostname; the original config, credentials and DNS stay unchanged.
      writeFileSync(configPath, `tunnel: ${JSON.stringify(config.id)}\ncredentials-file: ${JSON.stringify(config.credentialsFile)}\ningress:\n  - hostname: ${JSON.stringify(options.hostname)}\n    service: "http://127.0.0.1:${relayPort}"\n  - service: "http_status:404"\n`, { mode: 0o600 });
      child = spawn(executable, ['tunnel', '--config', configPath, '--no-autoupdate', 'run', config.id],
        { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      exited = new Promise(resolve => { child!.once('exit', () => resolve()); child!.once('error', () => resolve()); });
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, connectorPid: child.pid ?? null, run: options.dir, configPath }), { mode: 0o600 });
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
      // Registration can precede the control-plane inventory. Only our own/empty state may be retried.
      const deadline = Date.now() + 5000;
      while (true) {
        const ids = await remote();
        if (ids.length) { await check(); break; }
        if (Date.now() >= deadline) throw new Error('Registered connector never became visible in the tunnel inventory');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    },
    check, stop, stopSync,
  };
}
