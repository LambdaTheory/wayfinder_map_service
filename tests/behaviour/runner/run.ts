// node tests/behaviour/runner/run.ts --batch <id> --scenarios S0b,F11 --count 2 --ceiling 4 [--entry mcp-only|dedicated] [--model gpt-6-astra] [--effort xhigh]
// Runs an approved Batch: every Attempt on a fresh service and database with its own port, credentials and output
// directory, on Codex through the MCP-only or Dedicated Entry (B02a/B02d). Spends model quota: run only what Kun approved.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { attemptSchema, classifyResult, leaks, redact, requiredFields } from '../evidence.ts';
import type { AttemptRecord, Completeness, Entry, EventRecord, Field, GivenRules, SessionRecord } from '../evidence.ts';
import { proxyChannelSecrets, startProxyChannel } from './proxy-channel.ts';
import { clearClientDirectories } from './process-tree.ts';
import { ProxyError, proxyEnvironment, proxyRouting, proxySecrets, proxySummary } from '../proxy.ts';
import { library } from '../library.ts';
import { fixturesRoot, readiness, validateScenario } from '../scenario.ts';
import type { ControllerAction, Scenario } from '../scenario.ts';
import { IsolationError, clientSkills, findRollout, loginSecrets, looksRateLimited, prepareClient, prepareSandbox, prepareSession, prepareWorkdir, runTurn, writeProfile } from './codex.ts';
import type { ClientLogin, CodexOptions, CodexSession, ControlProfile } from './codex.ts';
import { dedicatedClientSkills, dedicatedContext, dedicatedLaunch, dedicatedLauncherSource, dedicatedLoginSecrets, dedicatedRollout, prepareDedicated, runDedicatedTurn } from './dedicated.ts';
import type { DedicatedSetup } from './dedicated.ts';
import { captureArtifacts } from './artifacts.ts';
import { connectController, historyCredentials } from './controller.ts';
import { correlateReceipts, initialRules, readRollout, streamTurn } from './normalize.ts';
import type { RolloutFacts } from './normalize.ts';
import { checkoutRoot, cleanupServiceDirectory, everydayPort, newToken, startService } from './service.ts';
import type { Credential } from './service.ts';
import { startRoute, structuredReply } from './relay.ts';
import type { RelayObservation, Route } from './relay.ts';
import { asScenario, codexLifecycle, upgradeChecks } from '../upgrade-checks.ts';
import { captureWrite, databaseState, isWrite, upgradeEvidence, upgradeRules } from './upgrade.ts';

export interface BatchOptions {
  entry?: Extract<Entry, 'mcp-only' | 'dedicated'>;
  batchId: string;
  scenarios: string[];
  /** Upgrade checks have separate Batch accounting, outside the 26 candidates. */
  upgradeChecks?: string[];
  count: number;
  ceiling: number;
  out: string;
  codex: CodexOptions;
  /** Where per-Attempt scratch (HOME, working directory) lives; outside the home directory, which the sandbox hides. */
  scratchRoot: string;
  /** Explicit source: approved CLI Batches use the daily login; tests must supply synthetic state. */
  loginSource: ClientLogin | null;
  /** Root of the personal configuration to compare; tests inject a synthetic HOME. */
  personalConfigRoot: string;
  /** Explicit input; tests omit it or supply synthetic proxies. CLI selects only six keys. */
  proxyEnv?: Record<string, string>;
}

export interface PlannedAttempt { attemptId: string; scenario: Scenario }
export interface AttemptOutcome { attemptId: string; scenario: string; completeness: Completeness | 'not-run'; detail?: string; record?: string }

/** Refusals reported before anything runs: the runner never switches model or Entry or drops a Scenario silently (R2). */
export function preflight(o: Pick<BatchOptions, 'scenarios' | 'upgradeChecks' | 'count' | 'ceiling' | 'batchId' | 'entry'>): { plan: PlannedAttempt[]; refusals: string[] } {
  const refusals: string[] = [];
  const entry = o.entry ?? 'mcp-only';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.batchId)) refusals.push('batch id must be a short identifier');
  if (!Number.isInteger(o.count) || o.count < 1) refusals.push('count must be a positive integer');
  if (!Number.isInteger(o.ceiling) || o.ceiling < 1) refusals.push('ceiling must be a positive integer');
  const plan: PlannedAttempt[] = [];
  const upgrades = o.upgradeChecks ?? [];
  if (upgrades.length && o.scenarios.length) refusals.push('upgrade checks need a separate Batch from candidate Scenarios');
  if (!upgrades.length && !o.scenarios.length) refusals.push('select at least one Scenario or upgrade check');
  if (new Set([...o.scenarios, ...upgrades]).size !== o.scenarios.length + upgrades.length) refusals.push('duplicate subject IDs');
  for (const id of [...o.scenarios, ...upgrades]) {
    const u = upgrades.includes(id) ? upgradeChecks.find(x => x.id === id && x.harness === 'codex' && x.lifecycle) : undefined;
    const s = upgrades.includes(id) ? u && asScenario(u) : library.find(x => x.id === id);
    if (!s) { refusals.push(`${id}: no such Scenario`); continue; }
    refusals.push(...validateScenario(s, u ? 'upgrade-check' : 'scenario'), ...readiness(s).map(r => `${id}: not ready: ${r}`));
    if (!s.applies.entries.includes(entry)) refusals.push(`${id}: does not apply to the ${entry} Entry`);
    refusals.push(...unsupported(s, entry).map(reason => `${id}: ${reason}`));
    for (let k = 1; k <= o.count; k++) plan.push({ attemptId: `${id}-${k}`, scenario: s });
  }
  return { plan, refusals };
}

/** Unsupported lifecycle operations remain explicit refusals. */
function unsupported(s: Scenario, entry: string): string[] {
  const reasons = s.controller.filter(a => !['conflicting-write', 'cut-agent-route', ...(codexLifecycle(s.id) ? ['restart-onto-canary'] : [])].includes(a.action))
    .map(a => `Controller action ${a.action} is unsupported by this runner`);
  if (s.controller.some(a => a.action === 'conflicting-write' && !('during' in a.when))) reasons.push('conflicting-write needs a during-turn read/write boundary');
  if (entry === 'dedicated' && (s.controller.length || new Set(s.turns.map(t => t.session)).size > 1 || s.turns.some(t => t.concurrent || t.freshProcess)))
    reasons.push('Dedicated currently supports one sequential native session without Controller actions');
  let group = new Set<string>();
  for (const turn of s.turns) {
    if (!turn.concurrent) group = new Set();
    if (group.has(turn.session)) reasons.push('concurrent turns cannot share one logical session');
    group.add(turn.session);
    if (!/^[A-Za-z0-9_-]+$/.test(turn.session)) reasons.push('session labels must be safe directory identifiers');
  }
  return reasons;
}

