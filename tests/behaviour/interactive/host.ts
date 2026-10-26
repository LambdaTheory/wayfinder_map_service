// Manual B09b controller. Starts only its own service; prints a launcher for an approved operator to run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { attemptSchema, completeness, redact } from '../evidence.ts';
import type { AttemptRecord, Completeness } from '../evidence.ts';
import { sandboxProfile } from '../runner/codex.ts';
import { connectController } from '../runner/controller.ts';
import { checkoutRoot, newToken, reservedPorts, startService } from '../runner/service.ts';
import { W1, W7 } from '../scenarios/pace.ts';
import type { InteractiveClient } from './native.ts';

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export const cacheRoot = () => join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');

/** No copied login or global configuration. A fresh login/API credential belongs to this scratch alone. */
export function launcher(scratch: string, client: InteractiveClient, bin: string, port: number, token: string, model: string, effort: string): string {
  const home = join(scratch, 'home'); const work = join(scratch, 'work');
  for (const dir of [home, work, join(home, '.codex'), join(home, '.claude'), join(home, 'tmp')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const profile = join(scratch, 'sandbox.sb');
  writeFileSync(profile, sandboxProfile(scratch, reservedPorts, dirname(realpathSync(bin))), { mode: 0o600 });
  const url = `http://127.0.0.1:${port}/mcp`;
  json(join(scratch, 'mcp.json'), { mcpServers: { wayfinder: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
  const args = client === 'codex'
    ? ['--ignore-user-config', '--disable', 'apps', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      '-c', 'check_for_update_on_startup=false', '-c', `mcp_servers.wayfinder.url=${JSON.stringify(url)}`,
      '-c', 'mcp_servers.wayfinder.bearer_token_env_var="WAYFINDER_TOKEN"', '-c', 'mcp_servers.wayfinder.required=true']
    : ['--model', model, '--effort', effort, '--strict-mcp-config', '--mcp-config', join(scratch, 'mcp.json'), '--setting-sources', ''];
  const env = ['PATH=' + (process.env.PATH ?? '/usr/bin:/bin'), 'HOME=' + home, 'TMPDIR=' + join(home, 'tmp'),
    'CODEX_HOME=' + join(home, '.codex'), 'CLAUDE_CONFIG_DIR=' + join(home, '.claude'), 'LANG=en_US.UTF-8', 'TERM=xterm-256color',
    'WAYFINDER_TOKEN=' + token, 'DISABLE_AUTOUPDATER=1'];
  // Credential values are inherited from the operator at execution, never printed or stored by this launcher.
  const auth = client === 'codex' ? 'CODEX_API_KEY="${B09_CODEX_API_KEY:?provide the approved run credential}"'
    : 'ANTHROPIC_API_KEY="${B09_CLAUDE_API_KEY:?provide the approved run credential}"';
  return `#!/bin/sh\nset -eu\ncd ${q(work)}\nexec env -i ${env.map(q).join(' ')} ${auth} /usr/bin/sandbox-exec -f ${q(profile)} ${[bin, ...args].map(q).join(' ')}\n`;
}

export async function host(args: string[]) {
  const [batch, attempt, client, model, effort, scenarioId, executable] = args;
  if (args.length !== 7 || !batch || !attempt || !/^[A-Za-z0-9_-]+$/.test(`${batch}${attempt}`)
    || (client !== 'codex' && client !== 'claude') || !model || !effort || !['W1', 'W7'].includes(scenarioId ?? '') || !executable) {
    throw new Error('usage: node tests/behaviour/interactive/host.ts <approved-batch> <fresh-attempt> <codex|claude> <model> <effort> <W1|W7> <absolute-client-binary>');
  }
  if (process.platform !== 'darwin') throw new Error('interactive host currently requires the macOS allowlist sandbox');
  const bin = realpathSync(executable);
  const root = cacheRoot(); mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `${batch}-${attempt}`); mkdirSync(dir, { mode: 0o700 });
  const scratch = mkdtempSync('/private/tmp/wayfinder-interactive-');
  const raw = join(dir, 'raw'); mkdirSync(raw, { mode: 0o700 });
  const controllerCredential = { clientId: `${attempt}-controller`, token: newToken() };
  const agent = { clientId: `${attempt}-${client}-A`, token: newToken() };
  const secrets = { controller: controllerCredential.token, agent: agent.token,
    ...(process.env.B09_CODEX_API_KEY ? { modelCodex: process.env.B09_CODEX_API_KEY } : {}),
    ...(process.env.B09_CLAUDE_API_KEY ? { modelClaude: process.env.B09_CLAUDE_API_KEY } : {}) };
  const scenario = scenarioId === 'W1' ? W1 : W7;
  const startedAt = new Date().toISOString();
  const absent = (reason: string) => ({ known: false as const, reason });
  const capture: AttemptRecord = { schema: attemptSchema, attemptId: attempt, batchId: batch,
    subject: { kind: 'scenario', id: scenario.id, version: scenario.version }, entry: 'mcp-only',
    combination: { harness: client, requestedModel: model, visibleModel: absent('awaiting native import'), effort: absent('awaiting native import') },
    client: { version: absent('awaiting native import'), surface: { known: true, value: 'interactive-cli' } },
    service: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf8' }).trim(), series: 'release',
      version: (JSON.parse(readFileSync(join(checkoutRoot, 'package.json'), 'utf8')) as { version: string }).version },
    given: [], run: { startedAt, endedAt: startedAt, completeness: 'launch-failed' }, controller: { clientId: controllerCredential.clientId }, baitClientIds: [],
    sessions: [{ label: 'A', clientId: agent.clientId, nativeId: absent('awaiting native import'), mcpSessionIds: absent('awaiting protocol correlation'), turns: [] }],
    events: [], maps: [], receipts: [], usage: absent('not exposed by this capture'), raw: { path: 'raw', files: [] },
    missing: ['given', 'usage', 'sessions.mcpSessionIds', 'events.process'] };
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let controller: Awaited<ReturnType<typeof connectController>> | undefined;
  const heads = new Map<string, number>();
  const abort = new AbortController();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const cancelled = () => { capture.run.completeness = 'cancelled'; abort.abort(); };
  process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
  const timer = setTimeout(() => { capture.run.completeness = 'timeout'; abort.abort(); }, 60 * 60_000);
  readline.once('close', () => abort.abort());
  try {
    service = await startService(dir, controllerCredential, [agent]);
    controller = await connectController(service.port, controllerCredential.token);
    for (const map of scenario.seed.maps) heads.set(map.mapId, await controller.seed(map));
    json(join(dir, 'seed.json'), await controller.exportCatalog());
    json(join(dir, 'controller-rules.json'), { instructions: controller.instructions, toolDescriptions: controller.toolDescriptions,
      note: 'Observed by the Controller only; this does not claim the client saw them.' });
    const launchPath = join(scratch, 'launch.sh');
    writeFileSync(launchPath, launcher(scratch, client, bin, service.port, agent.token, model, effort), { mode: 0o700 });
    console.log(`Private Attempt: ${dir}\nClient command (approved Batch only): ${q(launchPath)}\nOpening line: ${scenario.turns[0]!.say}\nStop the client before finishing here. The host has a 60-minute ceiling.`);
    capture.run.completeness = 'cancelled';
    const status = await readline.question('Client exited; enter complete, precondition-not-met, launch-failed, timeout, rate-limited, cancelled, driver-failed, or service-failed: ', { signal: abort.signal });
    if (!completeness.includes(status as Completeness)) throw new Error('unrecognized capture outcome');
    capture.run.completeness = status as Completeness;
  } catch (error) {
    capture.run.detail = String(error);
    if (capture.run.completeness === 'complete') capture.run.completeness = 'driver-failed';
    throw error;
  } finally {
    clearTimeout(timer); readline.close(); process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
    if (controller) {
      try { capture.maps = (await controller.exportCatalog()).map(m => ({ ...m, seedHeadRevision: heads.get(m.mapId) ?? null })); }
      catch { capture.missing.push('maps'); if (capture.run.completeness === 'complete') capture.run.completeness = 'service-failed'; }
    }
    try {
    // Only our scratch is traversed. No daily sessions, auth files, settings or unrelated conversations.
    const nativeRoot = join(scratch, 'home', client === 'codex' ? '.codex/sessions' : '.claude/projects');
    const visit = (path: string) => {
      if (!existsSync(path)) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const name = `native-${capture.raw.files.length}.jsonl`;
          writeFileSync(join(raw, name), redact(readFileSync(file, 'utf8'), secrets), { mode: 0o600 });
          capture.raw.files.push(`raw/${name}`);
        }
      }
    };
    visit(nativeRoot);
    } catch { capture.missing.push('events'); if (capture.run.completeness === 'complete') capture.run.completeness = 'driver-failed'; }
    try { await controller?.close(); } finally {
      await service?.stop();
      if (service) {
        writeFileSync(join(raw, 'service.log'), redact(service.logs(), secrets), { mode: 0o600 });
        if (existsSync(service.protocolReport)) writeFileSync(service.protocolReport, redact(readFileSync(service.protocolReport, 'utf8'), secrets), { mode: 0o600 });
      }
      rmSync(scratch, { recursive: true, force: true }); rmSync(join(dir, 'credentials.json'), { force: true });
      capture.run.endedAt = new Date().toISOString();
      if (!capture.maps.length) capture.missing.push('maps');
      if (!capture.raw.files.length) capture.missing.push('events');
      json(join(dir, 'capture.json'), capture);
      json(join(dir, 'isolation.json'), { serviceStopped: !!service, scratchRemoved: !existsSync(scratch),
        credentialsRemoved: !existsSync(join(dir, 'credentials.json')), port: service?.port, database: service?.databasePath,
        scope: 'Only this host\'s service was started/stopped; no daily configuration was loaded.', clientExit: 'operator-attested' });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  host(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
