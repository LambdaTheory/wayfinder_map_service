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
import type { AttemptRecord, Completeness, EventRecord, Field, SessionRecord } from '../evidence.ts';
import { library } from '../library.ts';
import { fixturesRoot, readiness, validateScenario } from '../scenario.ts';
import type { Scenario } from '../scenario.ts';
import { clientSkills, findRollout, loginSecrets, looksRateLimited, prepareSession, prepareWorkdir, runTurn, writeProfile } from './codex.ts';
import type { CodexOptions, CodexSession } from './codex.ts';
import { connectController, historyCredentials } from './controller.ts';
import { initialRules, normalizeTurn, parseLines, readRollout, receiptsFrom } from './normalize.ts';
import type { RolloutFacts } from './normalize.ts';
import { checkoutRoot, everydayPort, newToken, startService } from './service.ts';
import type { Credential } from './service.ts';

export interface BatchOptions {
  batchId: string;
  scenarios: string[];
  count: number;
  ceiling: number;
  out: string;
  codex: CodexOptions;
  /** Where per-Attempt scratch (HOME, working directory) lives; outside the home directory, which the sandbox hides. */
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
    refusals.push(...validateScenario(s), ...readiness(s).map(r => `${id}: not ready: ${r}`));
    if (!s.applies.entries.includes('mcp-only')) refusals.push(`${id}: does not apply to the MCP-only Entry`);
    if (s.controller.length) refusals.push(`${id}: Controller actions (${s.controller.map(a => a.action).join(', ')}) are not supported by this runner yet (B02b)`);
    if (s.turns.some(t => t.concurrent || t.freshProcess)) refusals.push(`${id}: concurrent or fresh-process sessions are not supported by this runner yet (B02b)`);
    if (new Set(s.turns.map(t => t.session)).size > 1) refusals.push(`${id}: several sessions are not supported by this runner yet (B02b)`);
    for (let k = 1; k <= o.count; k++) plan.push({ attemptId: `${id}-${k}`, scenario: s });
  }
  return { plan, refusals };
}

const tilde = (p: string) => p.split(homedir()).join('~');
const sha = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const lsof = (...args: string[]) => spawnSync('lsof', args, { encoding: 'utf8' }).stdout;
const everydayPid = () => lsof('-nP', `-iTCP:${everydayPort}`, '-sTCP:LISTEN', '-t').trim() || null;
const openDatabases = (pid: string | number) => lsof('-p', String(pid), '-Fn').split('\n').filter(l => l.startsWith('n') && /\.sqlite$/.test(l)).map(l => l.slice(1));

/** Global state the runner must leave alone: personal client configuration and the everyday service. */
export function isolationSnapshot() {
  const files = ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json', '.codex-wayfinder/config.toml', '.wayfinder-service/credentials.json']
    .map(f => join(homedir(), f));
  return { files: Object.fromEntries(files.map(f => [tilde(f), sha(f)])), everydayServicePid: everydayPid() };
}

/** Whether the Attempt's service opened the everyday service's database; null when no everyday service runs to locate it. */
function touchedEverydayDatabase(opened: string[]): Field<boolean> {
  const pid = everydayPid();
  if (!pid) return { known: false, reason: 'no everyday service running, so its database could not be located' };
  const everyday = openDatabases(pid);
  return everyday.length ? { known: true, value: opened.some(p => everyday.includes(p)) } : { known: false, reason: 'the everyday service shows no open database' };
}

