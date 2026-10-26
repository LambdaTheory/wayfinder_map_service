// The Codex Driver, MCP-only Entry: one isolated HOME per session, no user config, only this run's Wayfinder
// server, inside a sandbox that hides the service source, verdicts, personal configuration and other runs (R2).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * An allowlist under the home directory: the client reads nothing there except the Node that runs it, reads
 * nothing under /private/tmp except its own scratch, writes only to its scratch and the system temp, and cannot
 * connect to the everyday service or relay. Later rules override earlier ones.
 */
export function sandboxProfile(scratch: string, blockedPorts: number[] = reservedPorts, clientDir?: string): string {
  const q = (p: string) => JSON.stringify(p);
  const home = homedir();
  const workspace = existsSync(join(home, 'workspace')) ? realpathSync(join(home, 'workspace')) : null;
  const node = dirname(dirname(process.execPath));
  return ['(version 1)', '(allow default)',
    `(deny file-read* (subpath ${q(home)}) (subpath "/private/tmp")${workspace && !workspace.startsWith(home) ? ` (subpath ${q(workspace)})` : ''})`,
    '(allow file-read-metadata)',
    `(allow file-read* ${[node, scratch, ...(clientDir ? [clientDir] : [])].map(p => `(subpath ${q(p)})`).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(scratch)}) (subpath "/dev") (subpath "/private/var/folders"))`,
    ...blockedPorts.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`), ''].join('\n');
}

/** A private HOME and CODEX_HOME for one session, with a copy of the daily login (deleted with the scratch). */
export function prepareSession(scratch: string, label: string, token: string): CodexSession {
  const home = join(scratch, `home-${label}`);
  const codexHome = join(home, '.codex');
  mkdirSync(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = join(homedir(), '.codex/auth.json');
  if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
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
  if (!existsSync(root)) return [];
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
    '-c', `mcp_servers.wayfinder.url="http://127.0.0.1:${port}/mcp"`, '-c', 'mcp_servers.wayfinder.bearer_token_env_var="WAYFINDER_TOKEN"',
    '-c', 'mcp_servers.wayfinder.required=true', '-c', 'mcp_servers.wayfinder.default_tools_approval_mode="approve"',
    '--dangerously-bypass-approvals-and-sandbox'];
  return threadId ? ['exec', 'resume', ...config, threadId, '-'] : ['exec', ...config, '-C', workdir, '-'];
}

export interface TurnRequest { options: CodexOptions; session: CodexSession; port: number; workdir: string; prompt: string; profile: string; onChild?: (kill: () => void) => (() => void); onLine?: (line: Line) => void }

/** Run one turn and keep the session's thread. The child gets only the environment it needs, never the runner's. */
export function runTurn({ options: o, session: s, port, workdir, prompt, profile, onChild, onLine }: TurnRequest): Promise<TurnResult> {
  const args = codexArgs(o, port, workdir, s.thread);
  const [cmd, argv] = o.sandbox ? ['sandbox-exec', ['-f', profile, o.bin, ...args]] : [o.bin, args];
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home, CODEX_HOME: s.codexHome, TMPDIR: join(s.home, 'tmp'),
    LANG: 'en_US.UTF-8', WAYFINDER_TOKEN: s.token };
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(cmd as string, argv as string[], { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, name); } catch { /* already exited */ } };
    const kill = () => { signal('SIGTERM'); force ??= setTimeout(() => signal('SIGKILL'), 5000); force.unref(); };
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
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(force); unregister?.();
      for (const line of parseLines(buffered)) onLine?.(line);
      const lines = parseLines(stdout);
      s.thread = lines.find(e => e.type === 'thread.started')?.thread_id ?? s.thread;
      resolve({ exitCode: code, signal, timedOut, turnStarted: lines.some(e => e.type === 'turn.started'), stdout, stderr,
        startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started, threadId: s.thread });
    });
    child.stdin.end(prompt);
  });
}

/** The Codex session log for a thread, which names the visible model and holds what the model was shown. */
export function findRollout(s: CodexSession): string | null {
  const sessions = join(s.codexHome, 'sessions');
  if (!s.thread || !existsSync(sessions)) return null;
  const stack = [sessions];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.startsWith('rollout-') && entry.name.includes(s.thread)) return path;
    }
  }
  return null;
}

/** The profile for one Attempt; the client's own install directory stays readable wherever it lives. */
export function writeProfile(scratch: string, bin: string): string {
  const path = join(scratch, 'sandbox.sb');
  const resolved = bin.includes('/') ? bin : spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, sandboxProfile(scratch, reservedPorts, resolved ? dirname(realpathSync(resolved)) : undefined));
  return path;
}

const rateLimit = /\b429\b|rate.?limit|usage limit|quota/i;
export const looksRateLimited = (r: TurnResult) => rateLimit.test(r.stderr)
  || parseLines(r.stdout).some(e => (e.type === 'error' || e.type === 'turn.failed') && rateLimit.test(JSON.stringify(e)));
