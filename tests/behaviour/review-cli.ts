// Subscription CLIs only. The controller never reads/copies credentials, and never inherits API keys or hooks.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ReviewDriver, ReviewRequest, ReviewResponse, Reviewer } from './review.ts';

const disabled = ['apps', 'plugins', 'hooks', 'memories', 'shell_tool', 'shell_snapshot', 'unified_exec', 'multi_agent',
  'multi_agent_v2', 'code_mode', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'skill_search', 'remote_plugin', 'view_image'];

export function reviewArgs(target: Reviewer): string[] {
  if (target.cli === 'claude') return ['--print', '--safe-mode', '--restricted', '--setting-sources', '',
    '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--model', target.model,
    '--system-prompt', 'You are an evidence reviewer. Follow only the review instructions in the user input. No tools or external context.'];
  return ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--color', 'never', '--model', target.model,
    ...disabled.flatMap(f => ['--disable', f]), '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    '-c', 'check_for_update_on_startup=false', '-c', 'mcp_servers={}', '-'];
}

/** Private working/runtime directories, and only the login file accessible outside them for Codex authentication. */
export function codexReviewSandbox(scratch: string, runtime: string, install: string, auth: string): string {
  const q = JSON.stringify;
  return ['(version 1)', '(allow default)',
    `(deny file-read* (subpath ${q(homedir())}) (subpath "/private/tmp") (subpath ${q(realpathSync(tmpdir()))}) (subpath ${q(process.cwd())}))`,
    '(allow file-read-metadata)',
    `(allow file-read* (subpath ${q(scratch)}) (subpath ${q(install)}) (subpath ${q(dirname(dirname(process.execPath)))}) (literal ${q(auth)}))`,
    '(deny file-write*)', `(allow file-write* (subpath ${q(runtime)}) (literal "/dev/null") (literal "/dev/tty"))`,
    '(deny network-outbound (remote ip "localhost:*"))', ''].join('\n');
}

interface ProcessOutput { stdout: string; stderr: string; code: number | null; timedOut: boolean; cancelled?: boolean }

export function decodeResponse(cli: Reviewer['cli'], output: ProcessOutput): ReviewResponse {
  const { stdout, stderr, code, timedOut } = output;
  const base: ReviewResponse = { status: 'error', detail: output.cancelled ? 'review batch cancelled' : timedOut ? 'client timed out' : `client exit ${code}`, text: '', stdout, stderr,
    responseId: null, visibleModel: null, cached: false };
  if (output.cancelled || timedOut || code !== 0) return { ...base, status: /model.*(not found|not available|not supported|does not exist)|authentication|not logged in|login required/i.test(stdout + stderr) ? 'unavailable' : 'error' };
  if (cli === 'codex') {
    // Text-mode exec emits its native model and session header on stderr, final answer on stdout.
    const model = /^model:\s*(\S+)\s*$/m.exec(stderr)?.[1] ?? null;
    const id = /^session id:\s*(\S+)\s*$/m.exec(stderr)?.[1] ?? null;
    if (/^(exec|file update|apply_patch|tool [^\n]+)\s*$/m.test(stderr)) return { ...base, detail: 'isolation violation: Codex attempted tool activity' };
    return { ...base, status: 'complete', detail: 'codex exec completed', text: stdout.trim(), responseId: id, visibleModel: model };
  }
  const lines: Record<string, any>[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    try { lines.push(JSON.parse(line)); } catch { return { ...base, detail: 'invalid Claude native JSON stream' }; }
  }
  const init = lines.find(x => x.type === 'system' && x.subtype === 'init');
  const result = lines.findLast(x => x.type === 'result');
  const messages = lines.filter(x => x.type === 'assistant');
  const models = new Set(messages.map(x => x.message?.model).filter(Boolean));
  if (init?.model) models.add(init.model);
  if (init?.tools?.length || init?.mcp_servers?.length || messages.some(x => x.message?.content?.some((b: any) => b.type === 'tool_use')))
    return { ...base, detail: 'isolation violation: Claude exposed or used tools/MCP' };
  if (result?.is_error || result?.subtype !== 'success') return { ...base, detail: `Claude result: ${result?.subtype ?? 'missing'}` };
  return { ...base, status: 'complete', detail: 'Claude print completed', text: result.result ?? '', responseId: result.session_id ?? null,
    visibleModel: models.size === 1 ? [...models][0] : null };
}

