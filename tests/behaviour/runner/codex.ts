// The Codex Driver, MCP-only Entry: one isolated HOME per session, no user config, only this run's Wayfinder
// server, inside a sandbox that hides the service source, verdicts, personal configuration and other runs (R2).
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexOptions {
  model: string;
  effort: string;
  /** The `codex` executable; tests pass a stand-in that makes real MCP calls without a model. */
  bin: string;
  /** Wrap the client in `sandbox-exec` with the profile below. */
  sandbox: boolean;
  timeoutMs: number;
}

export interface CodexSession { label: string; home: string; codexHome: string; token: string }

export interface TurnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  threadId: string | null;
}

/** Paths the agent must not read. The run's private record directory is under the Wayfinder folder. */
export function deniedReads(): string[] {
  const home = homedir();
  return [join(home, 'workspace'), join(home, '.codex'), join(home, '.codex-wayfinder'), join(home, '.codex-wayfinder-matt'),
    join(home, '.claude'), join(home, '.claude-wayfinder'), join(home, '.claude-wayfinder-matt'), join(home, '.claude.json'),
    join(home, '.wayfinder-service'), join(home, 'Library/Application Support/Wayfinder')];
}

/** Everything is allowed except reading the denied paths and writing anywhere under the real home. */
export function sandboxProfile(): string {
  const quote = (p: string) => JSON.stringify(p);
  return ['(version 1)', '(allow default)',
    ...deniedReads().map(p => `(deny file-read* (subpath ${quote(p)}))`),
    `(deny file-write* (subpath ${quote(homedir())}))`, ''].join('\n');
}

/** A private HOME and CODEX_HOME for one session, with a copy of the daily login (removed again by `cleanup`). */
export function prepareSession(root: string, label: string, token: string): CodexSession {
  const home = join(root, `home-${label}`);
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = join(homedir(), '.codex/auth.json');
  if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
  return { label, home, codexHome, token };
}

export function prepareWorkdir(root: string, fixtures: string[], fixturesRoot: string): string {
  const work = join(root, 'work');
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

/** Run one turn. The child gets only the environment it needs, never the runner's. */
export function runTurn(o: CodexOptions, s: CodexSession, port: number, workdir: string, prompt: string, threadId: string | null,
  profilePath: string, onChild?: (kill: () => void) => void): Promise<TurnResult> {
  const args = codexArgs(o, port, workdir, threadId);
  const [cmd, argv] = o.sandbox ? ['sandbox-exec', ['-f', profilePath, o.bin, ...args]] : [o.bin, args];
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home, CODEX_HOME: s.codexHome, TMPDIR: join(s.home, 'tmp'),
    LANG: 'en_US.UTF-8', WAYFINDER_TOKEN: s.token };
  mkdirSync(env.TMPDIR, { recursive: true });
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(cmd as string, argv as string[], { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, o.timeoutMs);
    onChild?.(() => child.kill('SIGTERM'));
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', error => { stderr += String(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const thread = stdout.split('\n').map(line => { try { return JSON.parse(line) as { type?: string; thread_id?: string }; } catch { return null; } })
        .find(e => e?.type === 'thread.started')?.thread_id ?? threadId;
      resolve({ exitCode: code, signal, timedOut, stdout, stderr, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(),
        durationMs: Date.now() - started, threadId: thread });
    });
    child.stdin.end(prompt);
  });
}

/** The Codex session log for a thread, which names the visible model and holds what the model was shown. */
export function findRollout(codexHome: string, threadId: string): string | null {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return null;
  const stack = [sessions];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.startsWith('rollout-') && entry.name.includes(threadId)) return path;
    }
  }
  return null;
}

export function writeProfile(root: string): string {
  const path = join(root, 'sandbox.sb');
  writeFileSync(path, sandboxProfile());
  return path;
}

const rateLimit = /\b429\b|rate.?limit|usage limit|quota/i;
export const looksRateLimited = (r: TurnResult) => rateLimit.test(r.stderr) || rateLimit.test(r.stdout.split('\n').filter(l => /"type":"(error|turn.failed)"/.test(l)).join('\n'));
