// Manual B09b controller. Starts only its own service; prints a launcher for an approved operator to run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attemptSchema, completeness } from '../evidence.ts';
import type { AttemptRecord, Completeness } from '../evidence.ts';
import { prepareClient, prepareSandbox, prepareWorkdir, verifyProfile, writeProfile } from '../runner/codex.ts';
import type { ControlProfile } from '../runner/codex.ts';
import { digest } from './reviews.ts';
import { readManifest } from './launch.ts';
import type { LaunchManifest } from './launch.ts';
import { startRoute } from '../runner/relay.ts';
import { connectController } from '../runner/controller.ts';
import { checkoutRoot, newToken, startService } from '../runner/service.ts';
import { W1, W7 } from '../scenarios/pace.ts';
import { isolationSnapshot, isolationMeasurements, openDatabases } from './isolation.ts';
import type { IsolationSnapshot } from './isolation.ts';
import { privateText, writePrivate } from './privacy.ts';
import { syncCodexLogin } from './subscription.ts';
import { proxyEnvironment, proxyRouting, proxySecrets, proxySummary } from '../proxy.ts';
import type { Field } from '../evidence.ts';
import type { InteractiveClient } from './native.ts';
import { startProxyChannel } from '../runner/proxy-channel.ts';
import type { ProxyChannel } from '../runner/proxy-channel.ts';
import { watchLauncher } from './lifecycle.ts';

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export const cacheRoot = () => join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');

