// node tests/behaviour/runner/run.ts --batch <id> --scenarios S0b,F11 --count 2 --ceiling 4 [--model gpt-6-astra] [--effort xhigh]
// Runs an approved Batch: every Attempt on a fresh service and database with its own port, credentials and output
// directory, on Codex through the MCP-only Entry (B02a). Spends model quota: run only what Kun approved.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { attemptSchema, leaks, redact } from '../evidence.ts';
import type { AttemptRecord, Completeness, EventRecord, GivenRules, SessionRecord } from '../evidence.ts';
import { library } from '../library.ts';
import { fixturesRoot, readiness, validateScenario } from '../scenario.ts';
import type { Scenario } from '../scenario.ts';
import { findRollout, looksRateLimited, prepareSession, prepareWorkdir, runTurn, writeProfile } from './codex.ts';
import type { CodexOptions } from './codex.ts';
import { connectController } from './controller.ts';
import { normalizeTurn, parseLines, readRollout, receiptsFrom, shown } from './normalize.ts';
import { checkoutRoot, newToken, startService } from './service.ts';
import type { Credential } from './service.ts';

export interface BatchOptions {
  batchId: string;
  scenarios: string[];
  count: number;
  ceiling: number;
  model: string;
  effort: string;
  out: string;
  codex: Omit<CodexOptions, 'model' | 'effort'>;
  /** Where per-Attempt scratch (HOME, working directory) lives; must be outside the real home for the sandbox. */
  scratchRoot: string;
}

export interface PlannedAttempt { attemptId: string; scenario: Scenario }
export interface AttemptOutcome { attemptId: string; scenario: string; completeness: Completeness | 'not-run'; detail?: string; record?: string }

/** Refusals reported before anything runs: the runner never switches model or Entry or drops a Scenario silently (R2). */
export function preflight(o: Pick<BatchOptions, 'scenarios' | 'count' | 'ceiling' | 'batchId'>): { plan: PlannedAttempt[]; refusals: string[] } {
  const refusals: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.batchId)) refusals.push('batch id must be a short identifier');
  if (!Number.isInteger(o.count) || o.count < 1) refusals.push('count must be a positive integer');
  if (!Number.isInteger(o.ceiling) || o.ceiling < 1) refusals.push('ceiling must be a positive integer');
  const plan: PlannedAttempt[] = [];
  for (const id of o.scenarios) {
    const s = library.find(x => x.id === id);
    if (!s) { refusals.push(`${id}: no such Scenario`); continue; }
    const problems = [...validateScenario(s), ...readiness(s).map(r => `${id}: not ready: ${r}`)];
    if (!s.applies.entries.includes('mcp-only')) problems.push(`${id}: does not apply to the MCP-only Entry`);
    if (s.controller.length) problems.push(`${id}: Controller actions (${s.controller.map(a => a.action).join(', ')}) are not supported by this runner yet (B02b)`);
    if (s.turns.some(t => t.concurrent || t.freshProcess)) problems.push(`${id}: concurrent or fresh-process sessions are not supported by this runner yet (B02b)`);
    if (new Set(s.turns.map(t => t.session)).size > 1) problems.push(`${id}: several sessions are not supported by this runner yet (B02b)`);
    if (s.seed.restores === 'history') problems.push(`${id}: history seeds are not supported by this runner yet (B04)`);
    refusals.push(...problems);
    for (let k = 1; k <= o.count; k++) plan.push({ attemptId: `${id}-${k}`, scenario: s });
  }
  return { plan, refusals };
}

const tilde = (p: string) => p.replace(homedir(), '~');
const sha = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;