const codexVersion = (bin: string) => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const serviceCommit = () => { try { return execFileSync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };

interface Session { label: string; credential: Credential; codex: CodexSession; record: SessionRecord; rollout: RolloutFacts | null }

/** Every committed receipt must name a Revision its session's credential authored; agent Revisions without one stay unplaced. */
function attribution(record: AttemptRecord) {
  const clientOf = Object.fromEntries(record.sessions.map(s => [s.label, s.clientId]));
  const revisions = record.maps.flatMap(m => m.history.filter(r => m.seedHeadRevision === null || r.revision > m.seedHeadRevision));
  const committed = record.receipts.filter(r => r.outcome.kind === 'committed');
  const mismatched = committed.filter(r => !revisions.some(v => v.mapId === r.mapId && r.outcome.kind === 'committed' && v.revision === r.outcome.revision
    && v.author.clientId === clientOf[r.session])).map(r => r.callId);
  const unplaced = revisions.filter(v => v.author.clientId !== record.controller.clientId
    && !committed.some(r => r.mapId === v.mapId && r.outcome.kind === 'committed' && r.outcome.revision === v.revision)).map(v => `${v.mapId}@${v.revision}`);
  return { agentRevisions: revisions.length, committedReceipts: committed.length, mismatched, unplaced };
}

export async function runAttempt(o: BatchOptions, p: PlannedAttempt, cancelled: () => boolean, register: (kill: () => void) => void): Promise<AttemptOutcome> {
  const s = p.scenario;
  const dir = join(o.out, p.attemptId);
  mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(o.scratchRoot, `wf-behave-${p.attemptId}-`));
  const controller: Credential = { clientId: 'Behaviour-Controller', token: newToken() };
  const sessions: Session[] = [...new Set(s.turns.map(t => t.session))].map(label => {
    const credential = { clientId: `Behaviour.${o.batchId}.${p.attemptId}.${label}`, token: newToken() };
    return { label, credential, codex: prepareSession(scratch, label, credential.token), rollout: null,
      record: { label, nativeId: { known: false, reason: 'no thread started' }, clientId: credential.clientId,
        mcpSessionIds: { known: false, reason: 'Codex does not report MCP session IDs; service metadata (B07) will' }, turns: [] } };
  });
  const secrets: Record<string, string> = { 'controller-token': controller.token,
    ...Object.fromEntries(sessions.flatMap(x => [[`token-${x.label}`, x.credential.token], ...loginSecrets(x.codex).map((v, i) => [`codex-login-${x.label}-${i}`, v])])) };
  const startedAt = new Date().toISOString();
  const events: EventRecord[] = [];
  const rawFiles: string[] = [];
  const writeRaw = (name: string, text: string) => { writeFileSync(join(dir, 'raw', name), tilde(redact(text, secrets)), { mode: 0o600 }); rawFiles.push(name); };
  const usage = { inputTokens: 0, outputTokens: 0 };
  let completeness: Completeness = 'complete';
  let detail: string | undefined;
  const missing: string[] = [];
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let ctl: Awaited<ReturnType<typeof connectController>> | undefined;
  const seedHeads: Record<string, number> = {};
  const opened = new Set<string>();
  let skills: string[] = [];
  let seedingComplete = false;
  try {
    const historical = historyCredentials(s.seed.maps, [controller.clientId, ...sessions.map(x => x.credential.clientId)]);
    for (const [label, credential] of Object.entries(historical)) secrets[`history-token-${label}`] = credential.token;
    service = await startService(join(dir, 'service'), controller, [...sessions.map(x => x.credential), ...Object.values(historical)]);
    openDatabases(service.pid).forEach(d => opened.add(d));
    ctl = await connectController(service.port, controller.token, Object.fromEntries(Object.entries(historical).map(([label, c]) => [label, c.token])));
    for (const map of s.seed.maps) seedHeads[map.mapId] = await ctl.seed(map, revision => { seedHeads[map.mapId] = revision; });
    seedingComplete = true;
    const workdir = prepareWorkdir(scratch, s.seed.fixtures, fixturesRoot);
    const profile = writeProfile(scratch, o.codex.bin);
    let seq = 0;
    for (const [index, turn] of s.turns.entries()) {
      if (cancelled()) { completeness = 'cancelled'; break; }
      const session = sessions.find(x => x.label === turn.session)!;
      if (turn.kind === 'reply') {
        const last = events.findLast(e => e.kind === 'message' && e.role === 'assistant' && e.session === turn.session);
        if (!last || last.kind !== 'message' || !turn.answers!.cue.test(last.text)) {
          completeness = 'precondition-not-met'; detail = `turn ${index}: the proposal "${turn.answers!.proposal}" did not appear`; break;
        }
      }
      const r = await runTurn({ options: o.codex, session: session.codex, port: service.port, workdir, prompt: turn.say, profile, onChild: register });
      writeRaw(`turn-${index}-${turn.session}.stdout.jsonl`, r.stdout);
      if (r.stderr.trim()) writeRaw(`turn-${index}-${turn.session}.stderr.txt`, r.stderr);
      const n = normalizeTurn(parseLines(r.stdout), turn.session, index, turn.say, r.startedAt, seq, workdir);
      seq += n.events.length;
      events.push(...n.events);
      usage.inputTokens += n.usage.inputTokens; usage.outputTokens += n.usage.outputTokens;
      if (r.threadId) session.record.nativeId = { known: true, value: r.threadId };
      session.record.turns.push({ index, input: turn.say, startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs });
      openDatabases(service.pid).forEach(d => opened.add(d));
      if (cancelled()) { completeness = 'cancelled'; break; }
      if (r.timedOut) { completeness = 'timeout'; detail = `turn ${index} exceeded ${o.codex.timeoutMs} ms`; break; }
      if (r.exitCode !== 0 || !r.turnStarted) {
        completeness = !r.turnStarted ? 'launch-failed' : looksRateLimited(r) ? 'rate-limited' : 'driver-failed';
        detail = `turn ${index}: exit ${r.exitCode ?? r.signal}; ${[...n.errors, r.stderr.trim().split('\n').at(-1) ?? ''].join(' ').slice(0, 300)}`;
        break;
      }
    }
    for (const session of sessions) {
      const path = findRollout(session.codex);
      if (path) { session.rollout = readRollout(path); writeRaw(`rollout-${session.label}.jsonl`, session.rollout.text); }
    }
    skills = [...new Set(sessions.flatMap(x => clientSkills(x.codex)))];
    cpSync(workdir, join(dir, 'raw', 'work'), { recursive: true, filter: src => !src.includes('/node_modules') });
    rawFiles.push('work/');
  } catch (error) {
    if (completeness === 'complete') completeness = service ? 'driver-failed' : 'service-failed';
    detail = `${detail ?? ''} ${String(error instanceof Error ? error.message : error)}`.trim().slice(0, 300);
  }
  let maps: AttemptRecord['maps'] = [];
  try {
    if (!ctl) throw new Error('no Controller connection');
    maps = (await ctl.exportCatalog()).map(m => ({ mapId: m.mapId,
      // No agent turn starts until all seeding succeeds. This also recovers a committed write whose reply AND immediate reread were lost.
      seedHeadRevision: seedingComplete ? seedHeads[m.mapId] ?? null : m.history.at(-1)?.revision ?? null, history: m.history }));
  } catch (error) { missing.push('maps'); detail = `${detail ?? ''} catalog export failed: ${String(error instanceof Error ? error.message : error)}`.trim(); }
  await ctl?.close().catch(() => undefined);
  const stopped = await service?.stop();
  if (service) { writeRaw('protocol.jsonl', existsSync(service.protocolReport) ? readFileSync(service.protocolReport, 'utf8') : ''); writeRaw('service.log', service.logs()); }
  rmSync(scratch, { recursive: true, force: true });
  const first = sessions[0]!.rollout;
  const visibleModel: Field<string> = first?.visibleModel ? { known: true, value: first.visibleModel } : { known: false, reason: 'not in the session log' };
  const effort: Field<string> = first?.effort ? { known: true, value: first.effort } : { known: false, reason: `not in the session log; requested ${o.codex.effort}` };
  const version = codexVersion(o.codex.bin);
  const clientVersion: Field<string> = first?.cliVersion ? { known: true, value: first.cliVersion } : version ? { known: true, value: version } : { known: false, reason: 'codex --version failed' };
  const given = initialRules(ctl?.version ?? 'unknown', ctl?.instructions ?? '', ctl?.toolDescriptions ?? {}, first);
  const record: AttemptRecord = {
    schema: attemptSchema, attemptId: `${o.batchId}/${p.attemptId}`, batchId: o.batchId, subject: { kind: 'scenario', id: s.id, version: s.version },
    entry: 'mcp-only', combination: { harness: 'codex', requestedModel: o.codex.model, visibleModel, effort },
    client: { version: clientVersion, surface: { known: true, value: 'codex exec' } },
    service: { commit: serviceCommit(), series: 'release', version: ctl?.version ?? 'unknown' },
    given: [given],
    run: { startedAt, endedAt: new Date().toISOString(), completeness, ...(detail ? { detail } : {}) },
    controller: { clientId: controller.clientId }, baitClientIds: [],
    sessions: sessions.map(x => x.record), events, maps, receipts: receiptsFrom(events),
    usage: usage.inputTokens || usage.outputTokens ? { known: true, value: usage } : { known: false, reason: 'no usage reported' },
    raw: { path: join(o.batchId, p.attemptId, 'raw'), files: rawFiles },
    missing: [],
  };
  // Every field recorded as unknown is also listed, so a gap is visible without walking the record.
  const unknownFields: [string, Field<unknown>][] = [['combination.visibleModel', visibleModel], ['combination.effort', effort], ['client.version', clientVersion],
    ['given[0].instructions', given.instructions], ['given[0].toolDescriptions', given.toolDescriptions], ['usage', record.usage],
    ...record.sessions.map((x, i): [string, Field<unknown>] => [`sessions[${i}].nativeId`, x.nativeId])];
  record.missing = [...new Set([...missing, ...unknownFields.filter(([, f]) => !f.known).map(([path]) => path)])];
  const isolation = { sandbox: o.codex.sandbox, serviceStopped: stopped ?? null, servedOwnDatabase: service ? opened.has(service.databasePath) : false,
    touchedEverydayDatabase: touchedEverydayDatabase([...opened]), scratchRemoved: !existsSync(scratch), clientSkills: skills, attribution: attribution(record) };
  const text = tilde(redact(JSON.stringify({ ...record, isolation }, null, 1), secrets));
  if (leaks(text, secrets).length) return { attemptId: p.attemptId, scenario: s.id, completeness: 'driver-failed', detail: 'a credential survived redaction; record withheld' };
  writeFileSync(join(dir, 'attempt.json'), text, { mode: 0o600 });
  return { attemptId: p.attemptId, scenario: s.id, completeness, ...(detail ? { detail } : {}), record: join(p.attemptId, 'attempt.json') };
}