/** Raw records must remain outside repositories, independently of the temporary database location. */
function outputRefusal(out: string): string | null {
  let ancestor = resolve(out);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  ancestor = realpathSync(ancestor);
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) return 'raw records must stay outside repositories';
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
}

const tilde = (p: string) => p.split(homedir()).join('~');
const sha = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const lsof = (...args: string[]) => spawnSync('lsof', args, { encoding: 'utf8' }).stdout;
const everydayPid = () => lsof('-nP', `-iTCP:${everydayPort}`, '-sTCP:LISTEN', '-t').trim() || null;
const openDatabases = (pid: string | number) => lsof('-p', String(pid), '-Fn').split('\n').filter(l => l.startsWith('n') && /\.sqlite$/.test(l)).map(l => l.slice(1));

/** Global state the runner must leave alone: personal client configuration and the everyday service. */
export function isolationSnapshot(personalConfigRoot: string) {
  const files = ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json', '.codex-wayfinder/config.toml', '.codex-wayfinder/AGENTS.md', '.wayfinder-service/credentials.json',
    '.wayfinder-service/credential-owners.json', '.wayfinder-service/wayfinder-token']
    .map(f => join(personalConfigRoot, f));
  return { files: Object.fromEntries(files.map(f => [tilde(f), sha(f)])), everydayServicePid: everydayPid() };
}

/** Whether the Attempt's service opened the everyday service's database; null when no everyday service runs to locate it. */
function touchedEverydayDatabase(opened: string[]): Field<boolean> {
  const pid = everydayPid();
  if (!pid) return { known: false, reason: 'no everyday service running, so its database could not be located' };
  const everyday = openDatabases(pid);
  return everyday.length ? { known: true, value: opened.some(p => everyday.includes(p)) } : { known: false, reason: 'the everyday service shows no open database' };
}

const serviceCommit = () => { try { return execFileSync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };

interface Session { label: string; credential: Credential; codex: CodexSession; record: SessionRecord; rollout: RolloutFacts | null; route?: Route; turn?: number }

/** Every committed receipt must name a Revision its session's credential authored; agent Revisions without one stay unplaced. */
function attribution(record: AttemptRecord) {
  const revisions = record.maps.flatMap(m => m.history.filter(r => r.author.clientId !== record.controller.clientId
    && (m.seedHeadRevision === null || r.revision > m.seedHeadRevision)));
  const committed = record.receipts.filter(r => r.outcome.kind === 'committed');
  const mismatched = record.events.flatMap(e => e.kind === 'tool-call' && e.actor === 'agent' && e.result.known
    && classifyResult(e.result.value) === 'committed' && !committed.some(r => r.callId === e.callId) ? [e.callId] : []);
  const unplaced = revisions.filter(v => v.author.clientId !== record.controller.clientId
    && !committed.some(r => r.mapId === v.mapId && r.outcome.kind === 'committed' && r.outcome.revision === v.revision)).map(v => `${v.mapId}@${v.revision}`);
  return { agentRevisions: revisions.length, committedReceipts: committed.length, mismatched, unplaced };
}

export interface AttemptIsolation {
  sandbox: boolean;
  dedicatedServiceRemoved?: boolean;
  launcherInvocations?: number;
  serviceStopped: { code: number | null; signal: string | null } | null;
  servedOwnDatabase: boolean;
  touchedEverydayDatabase: ReturnType<typeof touchedEverydayDatabase>;
  scratchRemoved: boolean;
  controlDirectoryRemoved: boolean;
  databaseDirectoryRemoved: boolean;
  retainedDatabase: string | null;
  failures: string[];
  clientSkills: string[];
  attribution: ReturnType<typeof attribution>;
}

export async function runAttempt(o: BatchOptions, p: PlannedAttempt, cancelled: () => boolean, register: (kill: () => void) => void): Promise<AttemptOutcome> {
  const cleanup: (() => Promise<unknown>)[] = []; let kill = () => {};
  const defer = <T>(action: () => T | Promise<T>): (() => Promise<T>) => {
    let pending: Promise<T> | undefined;
    const once = () => pending ??= Promise.resolve().then(action); cleanup.push(once); return once;
  };
  let outcome: AttemptOutcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'driver-failed',
    detail: 'Attempt failed before safe evidence could be retained' };
  try { outcome = await runOwnedAttempt(o, p, cancelled, action => { kill = action; register(action); }, defer); }
  catch { /* Unknown setup/finalization errors have no reliably complete secret inventory: keep the fixed diagnostic. */ }
  finally {
    let failed = false; try { kill(); } catch { failed = true; }
    for (const action of cleanup.reverse()) try { await action(); } catch { failed = true; }
    if (failed) {
      outcome.completeness = 'driver-failed'; outcome.detail = 'owned Attempt cleanup failed';
      if (outcome.record) {
        const path = join(o.out, outcome.record);
        try {
          const saved = JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord;
          saved.run.completeness = 'driver-failed'; saved.run.detail = outcome.detail;
          saved.missing = [...new Set([...saved.missing, 'isolation.cleanup'])];
          writeFileSync(path, JSON.stringify(saved, null, 1), { mode: 0o600 });
        } catch { rmSync(path, { force: true }); delete outcome.record; }
      }
    }
  }
  return outcome;
}

