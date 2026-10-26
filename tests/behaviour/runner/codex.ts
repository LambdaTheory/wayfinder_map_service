// The Codex MCP-only Driver and shared native capture: one isolated HOME per session, no user config, only this run's Wayfinder
// server, inside a sandbox that hides the service source, verdicts, personal configuration and other runs (R2).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLines } from './normalize.ts';
import type { Line } from './normalize.ts';
import { IsolationError, verifyProfile } from './sandbox.ts';
import type { ControlProfile } from './sandbox.ts';
export { IsolationError, prepareClient, prepareSandbox, writeProfile, verifyProfile } from './sandbox.ts';
export type { SandboxAccess, ControlProfile } from './sandbox.ts';

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
  postIsolationFailure?: string;
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

export interface ClientLogin { contents: string }

/** Login bytes are injected. This function never looks up or reads a personal login path. */
export function prepareSession(scratch: string, label: string, token: string, loginSource: ClientLogin | null): CodexSession {
  if (loginSource !== null && (typeof loginSource !== 'object' || typeof loginSource?.contents !== 'string')) throw new TypeError('login contents or null must be explicit');
  const home = join(scratch, `home-${label}`);
  const codexHome = join(home, '.codex');
  if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error('unsafe session label');
  try { mkdirSync(home, { mode: 0o700 }); } // Exclusive: never adopt a client-prepared HOME or symlink.
  catch { throw new IsolationError('session HOME already exists or cannot be created'); }
  mkdirSync(join(home, 'tmp'), { mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (loginSource !== null) writeFileSync(join(codexHome, 'auth.json'), loginSource.contents, { mode: 0o600, flag: 'wx' });
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
  const work = join(realpathSync(scratch), 'work');
  try { mkdirSync(work, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(work).isDirectory() || realpathSync(work) !== work) throw new IsolationError('workdir must be a real directory inside this Attempt');
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
    LANG: 'en_US.UTF-8', ...profile.proxyEnvironment };
  return executeTurn({ options: o, session: s, workdir, prompt, profile, ...(onChild ? { onChild } : {}), ...(onLine ? { onLine } : {}) }, cmd as string, argv as string[], env);
}

/** Shared native capture, streaming and post-launch integrity checks for both Entries. */
export function executeTurn({ options: o, session: s, workdir, prompt, profile, onChild, onLine }: Omit<TurnRequest, 'port'>,
  cmd: string, argv: string[], env: NodeJS.ProcessEnv): Promise<TurnResult> {
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
      const postIsolationFailure = verifyProfile(profile);
      resolve({ ...(postIsolationFailure ? { postIsolationFailure } : {}), exitCode: code, signal: childSignal, timedOut, turnStarted: lines.some(e => e.type === 'turn.started'), stdout, stderr,
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

const rateLimit = /\b429\b|rate.?limit|usage limit|quota/i;
export const looksRateLimited = (r: TurnResult) => rateLimit.test(r.stderr)
  || parseLines(r.stdout).some(e => (e.type === 'error' || e.type === 'turn.failed') && rateLimit.test(JSON.stringify(e)));
