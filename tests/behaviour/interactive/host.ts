// Manual B09b controller. Starts only its own service; prints a launcher for an approved operator to run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { attemptSchema, completeness } from '../evidence.ts';
import type { AttemptRecord, Completeness } from '../evidence.ts';
import { sandboxProfile } from '../runner/codex.ts';
import { connectController } from '../runner/controller.ts';
import { checkoutRoot, newToken, reservedPorts, startService } from '../runner/service.ts';
import { W1, W7 } from '../scenarios/pace.ts';
import { isolationSnapshot, isolationMeasurements, openDatabases } from './isolation.ts';
import type { IsolationSnapshot } from './isolation.ts';
import { privateText, writePrivate } from './privacy.ts';
import { claudeProxyEnvironment, proxyVariables, syncCodexLogin } from './subscription.ts';
import type { Field } from '../evidence.ts';
import type { InteractiveClient } from './native.ts';

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export const cacheRoot = () => join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');

export interface LaunchOptions {
  scratch: string; client: InteractiveClient; bin: string; port: number; token: string; model: string; effort: string;
  subscriptionHome: string; proxyEnv?: Record<string, string>;
}
/** Subscription only. Authentication and proxy source paths must be explicit, including in tests. */
export function launcher({ scratch, client, bin, port, token, model, effort, subscriptionHome, proxyEnv = {} }: LaunchOptions): string {
  const home = join(scratch, 'home'); const work = join(scratch, 'work');
  for (const dir of [home, work, join(home, '.codex'), join(home, '.claude'), join(home, 'tmp')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const profile = join(scratch, 'sandbox.sb');
  const authFile = join(subscriptionHome, '.codex/auth.json');
  if (client === 'codex') symlinkSync(authFile, join(home, '.codex/auth.json'));
  const authRead = client === 'codex' ? `(allow file-read* (literal ${JSON.stringify(authFile)}))\n` : '';
  writeFileSync(profile, sandboxProfile(scratch, reservedPorts, dirname(realpathSync(bin))) + authRead, { mode: 0o600 });
  const url = `http://127.0.0.1:${port}/mcp`;
  json(join(scratch, 'mcp.json'), { mcpServers: { wayfinder: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
  const args = client === 'codex'
    ? ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '--disable', 'apps', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      '-c', 'check_for_update_on_startup=false', '-c', `mcp_servers.wayfinder.url=${JSON.stringify(url)}`,
      '-c', 'mcp_servers.wayfinder.bearer_token_env_var="WAYFINDER_TOKEN"', '-c', 'mcp_servers.wayfinder.required=true', '-c', 'mcp_servers.wayfinder.default_tools_approval_mode="approve"']
    : ['--dangerously-skip-permissions', '--model', model, '--effort', effort, '--strict-mcp-config', '--mcp-config', join(scratch, 'mcp.json'), '--setting-sources', ''];
  const env = ['PATH=' + (process.env.PATH ?? '/usr/bin:/bin'), 'HOME=' + home, 'TMPDIR=' + join(home, 'tmp'),
    'CODEX_HOME=' + join(home, '.codex'), 'CLAUDE_CONFIG_DIR=' + join(home, '.claude'), 'LANG=en_US.UTF-8', 'TERM=xterm-256color',
    'WAYFINDER_TOKEN=' + token, 'DISABLE_AUTOUPDATER=1', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1'];
  if (client === 'claude') for (const key of proxyVariables) if (proxyEnv[key] !== undefined) env.push(`${key}=${proxyEnv[key]}`);
  // The subscription token is inherited at execution; private proxy settings remain only in this scratch script.
  const auth = client === 'codex' ? '' : 'CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:?Kun must approve claude setup-token first}"';
  return `#!/bin/sh\nset -eu\nunset CODEX_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY\ncd ${q(work)}\nexec env -i ${env.map(q).join(' ')} ${auth} /usr/bin/sandbox-exec -f ${q(profile)} ${[bin, ...args].map(q).join(' ')}\n`;
}

export async function host(args: string[], options: { subscriptionHome: string; observe?: (paths: string[]) => IsolationSnapshot; inheritedEnv?: NodeJS.ProcessEnv }) {
  const observe = options.observe ?? isolationSnapshot;
  const [batch, attempt, client, model, effort, scenarioId, executable] = args;
  if (args.length !== 7 || !batch || !attempt || !/^[A-Za-z0-9_-]+$/.test(`${batch}${attempt}`)
    || (client !== 'codex' && client !== 'claude') || !model || !effort || !['W1', 'W7'].includes(scenarioId ?? '') || !executable) {
    throw new Error('usage: node tests/behaviour/interactive/host.ts <approved-batch> <fresh-attempt> <codex|claude> <model> <effort> <W1|W7> <absolute-client-binary>');
  }
  if (process.platform !== 'darwin') throw new Error('interactive host currently requires the macOS allowlist sandbox');
  const root = cacheRoot(); mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `${batch}-${attempt}`);
  if (existsSync(dir)) throw new Error('Attempt directory already exists; refusing to reuse it');
  mkdirSync(dir, { mode: 0o700 });
  let scratch: string | undefined;
  const raw = join(dir, 'raw'); mkdirSync(raw, { mode: 0o700 });
  const controllerCredential = { clientId: `${attempt}-controller`, token: newToken() };
  const agent = { clientId: `${attempt}-${client}-A`, token: newToken() };
  const secrets: Record<string, string> = { controller: controllerCredential.token, agent: agent.token };
  const scenario = scenarioId === 'W1' ? W1 : W7;
  const startedAt = new Date().toISOString();
  const absent = (reason: string) => ({ known: false as const, reason });
  const capture: AttemptRecord & { requestedEffort: string } = { schema: attemptSchema, attemptId: attempt, batchId: batch, requestedEffort: effort,
    subject: { kind: 'scenario', id: scenario.id, version: scenario.version }, entry: 'mcp-only',
    combination: { harness: client, requestedModel: model, visibleModel: absent('awaiting native import'), effort: absent('awaiting native import') },
    client: { version: absent('awaiting native import'), surface: { known: true, value: 'interactive-cli' } },
    service: { commit: 'unknown', series: 'release', version: 'unknown' },
    given: [], run: { startedAt, endedAt: startedAt, completeness: 'launch-failed' }, controller: { clientId: controllerCredential.clientId }, baitClientIds: [],
    sessions: [{ label: 'A', clientId: agent.clientId, nativeId: absent('awaiting native import'), mcpSessionIds: absent('awaiting protocol correlation'), turns: [] }],
    events: [], maps: [], receipts: [], usage: absent('not exposed by this capture'), raw: { path: 'raw', files: [] },
    missing: ['given', 'usage', 'sessions.mcpSessionIds', 'events.process'] };
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let controller: Awaited<ReturnType<typeof connectController>> | undefined;
  const heads = new Map<string, number>();
  const unavailable = (): IsolationSnapshot => ({ configs: {}, everyday: { known: false, reason: 'observation not reached' } });
  let before = unavailable(); let after = unavailable();
  let opened: Field<string[]> = { known: false, reason: 'service did not open a database' };
  let phase: 'setup' | 'service' | 'client' = 'setup';
  let launchExposed = false; let clientExitAttested = false;
  const abort = new AbortController();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const cancelled = () => { capture.run.completeness = 'cancelled'; abort.abort(); };
  process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
  const timer = setTimeout(() => { capture.run.completeness = 'timeout'; abort.abort(); }, 60 * 60_000);
  readline.once('close', () => abort.abort());
  try {
    scratch = mkdtempSync('/private/tmp/wayfinder-interactive-');
    const bin = realpathSync(executable);
    const proxyEnv = client === 'claude' ? claudeProxyEnvironment(options.subscriptionHome, options.inheritedEnv ?? process.env) : {};
    // Bypass hosts are public routing data; redacting them would corrupt loopback MCP evidence.
    for (const [key, value] of Object.entries(proxyEnv)) if (key.toLowerCase() !== 'no_proxy') secrets[`proxy-${key}`] = value;
    capture.service.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf8' }).trim();
    before = observe([dir, scratch]);
    phase = 'service';
    service = await startService(dir, controllerCredential, [agent]);
    controller = await connectController(service.port, controllerCredential.token);
    capture.service.version = controller.version;
    opened = openDatabases(service.pid);
    phase = 'client';
    for (const map of scenario.seed.maps) heads.set(map.mapId, await controller.seed(map));
    writePrivate(join(dir, 'seed.json'), await controller.exportCatalog(), secrets);
    writePrivate(join(dir, 'controller-rules.json'), { instructions: controller.instructions, toolDescriptions: controller.toolDescriptions,
      note: 'Observed by the Controller only; this does not claim the client saw them.' }, secrets);
    const launchPath = join(scratch, 'launch.sh');
    writeFileSync(launchPath, launcher({ scratch, client, bin, port: service.port, token: agent.token, model, effort,
      subscriptionHome: options.subscriptionHome, proxyEnv }), { mode: 0o700 });
    launchExposed = true;
    console.log(`Private Attempt: ${dir}\nClient command (approved Batch only): ${q(launchPath)}\nOpening line: ${scenario.turns[0]!.say}\nStop the client before finishing here. The host has a 60-minute ceiling.`);
    capture.run.completeness = 'cancelled';
    const status = await readline.question('Client exited; enter complete, precondition-not-met, launch-failed, timeout, rate-limited, cancelled, driver-failed, or service-failed: ', { signal: abort.signal });
    if (!completeness.includes(status as Completeness)) throw new Error('unrecognized capture outcome');
    clientExitAttested = true;
    capture.run.completeness = status as Completeness;
  } catch (error) {
    const safe = new Error(privateText(String(error), secrets));
    capture.run.detail = safe.message;
    if (!abort.signal.aborted) capture.run.completeness = phase === 'service' ? 'service-failed' : 'driver-failed';
    throw safe;
  } finally {
    clearTimeout(timer); readline.close(); process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
    if (controller) {
      try { capture.maps = (await controller.exportCatalog()).map(m => ({ ...m, seedHeadRevision: heads.get(m.mapId) ?? null })); }
      catch { capture.missing.push('maps'); if (capture.run.completeness === 'complete') capture.run.completeness = 'service-failed'; }
    }
    try {
      // Only our scratch is traversed. No daily sessions, auth files, settings or unrelated conversations.
      const nativeRoot = scratch ? join(scratch, 'home', client === 'codex' ? '.codex/sessions' : '.claude/projects') : null;
      const visit = (path: string) => {
        if (!existsSync(path)) return;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const name = `native-${capture.raw.files.length}.jsonl`;
            writePrivate(join(raw, name), readFileSync(file, 'utf8'), secrets);
            capture.raw.files.push(`raw/${name}`);
          }
        }
      };
      if (nativeRoot) visit(nativeRoot);
    } catch { capture.missing.push('events'); if (capture.run.completeness === 'complete') capture.run.completeness = 'driver-failed'; }
    try { await controller?.close(); } finally {
      const stopped = await service?.stop();
      try { after = observe([dir, ...(scratch ? [scratch] : [])]); } catch { after = unavailable(); }
      if (service) {
        writePrivate(join(raw, 'service.log'), service.logs(), secrets);
        if (existsSync(service.protocolReport)) writePrivate(service.protocolReport, readFileSync(service.protocolReport, 'utf8'), secrets);
      }
      let loginSync: unknown = { status: 'not-applicable' };
      let syncFailed = false;
      const pendingClient = launchExposed && !clientExitAttested;
      if (scratch && pendingClient) loginSync = { status: 'deferred', retainedScratch: scratch, reason: 'client exit not attested; no refresh synchronization or scratch removal is safe' };
      if (scratch && !pendingClient && client === 'codex') {
        try { loginSync = syncCodexLogin(scratch, options.subscriptionHome); }
        catch {
          syncFailed = true; capture.run.completeness = 'driver-failed';
          capture.run.detail = 'Codex login synchronization failed; scratch retained for coordinator recovery before any new run';
          loginSync = { status: 'failed', retainedScratch: scratch };
        }
      }
      if (scratch && !syncFailed && !pendingClient) rmSync(scratch, { recursive: true, force: true });
      rmSync(join(dir, 'credentials.json'), { force: true });
      capture.run.endedAt = new Date().toISOString();
      if (!capture.maps.length) capture.missing.push('maps');
      if (!capture.raw.files.length) capture.missing.push('events');
      writePrivate(join(dir, 'capture.json'), capture, secrets);
      writePrivate(join(dir, 'isolation.json'), { serviceStopped: stopped ? { known: true, value: stopped } : { known: false, reason: 'service never started' },
        codexLoginSync: loginSync,
        scratchRemoved: scratch ? !existsSync(scratch) : null, credentialsRemoved: !existsSync(join(dir, 'credentials.json')),
        port: service?.port, database: service?.databasePath, measurements: isolationMeasurements(before, after, opened, service?.databasePath),
        clientExit: { known: false, reason: clientExitAttested ? 'manually launched client exit is operator-attested, not measured' : 'client exit not attested; exposed scratch retained' } }, secrets);
      if (syncFailed) throw new Error(capture.run.detail);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  host(process.argv.slice(2), { subscriptionHome: homedir() }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