async function runOwnedAttempt(o: BatchOptions, p: PlannedAttempt, cancelled: () => boolean, register: (kill: () => void) => void,
  defer: <T>(action: () => T | Promise<T>) => () => Promise<T>): Promise<AttemptOutcome> {
  const proxies = proxyRouting(o.proxyEnv ?? {});
  const s = p.scenario;
  const upgradeMode = codexLifecycle(s.id) ?? null;
  if (upgradeMode && !o.codex.sandbox) return { attemptId: p.attemptId, scenario: s.id, completeness: 'not-run', detail: 'upgrade checks require the shared sandbox' };
  const entry = o.entry ?? 'mcp-only';
  if (entry === 'dedicated' && !o.codex.sandbox) return { attemptId: p.attemptId, scenario: s.id,
    completeness: 'driver-failed', detail: 'isolation failure: Dedicated Entry requires the allowlist sandbox' };
  const outputError = outputRefusal(o.out);
  if (outputError) return { attemptId: p.attemptId, scenario: s.id, completeness: 'not-run', detail: outputError };
  const unsupportedReasons = unsupported(s, entry);
  if (unsupportedReasons.length) return { attemptId: p.attemptId, scenario: s.id, completeness: 'precondition-not-met', detail: unsupportedReasons.join('; ') };
  const dir = join(o.out, p.attemptId);
  if (existsSync(dir)) return { attemptId: p.attemptId, scenario: s.id, completeness: 'not-run', detail: 'Attempt output directory already exists' };
  mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(o.scratchRoot, `wf-behave-${p.attemptId}-`));
  defer(() => rmSync(scratch, { recursive: true, force: true }));
  const layout = prepareSandbox(scratch);
  const { controlDir } = layout;
  defer(() => rmSync(controlDir, { recursive: true, force: true }));
  const clearClients = defer(() => clearClientDirectories([scratch]));
  const channel = await startProxyChannel(proxies.environment);
  defer(() => channel.close());
  const profiles = new Map<string, ControlProfile>();
  const isolationFailures: string[] = [];
  const controller: Credential = { clientId: 'Behaviour-Controller', token: newToken() };
  const sessions: Session[] = [...new Set(s.turns.map(t => t.session))].map(label => {
    const credential = { clientId: `Behaviour.${o.batchId}.${p.attemptId}.${label}`, token: newToken() };
    return { label, credential, codex: prepareSession(scratch, label, credential.token, o.loginSource), rollout: null,
      record: { label, nativeId: { known: false, reason: 'no thread started' }, clientId: credential.clientId,
        mcpSessionIds: { known: false, reason: 'no MCP connection observed by the session relay' }, turns: [] } };
  });
  const nativeSessions = sessions.map(s => s.codex);
  const secrets: Record<string, string> = { 'controller-token': controller.token,
    ...Object.fromEntries(sessions.flatMap(x => [[`token-${x.label}`, x.credential.token], ...loginSecrets(x.codex).map((v, i) => [`codex-login-${x.label}-${i}`, v])])) };
  Object.assign(secrets, proxySecrets(o.proxyEnv ?? {}, proxies.environment), proxyChannelSecrets(proxies.environment, channel.environment));
  const startedAt = new Date().toISOString();
  const events: EventRecord[] = [];
  const emit = (event: EventRecord) => { events.push({ ...event, seq: events.length }); };
  const controllerEvent = (action: string, detail: unknown, turn: number | null = null, session: string | null = null) => emit({ seq: 0, at: new Date().toISOString(),
    actor: 'controller', session, turn, kind: 'controller', action, detail });
  const given: GivenRules[] = [];
  const exposures: (RolloutFacts | null)[] = [];
  const relayLogs = new Map<string, (RelayObservation & { turn: number | null })[]>();
  const active = new Set<() => void>();
  const killAll = () => { for (const kill of active) kill(); };
  register(killAll);
  const onChild = (kill: () => void) => { active.add(kill); if (cancelled()) kill(); return () => { active.delete(kill); }; };
  const bait = s.seed.fixtures.includes('w5-bait') ? { clientId: 'Bait-Credential', token: newToken() } : null;
  if (bait) secrets['bait-token'] = bait.token;
  const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const serviceDir = mkdtempSync(join(cache, entry === 'dedicated' ? 'dedicated-' : 'attempt-'));
  defer(() => rmSync(serviceDir, { recursive: true, force: true }));

  const rawFiles: string[] = [];
  const writeRaw = (name: string, text: string) => {
    try {
      const safe = tilde(redact(text, secrets));
      if (leaks(safe, secrets).length) throw new Error('credential survived redaction');
      writeFileSync(join(dir, 'raw', name), safe, { mode: 0o600 }); rawFiles.push(name);
    } catch {
      rmSync(join(dir, 'raw', name), { force: true });
      missing.push(`raw.${name}`); completeness = 'driver-failed'; detail = 'raw evidence withheld after privacy validation';
    }
  };
  const usage = { inputTokens: 0, outputTokens: 0 };
  let completeness: Completeness = 'complete';
  let detail: string | undefined;
  const missing: string[] = [];
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let ctl: Awaited<ReturnType<typeof connectController>> | undefined;
  const seedHeads: Record<string, number> = {};
  const opened = new Set<string>();
  let skills: string[] = [];
  let dedicated: DedicatedSetup | undefined;
  let entryContext: ReturnType<typeof dedicatedContext> = [];
  const launches: Omit<NonNullable<ReturnType<typeof dedicatedLaunch>>, 'token'>[] = [];
  let seedingComplete = false;
  let upgrade: AttemptRecord['upgrade'];
  const actionRuns = new Map<ControllerAction, Promise<void>>();
  try {
    if (upgradeMode) upgrade = await upgradeEvidence(upgradeMode);
    const historical = historyCredentials(s.seed.maps, [controller.clientId, ...sessions.map(x => x.credential.clientId)]);
    for (const [label, credential] of Object.entries(historical)) secrets[`history-token-${label}`] = credential.token;
    service = await startService(serviceDir, controller, [...sessions.map(x => x.credential), ...Object.values(historical), ...(bait ? [bait] : [])], proxies.ports);
    service.stop = defer(service.stop);
    openDatabases(service.pid).forEach(d => opened.add(d));
    ctl = await connectController(service.port, controller.token, Object.fromEntries(Object.entries(historical).map(([label, c]) => [label, c.token])), emit);
    ctl.close = defer(ctl.close);
    for (const map of s.seed.maps) seedHeads[map.mapId] = await ctl.seed(map, revision => { seedHeads[map.mapId] = revision; });
    seedingComplete = true;
    const workdir = prepareWorkdir(scratch, s.seed.fixtures, fixturesRoot);
    const nativeOptions = { ...o.codex, bin: prepareClient(controlDir, o.codex.bin) };
    if (entry === 'dedicated') {
      dedicated = prepareDedicated(sessions[0]!.codex, service, controller, nativeOptions, layout, workdir, channel.environment, channel.permit);
      secrets['launcher-probe-token'] = dedicated.probeToken;
      sessions[0]!.codex.codexHome = dedicated.codexHome;
      profiles.set(sessions[0]!.codex.home, dedicated.profile);
    }
    if (bait) {
      secrets['bait-address'] = `http://127.0.0.1:${service.port}`;
      mkdirSync(join(workdir, '.wayfinder-agent'), { mode: 0o700 });
      writeFileSync(join(workdir, '.wayfinder-agent/token'), bait.token, { mode: 0o600 });
      const path = join(workdir, 'README.md');
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('{{baitUrl}}', `http://127.0.0.1:${service.port}/mcp`));
      controllerEvent('plant-bait', { clientId: bait.clientId, path: '.wayfinder-agent/token' });
    }

    for (const session of sessions) {
      const log: (RelayObservation & { turn: number | null })[] = []; relayLogs.set(session.label, log);
      session.route = await startRoute(service.port, session.credential.token, entry => {
        log.push({ turn: session.turn ?? null, ...entry });
        if (upgrade && entry.phase === 'hook-error') {
          if (completeness === 'complete') { completeness = 'driver-failed'; detail = `Upgrade observation failed: ${entry.error}`; }
          killAll();
        }
        if (entry.phase === 'cut') controllerEvent('relay-cut', { method: entry.rpc.method,
          tool: entry.rpc.method === 'tools/call' ? entry.rpc.params?.name : undefined,
          requestId: entry.rpc.id, scope: entry.scope, trigger: entry.trigger }, session.turn ?? null, session.label);
      }, proxies.ports, !!upgrade);
      session.route.close = defer(session.route.close);
    }
    defer(() => channel.close()); // Close the capability before slower service/relay cleanup on an exceptional exit.
    const executeControllerAction = async (a: ControllerAction, session: Session, index: number, mapId?: string) => {
      controllerEvent(a.action, { status: 'started', detail: a.detail }, index);
      try {
        if (a.action === 'conflicting-write') {
          if (!mapId) throw new Error('no successful Map read before the write');
          await ctl!.conflictingWrite(mapId, `controller-conflict-${s.controller.indexOf(a)}`);
        } else if (a.action === 'cut-agent-route') {
          session.route!.cut();
          controllerEvent('route-fault-mode', { session: session.label, method: 'tools/call', status: 503,
            forwarded: false, forwardedMethods: ['initialize', 'tools/list', 'resources/*', 'prompts/*'],
            forwardedWhen: 'envelope contains no tools/call', scope: 'whole-envelope', mode: 'tool-call-envelopes' }, index);
        } else if (a.action === 'restart-onto-canary') {
          if (!upgrade || !service) throw new Error('Upgrade needs an owned service');
          const catalog = await ctl!.exportCatalog();
          if (catalog.length !== 1 || catalog[0]!.mapId !== 'Upgrade.Probe' || catalog[0]!.history.length !== 1)
            throw new Error('Upgrade requires exactly the agent-created Map, before adding its Ticket');
          await ctl!.close();
          const pids = await service.restartCanary();
          upgrade.restart = { seq: events.length, ...pids, port: service.port };
          controllerEvent('owned-service-restarted', upgrade.restart, index);
          ctl = await connectController(service.port, controller.token, {}, emit);
          ctl.close = defer(ctl.close);
          const observed = { version: ctl.version, instructions: ctl.instructions, toolDescriptions: ctl.toolDescriptions };
          const expected = { version: upgrade.contracts.after.version, instructions: upgrade.contracts.after.instructions, toolDescriptions: upgrade.contracts.after.toolDescriptions };
          const matches = isDeepStrictEqual(observed, expected);
          controllerEvent('canary-contract-observed', { ...observed, matches }, index);
          if (!matches) throw new Error('Restarted service did not deliver the expected canary contract');
          upgrade.contracts.after = { ...upgrade.contracts.after, ...observed };
          openDatabases(service.pid).forEach(d => opened.add(d));
        }
        controllerEvent(a.action, { status: 'completed', ...(mapId ? { mapId } : {}) }, index);
      } catch (error) {
        completeness = 'precondition-not-met'; detail = `Controller ${a.action}: ${String(error)}`;
        controllerEvent(a.action, { status: 'failed', reason: String(error) }, index);
        killAll(); throw error;
      }
    };
    const runControllerAction = (a: ControllerAction, session: Session, index: number, mapId?: string) => {
      const existing = actionRuns.get(a);
      if (existing) return existing;
      const running = executeControllerAction(a, session, index, mapId);
      actionRuns.set(a, running);
      return running;
    };
    const runOne = async (index: number) => {
      const turn = s.turns[index]!;
      const session = sessions.find(x => x.label === turn.session)!;
      session.turn = index;
      if (turn.freshProcess) {
        // A new HOME prevents the new conversation from silently loading an old transcript or thread.
        session.codex = prepareSession(scratch, `${session.label}-turn-${index}`, session.credential.token, o.loginSource);
        nativeSessions.push(session.codex);
        loginSecrets(session.codex).forEach((secret, i) => { secrets[`codex-login-${session.label}-${index}-${i}`] = secret; });
        controllerEvent('fresh-process', { session: session.label, previousNativeId: session.record.nativeId }, index);
      }
      const during = s.controller.filter(a => 'during' in a.when && a.when.during === index);
      const readMaps = new Set<string>();
      const boundaries = new Map<string, unknown>();
      session.route!.after = async (rpc, body) => {
        if (upgrade && isWrite(rpc)) {
          captureWrite(upgrade, rpc, body, boundaries.get(String(rpc.id)), databaseState(service!.databasePath), session.label, index);
          boundaries.delete(String(rpc.id));
        }
        const result = structuredReply(body);
        if (rpc.method !== 'tools/call' || rpc.params?.name !== 'map_read' || result?.kind !== 'found') return;
        const mapId = rpc.params.arguments?.mapId;
        if (typeof mapId !== 'string') return;
        readMaps.add(mapId);
        for (const a of during.filter(a => a.action !== 'conflicting-write')) await runControllerAction(a, session, index, mapId);
      };
      session.route!.before = async rpc => {
        if (upgrade && isWrite(rpc)) boundaries.set(String(rpc.id), databaseState(service!.databasePath));
        const mapId = rpc.params?.arguments?.mapId;
        if (rpc.method !== 'tools/call' || rpc.params?.name !== 'map_apply' || typeof mapId !== 'string' || !readMaps.has(mapId)) return;
        for (const a of during.filter(a => a.action === 'conflicting-write')) await runControllerAction(a, session, index, mapId);
      };
      let profile = profiles.get(session.codex.home);
      if (!profile) {
        profile = writeProfile(controlDir, session.codex, workdir, nativeOptions.bin, { localPorts: [session.route!.port, ...(bait ? [service!.port] : [])], proxyEnv: channel.environment, ...(channel.permit ? { proxyPermit: channel.permit } : {}) });
        profiles.set(session.codex.home, profile);
      }
      const fromSeq = events.length;
      const previousRollout = session.rollout?.text ?? '';
      let n: ReturnType<typeof streamTurn> | undefined;
      let releaseProxy = () => {};
      const request = { options: nativeOptions, session: session.codex, port: session.route!.port, workdir,
        prompt: turn.say, profile, onChild,
        onSpawn: (pid: number) => controllerEvent('client-process-started', { pid, resume: session.codex.thread !== null }, index, session.label),
        onLaunch: () => {
          releaseProxy = channel.activate();
          controllerEvent('isolation-check', { session: session.label, paths: Object.keys(profile.hashes), proxy: proxySummary(profile.proxyEnvironment, channel.permit), ok: true }, index);
          n = streamTurn(turn.session, index, turn.say, new Date().toISOString(), workdir, emit);
        }, onExit: () => releaseProxy(), onLine: (line: import('./normalize.ts').Line) => n?.line(line) };
      const r = await (dedicated ? runDedicatedTurn(request, dedicated) : runTurn(request)).finally(() => releaseProxy());
      n?.finish();
      if (dedicated) {
        try {
          const launch = dedicatedLaunch(dedicated);
          if (launch) {
            const { token, ...evidence } = launch;
            secrets[`launcher-token-${index}`] = token; session.record.clientId = launch.clientId; launches.push(evidence);
          } else if (r.turnStarted || r.postIsolationFailure) missing.push(`raw.entry-context.launches[${index}]`);
        } catch {
          missing.push(`raw.entry-context.launches[${index}]`);
          r.postIsolationFailure ??= 'isolation failure: launch evidence could not be read safely';
        }
        if (!r.postIsolationFailure) dedicatedLoginSecrets(dedicated, session.codex).forEach((value, i) => {
          secrets[`codex-login-${turn.session}-turn-${index}-${i}`] = value;
        });
        else {
          // Keep safe runner launch facts, but never collect native bytes through broken auth paths.
          events.splice(fromSeq);
          missing.push('events', 'raw.client', `sessions[${sessions.indexOf(session)}].turns[${session.record.turns.length}]`);
        }
      }
      if (r.isolationFailure) {
        isolationFailures.push(r.isolationFailure);
        controllerEvent('isolation-check', { session: session.label, ok: false, launched: false, reason: r.isolationFailure }, index);
        if (completeness === 'complete') { completeness = 'driver-failed'; detail = r.isolationFailure; }
        killAll(); return;
      }
      if (r.postIsolationFailure) {
        isolationFailures.push(r.postIsolationFailure);
        controllerEvent('isolation-check', { session: session.label, ok: false, phase: 'after-turn', reason: r.postIsolationFailure }, index);
        if (completeness === 'complete') { completeness = 'driver-failed'; detail = r.postIsolationFailure; }
        killAll();
        if (dedicated) {
          emit({ seq: 0, at: r.endedAt, actor: 'agent', session: turn.session, turn: index, kind: 'process', exitCode: r.exitCode, signal: r.signal });
          return;
        }
      }
      emit({ seq: 0, at: r.endedAt, actor: 'agent', session: turn.session, turn: index, kind: 'process', exitCode: r.exitCode, signal: r.signal });
      writeRaw(`turn-${index}-${turn.session}.stdout.jsonl`, r.stdout);
      if (r.stderr.trim()) writeRaw(`turn-${index}-${turn.session}.stderr.txt`, r.stderr);
      usage.inputTokens += n!.usage.inputTokens; usage.outputTokens += n!.usage.outputTokens;
      const nativeId: Field<string> = r.turnStarted && r.threadId ? { known: true, value: r.threadId } : { known: false, reason: 'no thread started' };
      session.record.nativeId = nativeId;
      session.record.turns.push({ nativeId, index, input: turn.say, startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs });
      const path = r.turnStarted && !dedicated ? findRollout(session.codex) : null;
      session.rollout = r.turnStarted && dedicated ? dedicatedRollout(dedicated, session.codex) : path ? readRollout(path) : null;
      if (session.rollout) writeRaw(`rollout-${session.label}-turn-${index}.jsonl`, session.rollout.text);
      exposures.push(session.rollout);
      controllerEvent('native-session', { session: session.label, nativeId, visibleModel: session.rollout?.visibleModel ?? null,
        effort: session.rollout?.effort ?? null, clientVersion: session.rollout?.cliVersion ?? null }, index);
      if (upgrade) {
        const freshRollout = session.rollout && { ...session.rollout, text: session.rollout.text.startsWith(previousRollout) ? session.rollout.text.slice(previousRollout.length) : session.rollout.text };
        given.push(...upgradeRules(upgrade, freshRollout, events, relayLogs.get(session.label) ?? [], session.label, index, fromSeq));
      } else given.push({ ...initialRules(ctl!.version, ctl!.instructions, ctl!.toolDescriptions, session.rollout), session: session.label, turn: index, fromSeq });
      const responses = relayLogs.get(session.label) ?? [];
      controllerEvent('relay-observations', { session: session.label,
        initializeResponses: responses.filter(e => e.turn === index && e.phase === 'response' && e.method === 'initialize' && e.status === 200).length,
        discoveryResponses: responses.filter(e => e.turn === index && e.phase === 'response' && e.method === 'tools/list' && e.status === 200).length }, index);
      session.record.mcpSessionIds = dedicated ? { known: false, reason: 'Dedicated connects directly; no session relay observation' }
        : { known: true, value: [...session.route!.sessionIds] };
      openDatabases(service!.pid).forEach(d => opened.add(d));
      if (cancelled()) { completeness = 'cancelled'; return; }
      if (completeness !== 'complete') return;
      if (r.timedOut) { completeness = 'timeout'; detail = `turn ${index} exceeded ${o.codex.timeoutMs} ms`; killAll(); return; }
      if (r.exitCode !== 0 || !r.turnStarted) {
        completeness = !r.turnStarted ? 'launch-failed' : looksRateLimited(r) ? 'rate-limited' : 'driver-failed';
        detail = `turn ${index}: exit ${r.exitCode ?? r.signal}; ${[...n!.errors, r.stderr.trim().split('\n').at(-1) ?? ''].join(' ')}`;
        killAll(); return;
      }
      const missed = during.filter(a => !actionRuns.has(a));
      const conflictMissing = during.some(a => a.action === 'conflicting-write') && !events.some(e => e.kind === 'tool-call'
        && e.actor === 'agent' && e.session === session.label && e.turn === index && e.result.known && classifyResult(e.result.value) === 'conflict');
      if (missed.length || conflictMissing) {
        completeness = 'precondition-not-met'; detail = `turn ${index}: ${missed.length ? 'Controller read/write trigger was not reached' : 'no native Conflict receipt observed'}`;
        killAll(); return;
      }
      for (const a of s.controller.filter(a => 'after' in a.when && a.when.after === index)) await runControllerAction(a, session, index);
    };
    await channel.observe();
    if (channel.evidence().blockedConnections) throw new IsolationError('client connection attempted before proxy activation');
    for (let index = 0; index < s.turns.length;) {
      if (cancelled()) { completeness = 'cancelled'; break; }
      const group = [index++];
      while (s.turns[index]?.concurrent) group.push(index++);
      // Gate every scripted answer before launching any member of this concurrent group.
      for (const i of group) {
        const turn = s.turns[i]!;
        if (turn.kind !== 'reply') continue;
        const last = events.findLast(e => e.kind === 'message' && e.role === 'assistant' && e.session === turn.session);
        turn.answers!.cue.lastIndex = 0;
        if (!last || last.kind !== 'message' || !turn.answers!.cue.test(last.text)) {
          completeness = 'precondition-not-met'; detail = `turn ${i}: the proposal "${turn.answers!.proposal}" did not appear`; break;
        }
      }
      if (completeness !== 'complete') break;
      for (const i of group) for (const a of s.controller.filter(a => 'before' in a.when && a.when.before === i))
        await runControllerAction(a, sessions.find(x => x.label === s.turns[i]!.session)!, i);
      const results = await Promise.allSettled(group.map(i => runOne(i).catch(error => {
        if (error instanceof IsolationError) isolationFailures.push(String(error));
        if (completeness === 'complete') { completeness = 'driver-failed'; detail = String(error); }
        killAll(); throw error;
      })));
      const failed = results.find(r => r.status === 'rejected');
      await channel.observe();
      if (channel.evidence().blockedConnections) { completeness = 'driver-failed'; detail = 'Client connection attempted while the proxy channel was inactive'; }
      if (failed?.status === 'rejected') throw failed.reason;
      if (completeness !== 'complete') break;
    }
    await clearClients();
    if (dedicated && isolationFailures.length) missing.push('raw.work');
    else { captureArtifacts(workdir, join(dir, 'raw', 'work'), secrets); rawFiles.push('work/'); }
  } catch (error) {
    if (error instanceof IsolationError) {
      if (!isolationFailures.includes(String(error))) isolationFailures.push(String(error));
      missing.push('events', 'raw.client');
    }
    if (completeness === 'complete') completeness = service ? 'driver-failed' : 'service-failed';
    detail = `${detail ?? ''} ${String(error instanceof Error ? error.message : error)}`.trim();
  }
  // A cancellation can end the native process while its relay hook is still restarting the owned service.
  // Drain those bounded operations before exporting or stopping anything, so no replacement child escapes cleanup.
  await Promise.allSettled(actionRuns.values());
  await clearClients();
  await channel.observe();
  await channel.close();
  const proxyEvidence = channel.evidence();
  writeRaw('proxy-channel.json', JSON.stringify(proxyEvidence));
  controllerEvent('proxy-channel', proxyEvidence);
  if (proxyEvidence.blockedConnections) { completeness = 'driver-failed'; detail = 'Client connection attempted while the proxy channel was inactive'; isolationFailures.push(detail); }
  if (dedicated) {
    entryContext = dedicatedContext(dedicated, sessions[0]?.rollout?.text);
    writeRaw('entry-context.json', JSON.stringify({ launcher: dedicatedLauncherSource, context: entryContext, launches }, null, 1));
    writeRaw('sandbox.sb', dedicated.controlEvidence.profile);
    writeRaw('codex-shim.py', dedicated.controlEvidence.shim);
    writeRaw('control-manifest.json', dedicated.controlEvidence.manifest);
    if (entryContext.some(c => !c.installed)) missing.push('given[0].extraContext');
    try {
      skills = dedicatedClientSkills(dedicated, sessions[0]!.codex);
      captureArtifacts(dedicated.outputs, join(dir, 'raw', 'outputs'), secrets); rawFiles.push('outputs/');
    } catch (error) {
      missing.push('raw.outputs'); completeness = 'driver-failed';
      if (error instanceof IsolationError && !isolationFailures.includes(String(error))) isolationFailures.push(String(error));
    }
  } else {
    if (entry === 'dedicated') missing.push('given[0].extraContext');
    skills = [...new Set(nativeSessions.flatMap(clientSkills))];
  }
  let maps: AttemptRecord['maps'] = [];
  try {
    if (!ctl) throw new Error('no Controller connection');
    if (dedicated && isolationFailures.length) throw new Error('Dedicated integrity failure prevents safe Map-content redaction');
    maps = (await ctl.exportCatalog()).map(m => ({ mapId: m.mapId,
      // No agent turn starts until all seeding succeeds. This also recovers a committed write whose reply AND immediate reread were lost.
      seedHeadRevision: seedingComplete ? seedHeads[m.mapId] ?? null : m.history.at(-1)?.revision ?? null, history: m.history }));
  } catch (error) {
    missing.push('maps');
    if (entry === 'dedicated' && completeness === 'complete') completeness = 'driver-failed';
    detail = `${detail ?? ''} catalog export failed: ${String(error instanceof Error ? error.message : error)}`.trim(); }
  for (const session of sessions) await session.route?.close().catch(() => undefined);
  for (const [label, log] of relayLogs) writeRaw(`relay-${label}.jsonl`, log.map(e => JSON.stringify(e)).join('\n'));
  await ctl?.close().catch(() => undefined);
  const stopped = await service?.stop();
  if (service) { writeRaw('protocol.jsonl', existsSync(service.protocolReport) ? readFileSync(service.protocolReport, 'utf8') : ''); writeRaw('service.log', service.logs()); }
  // Raw SQLite can retain credentials in Map text, history, free pages and journals. Keep only
  // the redacted structured export; never patch database bytes or retain it after export failure.
  if (entry === 'dedicated') missing.push('raw.database');
  const databaseCleanup = cleanupServiceDirectory(serviceDir, true);
  rmSync(scratch, { recursive: true, force: true });
  rmSync(controlDir, { recursive: true, force: true });
  const consensus = (key: 'visibleModel' | 'effort' | 'cliVersion'): Field<string> => {
    const values = exposures.map(r => r?.[key]);
    return values.length && values.every(v => !!v && v === values[0]) ? { known: true, value: values[0]! }
      : { known: false, reason: `${key} missing or inconsistent across native sessions` };
  };
  const visibleModel = consensus('visibleModel');
  const effort = consensus('effort');
  const clientVersion = consensus('cliVersion');
  given.sort((a, b) => a.fromSeq - b.fromSeq);
  if (!given.length) given.push(initialRules(ctl?.version ?? 'unknown', ctl?.instructions ?? '', ctl?.toolDescriptions ?? {}, null));
  if (entry === 'dedicated') for (const rules of given)
    rules.extraContext = entryContext.map(c => `${c.source}: installed=${c.installed}; shownToModel=${c.shownToModel ?? 'unknown'}; raw/entry-context.json`);
  if (detail) {
    try {
      const safe = tilde(redact(detail, secrets));
      if (leaks(safe, secrets).length) throw new Error('unsafe detail');
      detail = safe.slice(0, 300); // Truncate only after scrubbing, so a partial credential cannot escape detection.
    } catch { completeness = 'driver-failed'; detail = 'Error detail withheld after privacy validation'; }
  }
  const record: AttemptRecord = {
    schema: attemptSchema, attemptId: `${o.batchId}/${p.attemptId}`, batchId: o.batchId, subject: { kind: upgradeMode ? 'upgrade-check' : 'scenario', id: s.id, version: s.version },
    entry, combination: { harness: 'codex', requestedModel: o.codex.model, visibleModel, effort },
    client: { version: clientVersion, surface: { known: true, value: entry === 'dedicated' ? 'wayfinder --harness codex --method mcp -- exec' : 'codex exec' } },
    service: { commit: serviceCommit(), series: 'release', version: upgrade?.contracts.before.version ?? ctl?.version ?? 'unknown' },
    ...(upgrade ? { upgrade } : {}),
    given,
    run: { startedAt, endedAt: new Date().toISOString(), completeness, ...(detail ? { detail } : {}) },
    controller: { clientId: controller.clientId }, baitClientIds: bait ? [bait.clientId] : [],
    sessions: sessions.map(x => x.record), events, maps, receipts: correlateReceipts(events, maps, sessions.map(s => s.record), controller.clientId),
    usage: usage.inputTokens || usage.outputTokens ? { known: true, value: usage } : { known: false, reason: 'no usage reported' },
    raw: { path: join(o.batchId, p.attemptId, 'raw'), files: rawFiles },
    missing: [],
  };
  // Every field recorded as unknown is also listed, so a gap is visible without walking the record.
  const unknownFields: [string, Field<unknown>][] = [['combination.visibleModel', visibleModel], ['combination.effort', effort], ['client.version', clientVersion],
    ...given.flatMap((g, i): [string, Field<unknown>][] => [[`given[${i}].instructions`, g.instructions], [`given[${i}].toolDescriptions`, g.toolDescriptions],
      ...(g.toolDefinitions ? [[`given[${i}].toolDefinitions`, g.toolDefinitions] as [string, Field<unknown>]] : []),
      ...(g.resourceText ? [[`given[${i}].resourceText`, g.resourceText] as [string, Field<unknown>]] : [])]), ['usage', record.usage],
    ...record.sessions.flatMap((x, i): [string, Field<unknown>][] => [[`sessions[${i}].nativeId`, x.nativeId], [`sessions[${i}].mcpSessionIds`, x.mcpSessionIds],
      ...x.turns.map((t, k): [string, Field<unknown>] => [`sessions[${i}].turns[${k}].nativeId`, t.nativeId!])])];
  record.missing = [...new Set([...missing, ...record.receipts.flatMap((r, i) => r.outcome.kind === 'unknown' ? [`receipts[${i}].outcome`] : []), ...unknownFields.filter(([, f]) => !f.known).map(([path]) => path)])];
  const isolation: AttemptIsolation = { ...(entry === 'dedicated' ? { dedicatedServiceRemoved: !existsSync(serviceDir), launcherInvocations: launches.length } : {}), sandbox: o.codex.sandbox, serviceStopped: stopped ?? null, servedOwnDatabase: service ? opened.has(service.databasePath) : false,
    touchedEverydayDatabase: touchedEverydayDatabase([...opened]), scratchRemoved: !existsSync(scratch), controlDirectoryRemoved: !existsSync(controlDir), databaseDirectoryRemoved: databaseCleanup.removed, retainedDatabase: databaseCleanup.retained, failures: isolationFailures, clientSkills: skills, attribution: attribution(record) };
  let text: string; let safeDetail: string | undefined;
  try {
    text = tilde(redact(JSON.stringify({ ...record, isolation }, null, 1), secrets));
    const saved = JSON.parse(text) as AttemptRecord;
    const missingField = requiredFields.some(path => path.split('.').reduce<unknown>((value, key) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, saved) === undefined);
    if (missingField || saved.schema !== attemptSchema || saved.run.completeness !== completeness || leaks(text, secrets).length)
      throw new Error('invalid scrubbed evidence');
    safeDetail = saved.run.detail;
  } catch { return { attemptId: p.attemptId, scenario: s.id, completeness: 'driver-failed', detail: 'redaction could not preserve safe evidence; record withheld' }; }
  writeFileSync(join(dir, 'attempt.json'), text, { mode: 0o600 });
  return { attemptId: p.attemptId, scenario: s.id, completeness, ...(safeDetail ? { detail: safeDetail } : {}), record: join(p.attemptId, 'attempt.json') };
}