async function run(cmd: string, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessOutput> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = ''; let timedOut = false; let cancelled = false;
    const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } } };
    let hard: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { kill('SIGTERM'); hard ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const cancel = () => { cancelled = true; stderr += '\nreview cancelled'; stop(); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    child.stdin.on('error', () => { /* early client failure is reported by close */ });
    child.once('error', e => { stderr += String(e); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(hard); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      resolve({ stdout, stderr, code, timedOut, cancelled });
    });
    child.stdin.end(input);
  });
}

export class CliReviewDriver implements ReviewDriver {
  private timeoutMs: number;
  private cancelled = false;
  constructor(timeoutMs = 300_000) { this.timeoutMs = timeoutMs; }
  async invoke(request: ReviewRequest): Promise<ReviewResponse> {
    if (this.cancelled) throw new Error('review batch cancelled');
    if (process.platform !== 'darwin') throw new Error('CLI review isolation is implemented for macOS only');
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-review-')));
    try {
      const work = join(scratch, 'work'); const runtime = join(scratch, 'runtime');
      mkdirSync(work); mkdirSync(runtime, { mode: 0o700 });
      const target = request.target;
      const resolved = spawnSync('/usr/bin/which', [target.cli], { encoding: 'utf8' }).stdout?.trim();
      if (!resolved) throw new Error(`${target.cli} is not installed; no substitute`);
      const bin = realpathSync(resolved);
      // No inherited ANTHROPIC_API_KEY, OPENAI_API_KEY, auth tokens, proxy hooks, NODE_OPTIONS or user CLI overrides.
      const env: NodeJS.ProcessEnv = { PATH: `${dirname(resolved)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir(), TMPDIR: runtime, LANG: 'en_US.UTF-8' };
      let cmd = bin; let args = reviewArgs(target);
      if (target.cli === 'codex') {
        const home = join(runtime, 'home'); const codexHome = join(home, '.codex');
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        // Let the signed-in CLI read its own login. The controller neither opens nor copies the file.
        const auth = join(homedir(), '.codex', 'auth.json');
        symlinkSync(auth, join(codexHome, 'auth.json'));
        env.HOME = home; env.CODEX_HOME = codexHome;
        args = ['-p', codexReviewSandbox(scratch, runtime, dirname(dirname(bin)), auth), bin, ...args];
        cmd = '/usr/bin/sandbox-exec';
      }
      // Check the signed-in subscription through the CLI, not by opening a credential file.
      const authArgs = target.cli === 'claude' ? ['--safe-mode', '--setting-sources', '', 'auth', 'status']
        : [...args.slice(0, 2), bin, 'login', 'status'];
      const auth = await run(cmd, authArgs, '', work, env, 30_000);
      if (auth.cancelled) { this.cancelled = true; return { ...decodeResponse(target.cli, auth), invocation: { command: cmd, args } }; }
      let signedIn = false;
      if (target.cli === 'claude') {
        try { const status = JSON.parse(auth.stdout); signedIn = status.loggedIn === true && status.authMethod === 'claude.ai'; } catch { /* fail closed */ }
      } else signedIn = /Logged in using ChatGPT/i.test(auth.stdout + auth.stderr);
      if (auth.code !== 0 || !signedIn) return { status: 'unavailable', detail: `${target.cli} subscription login unavailable in isolated mode`,
        text: '', stdout: '', stderr: '', responseId: null, visibleModel: null, cached: false, invocation: { command: cmd, args } };
      const response = await run(cmd, args, request.input, work, env, this.timeoutMs);
      this.cancelled = response.cancelled ?? false;
      return { ...decodeResponse(target.cli, response), invocation: { command: cmd, args } };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}