/** Global state the runner must leave alone: personal client configuration, the everyday service's credentials and listener. */
export function isolationSnapshot() {
  const files = ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json', '.codex-wayfinder/config.toml', '.wayfinder-service/credentials.json']
    .map(f => join(homedir(), f));
  const listener = spawnSync('lsof', ['-nP', '-iTCP:18766', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim() || null;
  return { files: Object.fromEntries(files.map(f => [tilde(f), sha(f)])), everydayServicePid: listener };
}

/** The real database path, read only to prove the runner's services never opened it; never recorded. */
function realDatabasePath(): string | null {
  const env = join(homedir(), 'workspace/runtime/repos/wayfinder_map_service/.env.local');
  if (!existsSync(env)) return null;
  return /^WAYFINDER_DATABASE_PATH=["']?([^"'\n]+)/m.exec(readFileSync(env, 'utf8'))?.[1] ?? null;
}

function openDatabases(pid: number): string[] {
  const out = spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(l => l.startsWith('n') && /\.sqlite/.test(l)).map(l => l.slice(1));
}

const codexVersion = (bin: string) => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const serviceCommit = () => execFileSync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

export async function runAttempt(o: BatchOptions, p: PlannedAttempt, cancelled: () => boolean, register: (kill: () => void) => void): Promise<AttemptOutcome> {
  const s = p.scenario;
  const dir = join(o.out, p.attemptId);
  mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(o.scratchRoot, `wf-behave-${p.attemptId}-`));
  const tag = `${o.batchId}.${p.attemptId}`;
  const controller: Credential = { clientId: 'Behaviour-Controller', token: newToken() };
  const labels = [...new Set(s.turns.map(t => t.session))];
  const agents = Object.fromEntries(labels.map(l => [l, { clientId: `Behaviour.${tag}.${l}`, token: newToken() }]));
  const secrets: Record<string, string> = { 'controller-token': controller.token, ...Object.fromEntries(labels.map(l => [`token-${l}`, agents[l]!.token])) };
  const startedAt = new Date().toISOString();
  const events: EventRecord[] = [];
  const sessions: SessionRecord[] = labels.map(l => ({ label: l, nativeId: { known: false, reason: 'no thread started' }, clientId: agents[l]!.clientId,
    mcpSessionIds: { known: false, reason: 'Codex does not report MCP session IDs; service metadata (B07) will' }, turns: [] }));
  const rawFiles: string[] = [];
  const writeRaw = (name: string, text: string) => { writeFileSync(join(dir, 'raw', name), tilde(redact(text, secrets)), { mode: 0o600 }); rawFiles.push(name); };
  const usage = { inputTokens: 0, outputTokens: 0 };
  let completeness: Completeness = 'complete';
  let detail: string | undefined;
  const missing: string[] = [];
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let ctl: Awaited<ReturnType<typeof connectController>> | undefined;
  const seedHeads: Record<string, number> = {};
  let openedDatabases: string[] = [];
  let rollout: ReturnType<typeof readRollout> | null = null;
  try {
    service = await startService(join(dir, 'service'), controller, Object.values(agents));
    openedDatabases = openDatabases(service.pid);
    ctl = await connectController(service.port, controller.token);
    for (const map of s.seed.maps) seedHeads[map.mapId] = await ctl.seed(map);
    const workdir = prepareWorkdir(scratch, s.seed.fixtures, fixturesRoot);
    const profile = writeProfile(scratch);
    const codexSessions = Object.fromEntries(labels.map(l => [l, prepareSession(scratch, l, agents[l]!.token)]));
    const threads: Record<string, string | null> = Object.fromEntries(labels.map(l => [l, null]));
    let seq = 0;
    for (const [index, turn] of s.turns.entries()) {
      if (cancelled()) { completeness = 'cancelled'; break; }
      if (turn.kind === 'reply') {
        const last = [...events].reverse().find(e => e.kind === 'message' && e.role === 'assistant' && e.session === turn.session);
        if (!last || last.kind !== 'message' || !turn.answers!.cue.test(last.text)) {
          completeness = 'precondition-not-met'; detail = `turn ${index}: the proposal "${turn.answers!.proposal}" did not appear`; break;
        }
      }
      const r = await runTurn({ ...o.codex, model: o.model, effort: o.effort }, codexSessions[turn.session]!, service.port, workdir, turn.say,
        threads[turn.session]!, profile, register);
      writeRaw(`turn-${index}-${turn.session}.stdout.jsonl`, r.stdout);
      if (r.stderr.trim()) writeRaw(`turn-${index}-${turn.session}.stderr.txt`, r.stderr);
      const n = normalizeTurn(parseLines(r.stdout), turn.session, index, turn.say, r.startedAt, seq, workdir);
      seq += n.events.length;
      events.push(...n.events);
      usage.inputTokens += n.usage.inputTokens; usage.outputTokens += n.usage.outputTokens;
      threads[turn.session] = r.threadId;
      const record = sessions.find(x => x.label === turn.session)!;
      if (r.threadId) record.nativeId = { known: true, value: r.threadId };
      record.turns.push({ index, input: turn.say, startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs });
      if (cancelled()) { completeness = 'cancelled'; break; }
      if (r.timedOut) { completeness = 'timeout'; detail = `turn ${index} exceeded ${o.codex.timeoutMs} ms`; break; }
      if (r.exitCode !== 0) {
        completeness = !r.threadId ? 'launch-failed' : looksRateLimited(r) ? 'rate-limited' : 'driver-failed';
        detail = `turn ${index}: exit ${r.exitCode ?? r.signal}; ${[...n.errors, r.stderr.trim().split('\n').at(-1) ?? ''].join(' ').slice(0, 300)}`;
        break;
      }
    }
    const first = labels[0]!;
    const thread = threads[first];
    const rolloutPath = thread ? findRollout(codexSessions[first]!.codexHome, thread) : null;
    if (rolloutPath) { rollout = readRollout(rolloutPath); writeRaw(`rollout-${first}.jsonl`, rollout.text); } else missing.push('combination.visibleModel', 'given.instructions', 'given.toolDescriptions');
    cpSync(workdir, join(dir, 'raw', 'work'), { recursive: true, filter: src => !src.includes('/node_modules') });
    rawFiles.push('work/');
  } catch (error) {
    completeness = service ? 'driver-failed' : 'service-failed';
    detail = String(error instanceof Error ? error.message : error).slice(0, 300);
  }
  let maps: AttemptRecord['maps'] = [];
  try {
    if (ctl) maps = (await ctl.exportCatalog()).map(m => ({ mapId: m.mapId, seedHeadRevision: seedHeads[m.mapId] ?? null, history: m.history }));
    else missing.push('maps');
  } catch (error) { missing.push('maps'); detail = `${detail ?? ''} catalog export failed: ${String(error)}`.trim(); }
  await ctl?.close().catch(() => undefined);
  const stopped = await service?.stop();
  if (service) { writeRaw('protocol.jsonl', existsSync(service.protocolReport) ? readFileSync(service.protocolReport, 'utf8') : ''); writeRaw('service.log', service.logs()); }
  for (const session of labels) rmSync(join(scratch, `home-${session}`, '.codex', 'auth.json'), { force: true });
  rmSync(scratch, { recursive: true, force: true });
  const realDb = realDatabasePath();
  const instructions = ctl?.instructions ?? '';
  const given: GivenRules = { phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions',
    rulesSource: { kind: 'instructions', versionLine: `version: ${ctl?.version ?? 'unknown'}` },
    instructions: rollout && shown(rollout.text, instructions.split('\n')[0] ?? '') ? { known: true, value: instructions }
      : { known: false, reason: rollout ? 'the instructions do not appear in what the client sent its model' : 'no session log' },
    toolDescriptions: rollout && ctl && Object.values(ctl.toolDescriptions).every(d => shown(rollout!.text, d)) ? { known: true, value: ctl.toolDescriptions }
      : { known: false, reason: rollout ? 'not every tool description appears in what the client sent its model' : 'no session log' },
    resources: 'undocumented', prompts: 'undocumented', extraContext: [] };
  const record: AttemptRecord = {
    schema: attemptSchema, attemptId: `${o.batchId}/${p.attemptId}`, batchId: o.batchId, subject: { kind: 'scenario', id: s.id, version: s.version },
    entry: 'mcp-only',
    combination: { harness: 'codex', requestedModel: o.model,
      visibleModel: rollout?.visibleModel ? { known: true, value: rollout.visibleModel } : { known: false, reason: 'not in the session log' },
      effort: rollout?.effort ? { known: true, value: rollout.effort } : { known: true, value: `${o.effort} (requested)` } },
    client: { version: rollout?.cliVersion ? { known: true, value: rollout.cliVersion } : (v => v ? { known: true as const, value: v } : { known: false as const, reason: 'codex --version failed' })(codexVersion(o.codex.bin)),
      surface: { known: true, value: 'codex exec' } },
    service: { commit: serviceCommit(), series: 'release', version: ctl?.version ?? 'unknown' },
    given: [given],
    run: { startedAt, endedAt: new Date().toISOString(), completeness, ...(detail ? { detail } : {}) },
    controller: { clientId: controller.clientId }, baitClientIds: [],
    sessions, events, maps, receipts: receiptsFrom(events),
    usage: usage.inputTokens || usage.outputTokens ? { known: true, value: usage } : { known: false, reason: 'no usage reported' },
    raw: { path: join(o.batchId, p.attemptId, 'raw'), files: rawFiles },
    missing: [...new Set(missing)],
  };
  const isolation = { serviceStopped: stopped ?? null, openDatabases: openedDatabases.length, servedOwnDatabase: service ? openedDatabases.includes(service.databasePath) : false,
    touchedRealDatabase: realDb ? openedDatabases.includes(realDb) : false, scratchRemoved: !existsSync(scratch) };
  const text = JSON.stringify({ ...record, isolation }, null, 1);
  if (leaks(text, secrets).length) throw new Error(`a credential would leak into ${p.attemptId}`);
  writeFileSync(join(dir, 'attempt.json'), tilde(text), { mode: 0o600 });
  return { attemptId: p.attemptId, scenario: s.id, completeness, ...(detail ? { detail } : {}), record: join(p.attemptId, 'attempt.json') };
}

export async function runBatch(o: BatchOptions): Promise<{ outcomes: AttemptOutcome[]; refusals: string[] }> {
  const { plan, refusals } = preflight(o);
  if (refusals.length) return { outcomes: [], refusals };
  if (existsSync(o.out)) return { outcomes: [], refusals: [`${tilde(o.out)} already exists; a Batch never reuses an output directory`] };
  if (o.scratchRoot.startsWith(homedir())) return { outcomes: [], refusals: ['scratch must live outside the home directory, where the sandbox allows writes'] };
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const before = isolationSnapshot();
  let cancel = false;
  let kill: (() => void) | undefined;
  const onSignal = () => { cancel = true; kill?.(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const outcomes: AttemptOutcome[] = [];
  try {
    for (const [i, p] of plan.entries()) {
      if (i >= o.ceiling) { outcomes.push({ attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'not-run', detail: `ceiling ${o.ceiling} reached` }); continue; }
      if (cancel) { outcomes.push({ attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'cancelled', detail: 'cancelled before start' }); continue; }
      outcomes.push(await runAttempt(o, p, () => cancel, k => { kill = k; }));
      console.log(`${p.attemptId}: ${outcomes.at(-1)!.completeness}${outcomes.at(-1)!.detail ? ` (${outcomes.at(-1)!.detail})` : ''}`);
    }
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  const after = isolationSnapshot();
  writeFileSync(join(o.out, 'batch.json'), JSON.stringify({ batchId: o.batchId, combination: `codex:${o.model}:${o.effort}`, entry: 'mcp-only',
    plan: plan.map(p => p.attemptId), ceiling: o.ceiling, outcomes, isolation: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) } }, null, 1), { mode: 0o600 });
  return { outcomes, refusals: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { batch: { type: 'string' }, scenarios: { type: 'string' }, count: { type: 'string', default: '1' },
    ceiling: { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' }, effort: { type: 'string', default: 'xhigh' },
    out: { type: 'string' }, codex: { type: 'string', default: 'codex' }, 'timeout-min': { type: 'string', default: '30' }, 'no-sandbox': { type: 'boolean', default: false } } });
  if (!values.batch || !values.scenarios || !values.ceiling) {
    console.error('usage: run.ts --batch <id> --scenarios S0b,F11 --count 2 --ceiling 4 [--model gpt-6-astra] [--effort xhigh]');
    process.exit(2);
  }
  const result = await runBatch({ batchId: values.batch, scenarios: values.scenarios.split(','), count: Number(values.count), ceiling: Number(values.ceiling),
    model: values.model, effort: values.effort, out: values.out ?? join(homedir(), 'Library/Application Support/Wayfinder/behaviour-runs', values.batch),
    codex: { bin: values.codex, sandbox: !values['no-sandbox'], timeoutMs: Number(values['timeout-min']) * 60_000 }, scratchRoot: '/private/tmp' });
  for (const r of result.refusals) console.error(`refused: ${r}`);
  if (result.refusals.length) process.exit(1);
}
