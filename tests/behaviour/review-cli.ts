// Subscription CLIs only. The controller never reads/copies credentials, and never inherits API keys or hooks.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { modelMatches } from './model-review.ts';
import { reportReason } from './review-verdict.ts';
import { ReviewProxyError, reviewProxyEnvironment, reviewProxyRouting } from './review-proxy.ts';
import type { ReviewDriver, ReviewRequest, ReviewResponse, Reviewer } from './model-review.ts';

const disabledCodexFeatures = ['apps', 'plugins', 'hooks', 'memories', 'shell_tool', 'shell_snapshot', 'unified_exec', 'multi_agent',
  'multi_agent_v2', 'code_mode', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'skill_search', 'remote_plugin', 'view_image'];

export function reviewArgs(target: Reviewer): string[] {
  if (target.cli === 'claude') return ['--print', '--safe-mode', '--restricted', '--setting-sources', 'user',
    '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-prompts', 'none', '--system-prompt-snapshot', 'off', '--output-format', 'stream-json', '--verbose', '--model', target.model,
    '--system-prompt', 'You are an evidence reviewer. Follow only the review instructions in the user input. No tools or external context.'];
  return ['--no-daemon', 'exec', '--strict-config', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--color', 'never', '--model', target.model,
    ...disabledCodexFeatures.flatMap(f => ['--disable', f]), '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    '-c', 'check_for_update_on_startup=false', '-c', 'mcp_servers={}', '-'];
}

/** Both CLIs use the same OS boundary. Native authentication is the only permitted personal resource. */
export function reviewSandbox(scratch: string, runtime: string, install: string, auth?: string, keychain?: string, proxyRules: readonly string[] = []): string {
  const q = JSON.stringify;
  const workspace = join(homedir(), 'workspace');
  const blocked = [homedir(), '/private/tmp', realpathSync(tmpdir()), process.cwd(),
    '/Library/Application Support/ClaudeCode', '/Library/Application Support/Claude', '/Library/Application Support/OpenAI',
    '/Library/Managed Preferences', '/Library/Preferences/com.anthropic.claudecode.plist',
    '/etc/claude-code', '/private/etc/claude-code', '/etc/codex', '/private/etc/codex',
    ...(existsSync(workspace) ? [realpathSync(workspace)] : [])];
  const authTemp = auth ? `${dirname(auth).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:auth\\.json(?:\\.[^/]*)?|\\.tmp[^/]+)$` : null;
  return ['(version 1)', '(allow default)',
    `(deny file-read* ${blocked.map(p => `(subpath ${q(p)})`).join(' ')})`, '(allow file-read-metadata)',
    `(allow file-read* (subpath ${q(scratch)}) (subpath ${q(install)}) (subpath ${q(dirname(dirname(process.execPath)))})${auth ? ` (literal ${q(auth)})` : ''}${keychain ? ` (literal ${q(keychain)})` : ''})`,
    '(deny file-write*)', `(allow file-write* (subpath ${q(runtime)}) (literal "/dev/null") (literal "/dev/tty"))`,
    // Use one native login storage location: a refresh must never strand newer tokens in a disposable copy.
    ...(auth ? [`(allow file-write* (literal ${q(auth)}) (regex #${q(`^${authTemp}`)}))`] : []),
    // Do not fetch cached managed/user preferences through cfprefsd around the file-read boundary.
    '(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
    '(deny network-outbound (remote ip "localhost:*"))', ...proxyRules, ''].join('\n');
}
export const codexReviewSandbox = reviewSandbox;

interface ProcessOutput { stdout: string; stderr: string; code: number | null; timedOut: boolean; cancelled?: boolean }

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const string = (v: unknown): string | null => typeof v === 'string' ? v : null;

export function decodeResponse(cli: Reviewer['cli'], output: ProcessOutput, requestedModel?: string): ReviewResponse {
  const { stdout, stderr, code, timedOut } = output;
  const base: ReviewResponse = { status: 'error', detail: output.cancelled ? 'review batch cancelled' : timedOut ? 'client timed out' : `client exit ${code}`,
    text: '', stdout, stderr, responseId: null, visibleModel: null, cached: false };
  if (output.cancelled || timedOut || code !== 0) return { ...base, status: /model.*(not found|not available|not supported|does not exist)|authentication|not logged in|login required/i.test(stdout + stderr) ? 'unavailable' : 'error' };
  const lines: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    try { lines.push(object(JSON.parse(line))); } catch { return { ...base, detail: 'invalid native JSON stream' }; }
  }
  const cached = lines.some(x => x.isReplay === true || x.is_replay === true || x.cached_response === true || x.type === 'response.replayed'
    || object(x.message).isReplay === true || object(x.message).cached_response === true);
  const cacheEvidence = cached ? 'replayed' as const : 'not-reported' as const;
  if (cli === 'codex') {
    const allowedEvents = new Set(['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed', 'error', 'turn.failed']);
    if (lines.some(x => !allowedEvents.has(String(x.type)))) return { ...base, cached, cacheEvidence, detail: 'unsupported Codex event; isolation cannot be confirmed' };
    const items = lines.filter(x => /^item\./.test(String(x.type))).map(x => object(x.item));
    if (items.some(x => x.type !== 'agent_message' && x.type !== 'reasoning')) return { ...base, cached, cacheEvidence, detail: 'isolation violation: Codex attempted tool activity' };
    if (lines.some(x => x.type === 'error' || x.type === 'turn.failed') || !lines.some(x => x.type === 'turn.completed')) return { ...base, cached, cacheEvidence, detail: 'Codex turn failed or incomplete' };
    const messages = lines.filter(x => x.type === 'item.completed' && object(x.item).type === 'agent_message').map(x => object(x.item));
    const final = messages.at(-1); const thread = string(lines.find(x => x.type === 'thread.started')?.thread_id);
    const nativeModel = lines.map(x => string(x.model) ?? string(object(x.turn).model)).find(Boolean);
    const responseId = lines.map(x => string(x.response_id)).find(Boolean) ?? (thread && string(final?.id) ? `${thread}:${String(final!.id)}` : null);
    return { ...base, status: 'complete', detail: 'codex exec completed', text: string(final?.text) ?? '', responseId,
      visibleModel: nativeModel ?? requestedModel ?? null, modelEvidence: nativeModel ? 'native' : 'requested-only', cached, cacheEvidence };
  }
  const init = lines.find(x => x.type === 'system' && x.subtype === 'init');
  const result = lines.findLast(x => x.type === 'result');
  const messages = lines.filter(x => x.type === 'assistant').map(x => object(x.message));
  const models = [string(init?.model), ...messages.map(x => string(x.model))].filter((v): v is string => !!v);
  const expected = requestedModel ?? models[0]?.replace(/-\d{8}$/, '');
  const model = expected && models.length && models.every(x => modelMatches(expected, x)) ? models.at(-1)! : null;
  if (Array.isArray(init?.tools) && init.tools.length || Array.isArray(init?.mcp_servers) && init.mcp_servers.length
    || messages.some(x => Array.isArray(x.content) && x.content.some((b: unknown) => object(b).type === 'tool_use')))
    return { ...base, cached, cacheEvidence, detail: 'isolation violation: Claude exposed or used tools/MCP' };
  if (result?.is_error || result?.subtype !== 'success') return { ...base, cached, cacheEvidence, detail: 'Claude result failed or missing' };
  const messageIds = [...new Set(messages.flatMap(x => string(x.id) ? [String(x.id)] : []))];
  // With tools disabled there must be one completion, not a bundle concealing a replayed message.
  return { ...base, status: 'complete', detail: 'Claude print completed', text: string(result.result) ?? '', responseId: messageIds.length === 1 ? messageIds[0]! : null,
    sessionId: string(result.session_id), visibleModel: model, modelEvidence: 'native', cached, cacheEvidence };
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
  private subscriptionHome: string;
  private cancelled = false;
  constructor(timeoutMs = 300_000, subscriptionHome = homedir()) { this.timeoutMs = timeoutMs; this.subscriptionHome = subscriptionHome; }
  /** Zero generations; authentication output is summarized without email addresses or credential contents. */
  async checkLogin(target: Reviewer): Promise<{ cli: string; available: boolean; detail: string }> {
    const result = await this.execute(target);
    return { cli: target.cli, available: result.status === 'complete', detail: result.detail };
  }
  async invoke(request: ReviewRequest): Promise<ReviewResponse> { return this.execute(request.target, request); }
  private async execute(target: Reviewer, request?: ReviewRequest): Promise<ReviewResponse> {
    if (this.cancelled) throw new Error('review batch cancelled');
    if (process.platform !== 'darwin') throw new Error('CLI review isolation is implemented for macOS only');
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-review-')));
    try {
      const proxies = reviewProxyRouting(reviewProxyEnvironment(this.subscriptionHome, process.env));
      const work = join(scratch, 'work'); const runtime = join(scratch, 'runtime');
      mkdirSync(work); mkdirSync(runtime, { mode: 0o700 });
      const resolved = spawnSync('/usr/bin/which', [target.cli], { encoding: 'utf8' }).stdout?.trim();
      if (!resolved) throw new Error(`${target.cli} is not installed; no substitute`);
      const bin = realpathSync(resolved);
      const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:${dirname(resolved)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: this.subscriptionHome, TMPDIR: runtime, LANG: 'en_US.UTF-8', ...proxies.environment };
      for (const key of ['USER', 'LOGNAME'])
        if (process.env[key]) env[key] = process.env[key];
      const authFile = target.cli === 'codex' ? join(this.subscriptionHome, '.codex', 'auth.json') : undefined;
      // Native keychain access needs this one file; no personal settings or keychain contents are handled here.
      const keychain = target.cli === 'claude' ? join(this.subscriptionHome, 'Library/Keychains/login.keychain-db') : undefined;
      const prefix = ['-p', reviewSandbox(scratch, runtime, dirname(dirname(bin)), authFile, keychain, proxies.rules), bin];
      const cmd = '/usr/bin/sandbox-exec'; let args = reviewArgs(target); let authArgs: string[];
      let authEnv = env;
      if (target.cli === 'claude') {
        // Claude's per-uid /tmp directory ignores TMPDIR; keep its private files inside this review's sandbox.
        env.CLAUDE_CODE_TMPDIR = join(runtime, 'claude-tmp'); mkdirSync(env.CLAUDE_CODE_TMPDIR, { mode: 0o700 });
        env.CLAUDE_CONFIG_DIR = join(runtime, 'claude'); mkdirSync(env.CLAUDE_CONFIG_DIR);
        env.CLAUDE_SECURESTORAGE_CONFIG_DIR = ''; // The launcher's shared daily keychain route, never a copied keychain entry.
        env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'; env.DISABLE_AUTOUPDATER = '1';
        authArgs = ['--safe-mode', '--restricted', '--setting-sources', 'user', 'auth', 'status'];
      } else {
        const home = join(runtime, 'home'); const statusHome = join(runtime, 'login-status');
        mkdirSync(home); mkdirSync(statusHome);
        env.HOME = home; env.CODEX_HOME = dirname(authFile!);
        // Generation uses the native shared store directly. A disposable symlink is ONLY for read-only login status.
        // The status command loads config and does not expose exec's --ignore-user-config, so its config directory is empty.
        symlinkSync(authFile!, join(statusHome, 'auth.json'));
        authEnv = { ...env, CODEX_HOME: statusHome };
        authArgs = ['--no-daemon', 'login', 'status']; // This CLI rejects --strict-config on login; its config directory is fresh and empty.
        args.splice(args.length - 1, 0, '-c', `sqlite_home=${JSON.stringify(join(runtime, 'state'))}`, '-c', `log_dir=${JSON.stringify(join(runtime, 'logs'))}`);
      }
      const auth = await run(cmd, [...prefix, ...authArgs], '', work, authEnv, 30_000);
      if (auth.cancelled) { this.cancelled = true; return { ...decodeResponse(target.cli, auth), invocation: { command: cmd, args: [...prefix, ...args] } }; }
      let signedIn = false;
      if (target.cli === 'claude') {
        try { const status = object(JSON.parse(auth.stdout)); signedIn = status.loggedIn === true && status.authMethod === 'claude.ai'; } catch { /* fail closed */ }
      } else signedIn = /Logged in using ChatGPT/i.test(auth.stdout + auth.stderr);
      const diagnostic = /api.?key|token|bearer|secret|@/i.test(auth.stderr) ? 'native auth diagnostic omitted'
        : reportReason(auth.stderr).trim().split('\n').slice(0, 3).join(' ');
      const base: ReviewResponse = { status: signedIn && auth.code === 0 ? 'complete' : 'unavailable',
        detail: signedIn && auth.code === 0 ? 'isolated subscription login available (no generation)' : `isolated subscription login unavailable (exit ${auth.code})${diagnostic ? `: ${diagnostic}` : ''}`,
        text: '', stdout: '', stderr: '', responseId: null, visibleModel: null, cached: false, invocation: { command: cmd, args: [...prefix, ...args] } };
      if (base.status !== 'complete' || !request) return base;
      const response = await run(cmd, [...prefix, ...args], request.input, work, env, this.timeoutMs);
      this.cancelled = response.cancelled ?? false;
      return { ...decodeResponse(target.cli, response, target.model), invocation: base.invocation! };
    } catch (error) {
      if (!(error instanceof ReviewProxyError)) throw error;
      return { status: 'unavailable', detail: error.message, text: '', stdout: '', stderr: '', responseId: null, visibleModel: null, cached: false };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}