export interface LaunchOptions {
  scratch: string; client: InteractiveClient; bin: string; port: number; model: string; effort: string;
  subscriptionHome: string; proxyEnv?: Record<string, string>;
  proxyChannel?: ProxyChannel;
}
export interface PreparedLauncher {
  command: string; controlDir: string; manifestPath: string; manifestHash: string; profile: ControlProfile;
}
/** Prepare controls, never a model call. port is a credential-injecting relay, not the service itself. */
export function launcher({ scratch, client, bin, port, model, effort, subscriptionHome, proxyEnv = {}, proxyChannel }: LaunchOptions): PreparedLauncher {
  proxyEnv = proxyChannel?.environment ?? proxyEnv;
  proxyRouting(proxyEnv, [], proxyChannel?.permit); // Refuse before preparing login state or launcher controls.
  scratch = realpathSync(scratch);
  const { controlDir, readOnlyDir } = prepareSandbox(scratch);
  try {
    const home = join(scratch, 'home');
    mkdirSync(home, { mode: 0o700 }); // Exclusive: never adopt an existing client HOME.
    for (const dir of ['.codex', '.claude', 'tmp']) mkdirSync(join(home, dir), { mode: 0o700 });
    const work = prepareWorkdir(scratch, [], scratch);
    const mutable: string[] = [];
    let codexLogin: LaunchManifest['codexLogin'];
    if (client === 'codex') {
      const source = join(subscriptionHome, '.codex/auth.json');
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Subscription login must be a regular single-link file');
      const loginDir = join(readOnlyDir, 'login'); mkdirSync(loginDir, { mode: 0o700 });
      const copy = join(loginDir, 'auth.json'); writeFileSync(copy, '', { mode: 0o600, flag: 'wx' });
      codexLogin = { source, copy }; // Fill the pinned file only immediately before the approved launch.
      symlinkSync(copy, join(home, '.codex/auth.json')); mutable.push(copy);
    }
    const configuration = join(readOnlyDir, 'mcp'); mkdirSync(configuration, { mode: 0o700 });
    const mcp = join(configuration, 'mcp.json');
    const url = `http://127.0.0.1:${port}/mcp`;
    json(mcp, { mcpServers: { wayfinder: { type: 'http', url } } });
    const args = client === 'codex'
      ? ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '--disable', 'apps', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
        '-c', 'check_for_update_on_startup=false', '-c', `mcp_servers.wayfinder.url=${JSON.stringify(url)}`,
        '-c', 'mcp_servers.wayfinder.required=true', '-c', 'mcp_servers.wayfinder.default_tools_approval_mode="approve"']
      : ['--dangerously-skip-permissions', '--model', model, '--effort', effort, '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', ''];
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: join(home, 'tmp'),
      CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    const executable = prepareClient(controlDir, bin);
    const profile = writeProfile(controlDir, { home }, work, executable, { readOnlyRoots: [configuration], mutableReadOnlyFiles: mutable, localPorts: [port], proxyEnv, ...(proxyChannel?.permit ? { proxyPermit: proxyChannel.permit } : {}) });
    Object.assign(env, profile.proxyEnvironment);
    const manifest: LaunchManifest = { client, bin: executable, args, workdir: work, env, profile, ...(codexLogin ? { codexLogin } : {}), ...(proxyChannel ? { hostHandshake: true } : {}) };
    const manifestPath = join(controlDir, 'launch.json'); const text = JSON.stringify(manifest);
    writeFileSync(manifestPath, text, { mode: 0o600, flag: 'wx' });
    const manifestHash = digest(text);
    const command = [process.execPath, fileURLToPath(new URL('./launch.ts', import.meta.url)), manifestPath, manifestHash].map(q).join(' ');
    return { command, controlDir, manifestPath, manifestHash, profile };
  } catch (error) { rmSync(controlDir, { recursive: true, force: true }); throw error; }
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
  let prepared: PreparedLauncher | undefined;
  let route: Awaited<ReturnType<typeof startRoute>> | undefined;
  let proxyChannel: ProxyChannel | undefined;
  let lifecycle: ReturnType<typeof watchLauncher> | undefined;
  const relay: unknown[] = [];
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
    const proxyEnv = proxyEnvironment(client === 'claude' ? options.subscriptionHome : null, options.inheritedEnv ?? process.env);
    const proxies = proxyRouting(proxyEnv);
    Object.assign(secrets, proxySecrets(proxyEnv, proxies.environment));
    proxyChannel = await startProxyChannel(proxyEnv);
    Object.assign(secrets, Object.fromEntries(Object.entries(proxySecrets(proxies.environment, proxyChannel.environment)).map(([name, value]) => [name.replace('proxy-', 'proxy-channel-'), value])));
    capture.service.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf8' }).trim();
    before = observe([dir, scratch]);
    phase = 'service';
    service = await startService(dir, controllerCredential, [agent], proxies.ports);
    controller = await connectController(service.port, controllerCredential.token);
    capture.service.version = controller.version;
    opened = openDatabases(service.pid);
    phase = 'client';
    for (const map of scenario.seed.maps) heads.set(map.mapId, await controller.seed(map));
    writePrivate(join(dir, 'seed.json'), await controller.exportCatalog(), secrets);
    writePrivate(join(dir, 'controller-rules.json'), { instructions: controller.instructions, toolDescriptions: controller.toolDescriptions,
      note: 'Observed by the Controller only; this does not claim the client saw them.' }, secrets);
    route = await startRoute(service.port, agent.token, event => relay.push(event), proxies.ports);
    prepared = launcher({ scratch, client, bin, port: route.port, model, effort, subscriptionHome: options.subscriptionHome, proxyChannel });
    lifecycle = watchLauncher(prepared.controlDir, proxyChannel);
    launchExposed = true;
    console.log(`Private Attempt: ${dir}\nClient command (approved Batch only): ${prepared.command}\nOpening line: ${scenario.turns[0]!.say}\nStop the client before finishing here. The host has a 60-minute ceiling.`);
    capture.run.completeness = 'cancelled';
    const status = await readline.question('Client exited; enter complete, precondition-not-met, launch-failed, timeout, rate-limited, cancelled, driver-failed, or service-failed: ', { signal: abort.signal });
    if (!completeness.includes(status as Completeness)) throw new Error('unrecognized capture outcome');
    clientExitAttested = true;
    capture.run.completeness = status as Completeness;
  } catch (error) {
    const safe = new Error(privateText(String(error), secrets));
    capture.run.detail = safe.message;
    if (!abort.signal.aborted) capture.run.completeness = phase === 'service' ? 'service-failed' : !launchExposed ? 'launch-failed' : 'driver-failed';
    throw safe;
  } finally {
    clearTimeout(timer); readline.close(); process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
    // Revoke before evidence export, login synchronization or any other fallible cleanup.
    try { await lifecycle?.close(); await proxyChannel?.observe(); }
    finally { await proxyChannel?.close(); }
    if (controller) {
      try { capture.maps = (await controller.exportCatalog()).map(m => ({ ...m, seedHeadRevision: heads.get(m.mapId) ?? null })); }
      catch { capture.missing.push('maps'); if (capture.run.completeness === 'complete') capture.run.completeness = 'service-failed'; }
    }
    try {
      // Only our scratch is traversed. No daily sessions, auth files, settings or unrelated conversations.
      const nativeRoot = scratch ? join(scratch, 'home', client === 'codex' ? '.codex/sessions' : '.claude/projects') : null;
      if (nativeRoot && existsSync(nativeRoot) && (!lstatSync(nativeRoot).isDirectory()
        || !realpathSync(nativeRoot).startsWith(realpathSync(join(scratch!, 'home')) + '/'))) throw new Error('native log root escaped the client HOME');
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
    try { await route?.close(); await controller?.close(); } finally {
      const stopped = await service?.stop();
      const retainRaw = (path: string, value: unknown, missing: string) => {
        try { writePrivate(path, value, secrets); }
        catch {
          rmSync(path, { force: true }); // The service protocol file already exists before its privacy check.
          capture.missing.push(missing); capture.run.completeness = 'driver-failed'; capture.run.detail = 'raw evidence withheld after privacy validation';
        }
      };
      retainRaw(join(raw, 'relay.json'), relay, 'raw.relay.json');
      if (proxyChannel) {
        retainRaw(join(raw, 'proxy-channel.json'), proxyChannel.evidence(), 'raw.proxy-channel.json');
        capture.raw.files.push('raw/proxy-channel.json');
      }
      try { after = observe([dir, ...(scratch ? [scratch] : []), ...(prepared ? [prepared.controlDir] : [])]); } catch { after = unavailable(); }
      if (service) {
        retainRaw(join(raw, 'service.log'), service.logs(), 'raw.service.log');
        if (existsSync(service.protocolReport)) retainRaw(service.protocolReport, readFileSync(service.protocolReport, 'utf8'), 'raw.protocol.jsonl');
      }
      let controlIntegrity: Field<boolean> = absent('launcher was not prepared');
      const controlFailures: string[] = [];
      const handshake = lifecycle?.evidence();
      controlFailures.push(...(handshake?.failures ?? []));
      if (proxyChannel?.evidence().blockedConnections) controlFailures.push('Proxy connections observed outside the interactive client lifetime');
      let launchFailed = false; let launchStarts = 0; let launchExited = false;
      if (prepared) {
        // Preserve the launch record even if an independent manifest/profile check fails.
        try {
          const log = join(prepared.controlDir, 'launch.jsonl');
          if (existsSync(log)) {
            const text = readFileSync(log, 'utf8');
            writePrivate(join(raw, 'launch.jsonl'), text, secrets);
            capture.raw.files.push('raw/launch.jsonl');
            for (const line of text.trim().split('\n').filter(Boolean)) {
              const entry = JSON.parse(line) as { isolationFailure?: string; launchFailure?: string; phase?: string; launched?: boolean };
              if (entry.phase === 'started' && entry.launched) launchStarts++;
              if (entry.phase === 'exited') launchExited = true;
              if (entry.launchFailure) launchFailed = true;
              if (entry.isolationFailure) controlFailures.push(entry.isolationFailure);
            }
          }
        } catch { controlFailures.push('launcher evidence missing or invalid'); }
        try {
          readManifest(prepared.manifestPath, prepared.manifestHash);
          const failure = verifyProfile(prepared.profile); if (failure) controlFailures.push(failure);
        } catch { controlFailures.push('launcher control files missing or changed'); }
        controlIntegrity = { known: true, value: controlFailures.length === 0 };
        const needsStart = ['complete', 'precondition-not-met', 'rate-limited', 'timeout', 'cancelled'].includes(capture.run.completeness);
        if (launchStarts > 1) {
          capture.run.completeness = 'driver-failed'; capture.run.detail = 'Multiple client starts recorded for one Attempt';
        } else if (needsStart && launchStarts === 0) {
          capture.run.completeness = 'launch-failed';
          capture.run.detail = launchFailed ? 'Interactive client launch failed' : 'No client start recorded';
        } else if (capture.run.completeness === 'complete' && (launchFailed || !launchExited || !handshake?.started || !handshake.exited)) {
          capture.run.completeness = 'driver-failed'; capture.run.detail = 'Interactive launch record is incomplete';
        }
        // Exit codes and signals remain evidence. The operator's completion declaration is separate.
        if (controlFailures.length) { capture.run.completeness = 'driver-failed'; capture.run.detail = 'Interactive launcher isolation check failed'; }
      }
      let loginSync: unknown = { status: 'not-applicable' };
      let syncFailed = false;
      const pendingClient = launchExposed && (!clientExitAttested || (!!handshake?.started && !handshake.exited));
      if (scratch && pendingClient) loginSync = { status: 'deferred', retainedScratch: scratch, reason: 'client exit attestation or wrapper exit missing; no refresh synchronization or scratch removal is safe' };
      if (scratch && !pendingClient && client === 'codex') {
        try { loginSync = syncCodexLogin(scratch, options.subscriptionHome); }
        catch {
          syncFailed = true; capture.run.completeness = 'driver-failed';
          capture.run.detail = 'Codex login synchronization failed; scratch retained for coordinator recovery before any new run';
          loginSync = { status: 'failed', retainedScratch: scratch };
        }
      }
      if (scratch && !syncFailed && !pendingClient) { rmSync(scratch, { recursive: true, force: true }); if (prepared) rmSync(prepared.controlDir, { recursive: true, force: true }); }
      rmSync(join(dir, 'credentials.json'), { force: true });
      capture.run.endedAt = new Date().toISOString();
      if (!capture.maps.length) capture.missing.push('maps');
      if (!capture.raw.files.some(file => file.startsWith('raw/native-'))) capture.missing.push('events');
      writePrivate(join(dir, 'capture.json'), capture, secrets);
      writePrivate(join(dir, 'isolation.json'), { proxy: prepared ? proxySummary(prepared.profile.proxyEnvironment, proxyChannel?.permit) : { enabled: false, variables: [], unavailable: true }, serviceStopped: stopped ? { known: true, value: stopped } : { known: false, reason: 'service never started' },
        codexLoginSync: loginSync, controlIntegrity, controlFailures,
        proxyChannel: proxyChannel?.evidence(), launcherHandshake: handshake,
        controlDirectoryRemoved: prepared ? !existsSync(prepared.controlDir) : null,
        ...(prepared && existsSync(prepared.controlDir) ? { retainedControlDirectory: prepared.controlDir } : {}),
        scratchRemoved: scratch ? !existsSync(scratch) : null, credentialsRemoved: !existsSync(join(dir, 'credentials.json')),
        port: service?.port, database: service?.databasePath, measurements: isolationMeasurements(before, after, opened, service?.databasePath),
        clientExit: { known: false, reason: clientExitAttested ? 'operator attests exit; wrapper status cannot prove all client descendants exited' : 'client exit not attested; exposed scratch retained' } }, secrets);
      if (syncFailed) throw new Error(capture.run.detail);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  host(process.argv.slice(2), { subscriptionHome: homedir() }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
