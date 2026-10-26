// The Codex Driver, MCP-only Entry: one isolated HOME per session, no user config, only this run's Wayfinder
// server, inside a sandbox that hides the service source, verdicts, personal configuration and other runs (R2).
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { parseLines } from './normalize.ts';
import type { Line } from './normalize.ts';
import { reservedPorts } from './service.ts';

export interface CodexOptions {
  model: string;
  effort: string;
  /** The `codex` executable; tests pass a stand-in that makes real MCP calls without a model. */
  bin: string;
  /** Wrap the client in `sandbox-exec` with `sandboxProfile`. Recorded on every Attempt. */
  sandbox: boolean;
  timeoutMs: number;
}

export interface CodexSession { home: string; codexHome: string; token: string; thread: string | null }

export interface TurnResult {
  isolationFailure?: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Codex began a turn: a resumed session that never starts is a launch failure too. */
  turnStarted: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  threadId: string | null;
}

/** Shared Entry API: final denies override every earlier allow. Paths must already exist. */
export interface SandboxAccess {
  readOnlyRoots?: string[];
  denyWriteRoots?: string[];
  denyWritePaths?: string[];
  /** Only these loopback ports are reachable (the own relay and optional isolated bait service). */
  localPorts?: number[];
}

/** Per-native-HOME allowlist: only its HOME and the shared fixture workdir are writable. */
export function sandboxProfile(home: string, workdir: string, blockedPorts: number[] = reservedPorts, clientDir?: string, access: SandboxAccess = {}): string {
  const q = (p: string) => JSON.stringify(p);
  const personal = homedir();
  const workspace = existsSync(join(personal, 'workspace')) ? realpathSync(join(personal, 'workspace')) : null;
  const node = dirname(dirname(process.execPath));
  const readOnly = [node, ...(clientDir ? [clientDir] : []), ...(access.readOnlyRoots ?? [])];
  return ['(version 1)', '(allow default)',
    `(deny file-read* (subpath ${q(personal)}) (subpath "/private/tmp") (subpath "/private/var/folders")${workspace && !workspace.startsWith(personal) ? ` (subpath ${q(workspace)})` : ''})`,
    '(allow file-read-metadata)',
    `(allow file-read* ${[home, workdir, ...readOnly].map(p => `(subpath ${q(p)})`).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* ${[home, workdir, '/dev'].map(p => `(subpath ${q(p)})`).join(' ')})`,
    '(deny network-outbound (remote tcp "localhost:*") (remote udp "localhost:*"))',
    ...(access.localPorts ?? []).map(port => `(allow network-outbound (remote tcp "localhost:${port}"))`),
    ...blockedPorts.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`),
    ...[...readOnly, ...(access.denyWriteRoots ?? [])].map(p => `(deny file-write* (subpath ${q(p)}))`),
    ...[home, workdir, ...readOnly, ...(access.denyWritePaths ?? [])].map(p => `(deny file-write* (literal ${q(p)}))`), ''].join('\n');
}

/** A private HOME and CODEX_HOME with an explicitly supplied login source (deleted with the scratch). */
export function prepareSession(scratch: string, label: string, token: string, loginSource: string | null): CodexSession {
  if (loginSource !== null && typeof loginSource !== 'string') throw new IsolationError('login source must be explicit');
  const home = join(scratch, `home-${label}`);
  const codexHome = join(home, '.codex');
  if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error('unsafe session label');
  try { mkdirSync(home, { mode: 0o700 }); } // Exclusive: never adopt a client-prepared HOME or symlink.
  catch { throw new IsolationError('session HOME already exists or cannot be created'); }
  mkdirSync(join(home, 'tmp'), { mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (loginSource !== null && existsSync(loginSource)) { copyFileSync(loginSource, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
  return { home, codexHome, token, thread: null };
}

/** String values of the copied login, redacted from every record like the Wayfinder tokens. */
export function loginSecrets(s: CodexSession): string[] {
  const path = join(s.codexHome, 'auth.json');
  if (!existsSync(path)) return [];
  const out: string[] = [];
  const walk = (v: unknown) => { if (typeof v === 'string' && v.length >= 20) out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  try { walk(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* not JSON: nothing to collect */ }
  return out;
}

/** Skills the client installs into its own home (built-ins), recorded so MCP-only purity can be judged. */
export function clientSkills(s: CodexSession): string[] {
  const root = join(s.codexHome, 'skills');
  if (!existsSync(root) || !realpathSync(root).startsWith(s.home + '/')) return [];
  const names: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'SKILL.md') names.push(dir.slice(root.length + 1));
      else if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return names.sort();
}

export function prepareWorkdir(scratch: string, fixtures: string[], fixturesRoot: string): string {
  const work = join(scratch, 'work');
  mkdirSync(work, { recursive: true });
  for (const fixture of fixtures) cpSync(join(fixturesRoot, fixture), work, { recursive: true });
  return work;
}

export function codexArgs(o: CodexOptions, port: number, workdir: string, threadId: string | null): string[] {
  const config = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--disable', 'apps', '-m', o.model,
    '-c', `model_reasoning_effort="${o.effort}"`, '-c', 'check_for_update_on_startup=false',
    '-c', `mcp_servers.wayfinder.url="http://127.0.0.1:${port}/mcp"`,
    '-c', 'mcp_servers.wayfinder.required=true', '-c', 'mcp_servers.wayfinder.default_tools_approval_mode="approve"',
    '--dangerously-bypass-approvals-and-sandbox'];
  return threadId ? ['exec', 'resume', ...config, threadId, '-'] : ['exec', ...config, '-C', workdir, '-'];
}

export interface TurnRequest { options: CodexOptions; session: CodexSession; port: number; workdir: string; prompt: string; profile: ControlProfile; onLaunch?: () => void; onChild?: (kill: () => void) => (() => void); onLine?: (line: Line) => void }

/** Run one turn and keep the session's thread. The child gets only the environment it needs, never the runner's. */
export function runTurn({ options: o, session: s, port, workdir, prompt, profile, onLaunch, onChild, onLine }: TurnRequest): Promise<TurnResult> {
  const failure = verifyProfile(profile);
  if (failure) {
    const at = new Date().toISOString();
    return Promise.resolve({ isolationFailure: failure, exitCode: null, signal: null, timedOut: false, turnStarted: false,
      stdout: '', stderr: failure, startedAt: at, endedAt: at, durationMs: 0, threadId: s.thread });
  }
  onLaunch?.();
  const args = codexArgs(o, port, workdir, s.thread);
  const [cmd, argv] = o.sandbox ? ['sandbox-exec', ['-f', profile.path, o.bin, ...args]] : [o.bin, args];
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home, CODEX_HOME: s.codexHome, TMPDIR: join(s.home, 'tmp'),
    LANG: 'en_US.UTF-8' };
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(cmd as string, argv as string[], { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, name); } catch { /* already exited */ } };
    const kill = () => { signal('SIGTERM'); force ??= setTimeout(() => signal('SIGKILL'), 5000); force.unref(); };
    const onExit = () => signal('SIGKILL');
    process.once('exit', onExit);
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    const unregister = onChild?.(kill);
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d; buffered += d;
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        for (const line of parseLines(buffered.slice(0, end))) onLine?.(line);
        buffered = buffered.slice(end + 1);
      }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', error => { stderr += String(error); });
    child.once('close', (code, childSignal) => {
      signal('SIGKILL'); // No detached descendants may outlive the native turn.
      clearTimeout(timer); clearTimeout(force); unregister?.(); process.off('exit', onExit);
      for (const line of parseLines(buffered)) onLine?.(line);
      const lines = parseLines(stdout);
      s.thread = lines.find(e => e.type === 'thread.started')?.thread_id ?? s.thread;
      resolve({ exitCode: code, signal: childSignal, timedOut, turnStarted: lines.some(e => e.type === 'turn.started'), stdout, stderr,
        startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started, threadId: s.thread });
    });
    child.stdin.end(prompt);
  });
}

/** The Codex session log for a thread, which names the visible model and holds what the model was shown. */
export function findRollout(s: CodexSession): string | null {
  const sessions = join(s.codexHome, 'sessions');
  if (!s.thread || !existsSync(sessions) || !realpathSync(sessions).startsWith(s.home + '/')) return null;
  const stack = [sessions];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(s.thread)) return path;
    }
  }
  return null;
}

export interface ControlProfile {
  path: string;
  /** Immutable expected hashes kept in runner memory, never read back from client-writable storage. */
  hashes: Readonly<Record<string, string>>;
  readOnlyRoots: string[];
}

function fileHash(path: string): string {
  if (!lstatSync(path).isFile()) throw new IsolationError(`control file is not a regular file: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeHashes(roots: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new IsolationError(`control roots must not contain symlinks: ${path}`);
    if (stat.isDirectory()) {
      result[path] = 'directory';
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else result[path] = fileHash(path);
  };
  for (const root of roots) visit(root);
  return result;
}

export class IsolationError extends Error {
  constructor(message: string) { super(`isolation failure: ${message}`); this.name = 'IsolationError'; }
}

const contains = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../'));
};
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

/** One profile per native HOME; resumes reuse it. Runner controls are never client-readable. */
export function writeProfile(controlDir: string, session: CodexSession, workdir: string, bin: string, access: SandboxAccess = {}): ControlProfile {
  try {
    controlDir = realpathSync(controlDir);
    const home = realpathSync(session.home);
    workdir = realpathSync(workdir);
    const scratch = dirname(home);
    const otherHomes = readdirSync(scratch, { withFileTypes: true }).filter(e => e.name.startsWith('home-'))
      .map(e => realpathSync(join(scratch, e.name))).filter(p => p !== home);
    const baseline = [realpathSync(homedir()), '/private/tmp', '/private/var/folders'];
    if (existsSync(join(homedir(), 'workspace'))) baseline.push(realpathSync(join(homedir(), 'workspace')));
    const readOnlyRoots = (access.readOnlyRoots ?? []).map(p => realpathSync(p));
    for (const root of [controlDir, ...readOnlyRoots]) {
      if ([home, workdir, ...baseline].some(p => contains(root, p)) || otherHomes.some(p => overlaps(root, p)))
        throw new IsolationError('control/read-only root contains a protected root or overlaps another session HOME');
    }
    if ([home, workdir].some(p => overlaps(controlDir, p)) || readOnlyRoots.some(p => overlaps(controlDir, p)))
      throw new IsolationError('control directory must be disjoint from writable and client-readable roots');
    const protectedParents: string[] = [];
    for (let p = controlDir;; p = dirname(p)) { protectedParents.push(p); if (dirname(p) === p) break; }
    const path = join(controlDir, `${basename(home)}.sb`);
    const resolved = bin.includes('/') ? bin : spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim();
    const text = sandboxProfile(home, workdir, reservedPorts, resolved ? dirname(realpathSync(resolved)) : undefined,
      { ...access, readOnlyRoots, denyWriteRoots: [...(access.denyWriteRoots ?? []).map(p => realpathSync(p)), controlDir],
        denyWritePaths: [...(access.denyWritePaths ?? []).map(p => realpathSync(p)), ...protectedParents] })
      + `(deny file-read* (subpath ${JSON.stringify(controlDir)}))\n`;
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    const profile = { path, readOnlyRoots };
    return { ...profile, hashes: Object.freeze(profileHashes(profile)) };
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    throw new IsolationError(`cannot prepare sandbox: ${String(error)}`);
  }
}

const profileHashes = (profile: Pick<ControlProfile, 'path' | 'readOnlyRoots'>) =>
  ({ ...treeHashes(profile.readOnlyRoots), [profile.path]: fileHash(profile.path) });

/** Checked before every launch, even a resume; a mismatch never launches the client. */
export function verifyProfile(profile: ControlProfile): string | null {
  try {
    const current = profileHashes(profile);
    const expected = profile.hashes;
    if (Object.keys(current).length !== Object.keys(expected).length || Object.keys(expected).some(p => current[p] !== expected[p]))
      return 'isolation failure: runner control files changed';
    return null;
  } catch { return 'isolation failure: runner control files missing or replaced'; }
}

const rateLimit = /\b429\b|rate.?limit|usage limit|quota/i;
export const looksRateLimited = (r: TurnResult) => rateLimit.test(r.stderr)
  || parseLines(r.stdout).some(e => (e.type === 'error' || e.type === 'turn.failed') && rateLimit.test(JSON.stringify(e)));