export const personalConfigNamesRun = (text: string) => /wf-behave-|behaviour-runs|wayfinder-behaviour-tests|Behaviour[.-]/.test(text);

export async function runBatch(o: BatchOptions): Promise<{ outcomes: AttemptOutcome[]; refusals: string[] }> {
  const { plan, refusals } = preflight(o);
  if (o.entry === 'dedicated' && !o.codex.sandbox) refusals.push('Dedicated Entry requires the allowlist sandbox');
  if (refusals.length) return { outcomes: [], refusals };
  if (o.upgradeChecks?.length && !o.codex.sandbox) return { outcomes: [], refusals: ['upgrade checks require the shared sandbox'] };
  try { proxyRouting(o.proxyEnv ?? {}); } catch (error) { return { outcomes: [], refusals: [(error as Error).message] }; }
  const outputError = outputRefusal(o.out);
  if (outputError) return { outcomes: [], refusals: [outputError] };
  if (existsSync(o.out)) return { outcomes: [], refusals: [`${tilde(o.out)} already exists; a Batch never reuses an output directory`] };
  if (o.scratchRoot.startsWith(homedir())) return { outcomes: [], refusals: ['scratch must live outside the home directory, which the sandbox hides'] };
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const before = isolationSnapshot(o.personalConfigRoot);
  let cancel = false;
  let kill: (() => void) | undefined;
  const onSignal = () => { cancel = true; kill?.(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGHUP', onSignal);
  const outcomes: AttemptOutcome[] = [];
  try {
    for (const [i, p] of plan.entries()) {
      let outcome: AttemptOutcome;
      if (i >= o.ceiling) outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'not-run', detail: `ceiling ${o.ceiling} reached` };
      else if (cancel) outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'cancelled', detail: 'cancelled before start' };
      else {
        try { outcome = await runAttempt(o, p, () => cancel, k => { kill = k; }); }
        catch { outcome = { attemptId: p.attemptId, scenario: p.scenario.id, completeness: 'driver-failed', detail: 'Attempt failed before safe evidence could be retained' }; }
      }
      outcomes.push(outcome);
      console.log(`${p.attemptId}: ${outcome.completeness}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGHUP', onSignal); }
  const after = isolationSnapshot(o.personalConfigRoot);
  // Other clients may edit personal configuration during a Batch; what matters is that none of it names this run.
  const mentionsRun = Object.keys(after.files).filter(f => { const path = f.replace(/^~/, homedir());
    return existsSync(path) && personalConfigNamesRun(readFileSync(path, 'utf8')); });
  writeFileSync(join(o.out, 'batch.json'), JSON.stringify({ batchId: o.batchId, combination: `codex:${o.codex.model}:${o.codex.effort}`, entry: o.entry ?? 'mcp-only',
    sandbox: o.codex.sandbox, proxy: proxySummary(o.proxyEnv ?? {}), plan: plan.map(p => p.attemptId), ceiling: o.ceiling, outcomes,
    ...(o.upgradeChecks?.length ? { kind: 'upgrade-checks', checks: o.upgradeChecks, count: o.count, plannedAttempts: plan.length,
      quota: { attemptCeiling: o.ceiling, nativeTurnCeiling: plan.slice(0, o.ceiling).reduce((n, p) => n + p.scenario.turns.length, 0), timeoutMsPerTurn: o.codex.timeoutMs, automaticRetries: 0, modelReviews: 0 } } : {}),
    isolation: { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after), personalConfigNamingThisRun: mentionsRun } }, null, 1), { mode: 0o600 });
  return { outcomes, refusals: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { batch: { type: 'string' }, scenarios: { type: 'string' }, 'upgrade-checks': { type: 'string' }, count: { type: 'string', default: '1' },
    entry: { type: 'string', default: 'mcp-only' }, ceiling: { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' }, effort: { type: 'string', default: 'xhigh' },
    out: { type: 'string' }, codex: { type: 'string', default: 'codex' }, 'timeout-min': { type: 'string', default: '30' }, 'no-sandbox': { type: 'boolean', default: false } } });
  if (!values.batch || (!values.scenarios && !values['upgrade-checks']) || !values.ceiling) {
    console.error('usage: run.ts --batch <id> (--scenarios S0b,F11 | --upgrade-checks U-codex-process,U-codex-resume) --count 2 --ceiling 4 [--entry mcp-only|dedicated] [--model gpt-6-astra] [--effort xhigh]');
    process.exit(2);
  }
  let proxyEnv: Record<string, string>;
  try {
    proxyEnv = proxyEnvironment(null, process.env);
    proxyRouting(proxyEnv); // Refuse invalid routing before opening subscription state.
  } catch (error) {
    if (!(error instanceof ProxyError)) throw error;
    console.error(`refused: ${error.message}`); process.exit(1);
  }
  if (values.entry !== 'mcp-only' && values.entry !== 'dedicated') throw new Error('entry must be mcp-only or dedicated');
  const entry: BatchOptions['entry'] = values.entry;
  const selection = { entry, batchId: values.batch, scenarios: values.scenarios?.split(',') ?? [], upgradeChecks: values['upgrade-checks']?.split(',') ?? [], count: Number(values.count), ceiling: Number(values.ceiling) };
  const early = preflight(selection);
  if (early.refusals.length || (selection.upgradeChecks.length && values['no-sandbox'])) {
    console.error(early.refusals.map(r => `refused: ${r}`).join('\n') || 'refused: upgrade checks require the shared sandbox'); process.exit(1);
  }
  const result = await runBatch({ ...selection,
    out: values.out ?? join(homedir(), 'Library/Application Support/Wayfinder/behaviour-runs', values.batch), scratchRoot: '/private/tmp',
    loginSource: { contents: readFileSync(join(homedir(), '.codex/auth.json'), 'utf8') }, personalConfigRoot: homedir(), proxyEnv,
    codex: { model: values.model, effort: values.effort, bin: values.codex, sandbox: !values['no-sandbox'], timeoutMs: Number(values['timeout-min']) * 60_000 } });
  for (const r of result.refusals) console.error(`refused: ${r}`);
  if (result.refusals.length) process.exit(1);
}