export async function runBatch(o: BatchOptions): Promise<{ outcomes: AttemptOutcome[]; refusals: string[] }> {
  const { plan, refusals } = preflight(o);
  if (refusals.length) return { outcomes: [], refusals };
  if (existsSync(o.out)) return { outcomes: [], refusals: [`${tilde(o.out)} already exists; a Batch never reuses an output directory`] };
  if (o.scratchRoot.startsWith(homedir())) return { outcomes: [], refusals: ['scratch must live outside the home directory, which the sandbox hides'] };
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const before = isolationSnapshot();
  let cancel = false;
  let kill: (() => void) | undefined;
  const onSignal = () => { cancel = true; kill?.(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const outcomes: AttemptOutcome[] = [];
  try {
    for (const [i, p] of plan.entries()) {
      let outcome: AttemptOutcome;
      if (i >= o.ceiling) outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'not-run', detail: `ceiling ${o.ceiling} reached` };
      else if (cancel) outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'cancelled', detail: 'cancelled before start' };
      else {
        try { outcome = await runAttempt(o, p, () => cancel, k => { kill = k; }); }
        catch (error) { outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'driver-failed', detail: String(error instanceof Error ? error.message : error).slice(0, 300) }; }
      }
      outcomes.push(outcome);
      console.log(`${p.attemptId}: ${outcome.completeness}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  const after = isolationSnapshot();
  // Other clients may edit personal configuration during a Batch; what matters is that none of it names this run.
  const mentionsRun = Object.keys(after.files).filter(f => { const path = f.replace(/^~/, homedir());
    return existsSync(path) && /wf-behave-|behaviour-runs|Behaviour[.-]/.test(readFileSync(path, 'utf8')); });
  writeFileSync(join(o.out, 'batch.json'), JSON.stringify({ batchId: o.batchId, combination: `codex:${o.codex.model}:${o.codex.effort}`, entry: 'mcp-only',
    sandbox: o.codex.sandbox, plan: plan.map(p => p.attemptId), ceiling: o.ceiling, outcomes,
    isolation: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after), personalConfigNamingThisRun: mentionsRun } }, null, 1), { mode: 0o600 });
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
    out: values.out ?? join(homedir(), 'Library/Application Support/Wayfinder/behaviour-runs', values.batch), scratchRoot: '/private/tmp',
    codex: { model: values.model, effort: values.effort, bin: values.codex, sandbox: !values['no-sandbox'], timeoutMs: Number(values['timeout-min']) * 60_000 } });
  for (const r of result.refusals) console.error(`refused: ${r}`);
  if (result.refusals.length) process.exit(1);
}
