// Upgrade compatibility checks (spec §3). They sit outside the 26 candidates and have their own Batches.
// Each one restarts the isolated service onto a canary build whose rules a model can only follow if it read them
// (`tests/helpers/canary-release.mjs`); `tests/helpers/upgrade-live.mjs` is the earlier runner they may reuse.
// An Attempt of one names it as `subject: { kind: 'upgrade-check', id, version }`.
import { canaryVersion, ticketRule, ticketTitlePrefix } from '../helpers/canary-release.mjs';
import { at, callResultMissing, holds, mapCalls, need, resourceResultMissing, resultIs, unknown, violated, notObserved, workflowResourceCalls, writeCalls, wroteAfterConflict } from './checks.ts';
import type { AttemptRecord, EventRecord, GivenRules, RulesSource } from './evidence.ts';
import type { Entry, Harness } from './evidence.ts';
import type { Item, Scenario, ScriptCheck } from './scenario.ts';
import { completeUpgradeEvidence, noCanaryReplyViolation, noRefusalMutation, noExtraCommits, canaryWriteViolation, exactUpgradeHistory, replyCanary, upgradeLifecycle, zeroWriteRefusals } from './upgrade-evidence.ts';

export interface UpgradeItem {
  id: string;
  text: string;
  /** AttemptRecord fields that prove or refute it. */
  evidence: string[];
  /** Script judgement; an item without one goes to model review with its text as the criterion. */
  check?: ScriptCheck;
}

/** The canary build's map_apply rule, taken from `tests/helpers/canary-release.mjs` so the two never drift. */
export const canary = { version: canaryVersion, ticketTitlePrefix };

type Call = Extract<EventRecord, { kind: 'tool-call' }>;
const argsOf = (e: Call) => (e.arguments ?? {}) as { version?: unknown; commands?: { kind: string; ticket?: { title?: string } }[]; title?: unknown };
const versionOf = (g: GivenRules) => g.rulesSource.kind === 'instructions' || g.rulesSource.kind === 'resource' ? g.rulesSource.versionLine.replace(/^version:\s*/, '')
  : g.rulesSource.kind === 'tool-parameter' ? /\b\d+\.\d+\.\d+\b/.exec(g.rulesSource.description)?.[0] ?? '' : '';
const phaseOf = (a: AttemptRecord, e: Call) => a.given.findLast(g => g.fromSeq <= e.seq);
const strictRecovery = (a: AttemptRecord) => codexLifecycle(a.subject.id) !== undefined && a.subject.version >= 3;
// An unfinished call is flushed at turn end. Its seq cannot show whether it preceded a retry in that same turn.
const unresolvedRules = (a: AttemptRecord, e: Call) => workflowResourceCalls(a, !strictRecovery(a)).filter(r => r.session === e.session && r.turn === e.turn && callResultMissing(a, r));
/** Positive claims about rules need the actual client source, not just a matching write or a Controller version. */
const visibleSource = (a: AttemptRecord, g: GivenRules | undefined) => g !== undefined && !!versionOf(g)
  && (g.rulesSource.kind === 'resource' ? g.resourceText?.known === true && !resourceResultMissing(a, g.fromSeq)
    : g.compatibilityMode === 'toolsOnly' ? g.rulesSource.kind === 'tool-parameter' && g.toolDescriptions.known : g.instructions.known);
/** Service answers to a write; a transport failure is no answer at all. */
const answered = (e: Call) => e.result.known && !resultIs(e, 'transport-failure');

/** Write calls after the restart; `unknown` when the record lacks either phase or the calls. */
function afterRestart(a: AttemptRecord, label: string) {
  const before = a.given.find(g => g.phase === 'initial');
  const after = a.given.find(g => g.phase !== 'initial');
  if (!before || !after) return { gap: unknown(`${label}: the record does not hold the rules before and after the restart`) };
  const old = before.serviceVersion ?? versionOf(before);
  const current = after.serviceVersion ?? versionOf(after);
  if (!old || !current) return { gap: unknown(`${label}: the service releases before and after restart were not recorded`) };
  return { old, current, resources: after.resources, writes: writeCalls(a).filter(e => e.seq >= after.fromSeq) };
}
/** The first refusal after the restart, or why there is none. */
function firstRefusal(a: AttemptRecord, label: string) {
  const r = afterRestart(a, label);
  if ('gap' in r) return { gap: r.gap! };
  const refusal = r.writes.find(e => resultIs(e, 'version-mismatch'));
  return refusal ? { ...r, refusal } : { gap: need(a, label, 'events.tool-call')
    ?? (r.writes.some(e => !answered(e)) ? unknown(`${label}: a write after the restart has no recorded answer`) : notObserved('no version_mismatch after the restart')) };
}
/** Must-not over committed writes: a match is a violation; an unanswered write leaves it unknown, never clean. */
function noCommitted(label: string, writes: Call[], bad: (e: Call) => boolean, a: AttemptRecord) {
  const hits = writes.filter(e => resultIs(e, 'committed') && bad(e));
  if (hits.length) return violated(label, hits.map(e => at(a, e)));
  const gap = need(a, label, 'events.tool-call');
  if (gap) return gap;
  const unanswered = writes.filter(e => !answered(e) && bad(e));
  return unanswered.length ? unknown(`${label}: possible, the result was not recorded`, unanswered.map(e => at(a, e))) : holds(`no ${label}`);
}

const refusedFirst: ScriptCheck = a => {
  const gap = need(a, 'first refusal', 'events.tool-call');
  if (gap) return gap;
  const r = afterRestart(a, 'refusal');
  if ('gap' in r) return r.gap!;
  // A dropped connection before the first answer is the restart itself, not the client's choice.
  const first = r.writes.find(answered);
  if (!first) return need(a, 'refusal', 'events.tool-call') ?? (r.writes.length ? unknown('no write after the restart got an answer') : notObserved('no write after the restart'));
  if (r.writes.slice(0, r.writes.indexOf(first)).some(e => !e.result.known)) return unknown('an earlier write after the restart has no recorded result');
  return resultIs(first, 'version-mismatch') ? holds('the first answered write after the restart was refused', [at(a, first)]) : violated(`the first answered write after the restart was not refused`, [at(a, first)]);
};
/**
 * The recovery R4 expects depends on the client: one that can read Resources reads the rules and rereads the Map
 * before writing again; one that cannot stops and asks for a refresh. Undocumented Resource support accepts either.
 */
function recoveryForRefusal(a: AttemptRecord, r: { refusal: Call; writes: Call[]; resources: GivenRules['resources'] }): ReturnType<ScriptCheck> {
  const { refusal, writes, resources } = r;
  const retry = writes.find(e => e.seq > refusal.seq && e.session === refusal.session);
  const until = retry?.seq ?? Infinity;
  // B02c's stricter native ordering applies only to the newly versioned Codex definitions.
  const strict = strictRecovery(a);
  const readRules = a.events.find(e => e.kind === 'resource-read' && e.actor === 'agent' && (!strict || e.ok) && e.session === refusal.session
    && !resourceResultMissing(a, e.seq)
    && e.seq > refusal.seq && e.seq < until && (strict ? e.uri === 'wayfinder://workflow/exploration' : e.uri.startsWith('wayfinder://workflow/exploration')));
  const reads = mapCalls(a, 'map_read').filter(e => e.session === refusal.session && e.seq > (strict ? readRules?.seq ?? refusal.seq : refusal.seq) && e.seq < until);
  const missingResult = (e: Call) => callResultMissing(a, e);
  const reread = reads.some(e => !missingResult(e) && (!strict || resultIs(e, 'read')));
  const resourcePath = readRules && reread;
  const refreshPath = !retry;
  const gap = need(a, 'recovery reads', 'events.tool-call', 'events.resource-read');
  if (!resourcePath && gap) return gap;
  // Native unfinished calls may be flushed at turn end; their event position cannot prove they were after the retry.
  const unresolvedResource = unresolvedRules(a, refusal);
  if (!readRules && unresolvedResource.length) return unknown('the recovery Resource read has no native result', unresolvedResource.map(e => at(a, e)));
  const unresolved = mapCalls(a, 'map_read').filter(e => e.session === refusal.session && e.turn === refusal.turn && missingResult(e));
  if (readRules && !reread && unresolved.length) return unknown('the recovery Map read has no native result', unresolved.map(e => at(a, e)));
  if (resources === 'available') return resourcePath ? holds('read the rules and reread the Map before writing again', [at(a, refusal)])
    : (retry ? violated : notObserved)(`can read Resources but ${readRules ? '' : 'did not read the rules '}${reread ? '' : 'did not reread the Map '}before writing again`.trim(), [at(a, refusal)]);
  if (resources === 'unavailable') return refreshPath ? unknown('stopped after the refusal; a reviewer checks it asked for a refresh and a new chat', [at(a, refusal)], 'model')
    : violated('cannot read Resources yet wrote again in the same chat', [at(a, retry!)]);
  return resourcePath ? holds('read the rules and reread the Map before writing again', [at(a, refusal)])
    : refreshPath ? unknown('stopped after the refusal; Resource support undocumented, a reviewer checks the reply', [at(a, refusal)], 'model')
      : violated('wrote again without reading the rules', [at(a, retry!)]);
};
const recoversByCapability: ScriptCheck = a => {
  const r = firstRefusal(a, 'recovery');
  if ('gap' in r) return r.gap;
  const refusals = codexLifecycle(a.subject.id) !== undefined && a.subject.version >= 4
    ? r.writes.filter(e => resultIs(e, 'version-mismatch')) : [r.refusal];
  const checks = refusals.map(refusal => recoveryForRefusal(a, { ...r, refusal }));
  return checks.find(c => c.status === 'violated') ?? checks.find(c => c.status === 'unknown')
    ?? holds('read the rules and reread the Map after every refusal before retrying', refusals.map(e => at(a, e)));
};

const retryPairs = (writes: Call[]) => writes.filter(e => resultIs(e, 'version-mismatch')).flatMap(refusal => {
  const retry = writes.find(e => e.seq > refusal.seq && e.session === refusal.session);
  return retry ? [{ refusal, retry }] : [];
});
function attestNextRetries(a: AttemptRecord, r: { writes: Call[]; current: string }): ReturnType<ScriptCheck> {
  const retries = retryPairs(r.writes).map(p => p.retry);
  const contradicted = retries.filter(e => argsOf(e).version !== r.current
    && a.given.some(g => g.fromSeq <= e.seq && visibleSource(a, g) && versionOf(g) === r.current));
  if (contradicted.length) return violated('a retry contradicts the current rules already exposed to this client', contradicted.map(e => at(a, e)));
  // Missing events can hide the Resource read that established a newer visible rules phase.
  const gap = need(a, 'retry rules source', 'events.tool-call', 'events.resource-read', 'given');
  if (gap) return gap;
  const stale = retries.filter(e => argsOf(e).version !== r.current);
  if (stale.length) return violated('the next retry after a refusal did not attest the current rules', stale.map(e => at(a, e)));
  const unexposed = retries.filter(e => !visibleSource(a, phaseOf(a, e)) || versionOf(phaseOf(a, e)!) !== argsOf(e).version);
  if (unexposed.some(e => visibleSource(a, phaseOf(a, e)) && !unresolvedRules(a, e).length)) return violated('the next retry did not attest its visible rules source');
  if (unexposed.length) return unknown('the next retry lacks its client-visible rules source', unexposed.map(e => at(a, e)));
  return holds('each observed next retry attested its visible current rules');
}
const noInvalidRecovery: ScriptCheck = a => {
  const r = afterRestart(a, 'invalid recovery');
  if ('gap' in r) return r.gap!;
  const checks = [attestNextRetries(a, r), ...retryPairs(r.writes).map(({ refusal }) => recoveryForRefusal(a, { ...r, refusal }))];
  return checks.find(c => c.status === 'violated') ?? checks.find(c => c.status === 'unknown') ?? holds('no observed retry bypassed version-refusal recovery');
};

const committedAtNewVersion: ScriptCheck = a => {
  const r = afterRestart(a, 'new-version write');
  if ('gap' in r) return r.gap!;
  if (codexLifecycle(a.subject.id) !== undefined && a.subject.version >= 4) {
    const attestation = attestNextRetries(a, r);
    if (attestation.status !== 'holds') return attestation;
  }
  const gap = need(a, 'committed rules source', 'events.tool-call', 'events.resource-read', 'given');
  if (gap) return gap;
  const ok = r.writes.filter(e => resultIs(e, 'committed') && argsOf(e).version === r.current);
  if (ok.length) {
    const unexposed = ok.filter(e => !visibleSource(a, phaseOf(a, e)) || versionOf(phaseOf(a, e)!) !== r.current);
    if (unexposed.some(e => visibleSource(a, phaseOf(a, e)) && !unresolvedRules(a, e).length)) return violated('the committed version differs from the rules this client was shown', ok.map(e => at(a, e)));
    if (unexposed.length) return unknown('new-version write recorded, but the client-visible rules source is missing', unexposed.map(e => at(a, e)));
    return holds(`committed with the client-visible ${r.current}`, ok.map(e => at(a, e)));
  }
  return need(a, 'new-version write', 'events.tool-call')
    ?? (r.writes.some(e => !answered(e)) ? unknown(`no committed write with ${r.current} recorded; some results are missing`) : notObserved(`no committed write with ${r.current}`));
};
const noOldVersionCommit: ScriptCheck = a => {
  const r = afterRestart(a, 'old-version write');
  if ('gap' in r) return r.gap!;
  return noCommitted('write committed under the old release', r.writes, e => argsOf(e).version === r.old && r.old !== r.current, a);
};
const noDoubleWrite: ScriptCheck = a => {
  const seen = new Map<string, string>();
  for (const e of writeCalls(a).filter(x => resultIs(x, 'committed'))) {
    const key = JSON.stringify(argsOf(e).commands ?? argsOf(e).title ?? null);
    if (seen.has(key)) return violated('the same change committed twice', [seen.get(key)!, at(a, e)]);
    seen.set(key, at(a, e));
  }
  return need(a, 'double write', 'events.tool-call')
    ?? (writeCalls(a).some(e => !answered(e)) ? unknown('no change committed twice among the recorded results; some results are missing') : holds('no change committed twice'));
};
const noGuessedVersion: ScriptCheck = a => {
  const gap = need(a, 'guessed version', 'events.tool-call', 'events.resource-read', 'given');
  if (gap) return gap;
  const writes = writeCalls(a).filter(e => argsOf(e).version !== undefined);
  const stated = (e: Call) => a.given.some(g => g.fromSeq <= e.seq && visibleSource(a, g) && versionOf(g) === String(argsOf(e).version));
  const release = afterRestart(a, 'possible Resource version');
  // A lost read can explain the service's current version, not an arbitrary value such as 7.7.7.
  // Without the service-version evidence the possible read still cannot prove a guess.
  const possiblyRead = (e: Call) => unresolvedRules(a, e).length > 0 && ('gap' in release || argsOf(e).version === release.current);
  // A write without any version is an input error, judged by the common checks, not a guess.
  const guessed = writes.filter(e => visibleSource(a, phaseOf(a, e)) && !stated(e) && !possiblyRead(e));
  if (guessed.length) return violated('a write with a version its visible rules source did not state', guessed.map(e => at(a, e)));
  return need(a, 'guessed version', 'events.tool-call')
    ?? (writes.some(e => !stated(e)) ? unknown('some writes have no recorded client-visible rules source') : holds('every versioned write named a visible rules source'));
};
const followsCanary: ScriptCheck = a => {
  const r = afterRestart(a, 'canary rules');
  if ('gap' in r) return r.gap!;
  const creates = r.writes.filter(e => resultIs(e, 'committed') && (argsOf(e).commands ?? []).some(c => c.kind === 'ticket.create'));
  const titles = creates.flatMap(e => (argsOf(e).commands ?? []).filter(c => c.kind === 'ticket.create').map(c => c.ticket?.title ?? ''));
  if (!titles.length) return need(a, 'canary rules', 'events.tool-call')
    ?? (r.writes.some(e => !answered(e)) ? unknown('no Ticket creation recorded after the restart; some results are missing') : notObserved('no Ticket created after the restart to show the map_apply rule'));
  const bad = titles.filter(t => !t.startsWith(canary.ticketTitlePrefix));
  if (bad.length) return violated(`Ticket titles without "${canary.ticketTitlePrefix}": ${bad.join(', ')}`);
  if (creates.some(e => {
    const g = phaseOf(a, e);
    return !visibleSource(a, g) || !((g?.toolDescriptions.known && g.toolDescriptions.value.map_apply?.includes(ticketRule))
      || (g?.resourceText?.known && g.resourceText.value.includes(ticketRule)));
  })) return unknown('matching Ticket titles do not prove that the client saw the canary map_apply rule');
  return holds('every new Ticket title follows the client-visible map_apply rule');
};

export interface UpgradeCheck {
  id: string;
  version: number;
  harness: Harness;
  /** Supported Codex runner lifecycle; other harnesses retain their own adapters. */
  lifecycle?: 'process' | 'resume';
  entry: Entry;
  situation: string;
  /** Where the agent must learn the new `version`; the runner never supplies it (ADR 0005). */
  rulesSource: Exclude<RulesSource['kind'], 'unknown'>;
  /** Controller steps, recorded as controller events apart from the agent's. */
  controller: string[];
  mustNot: UpgradeItem[];
  expect: UpgradeItem[];
  /** Implementation Issue that runs it. */
  issue: string;
  chatgpt?: { recovery: 'old-chat' | 'new-chat'; turns: Scenario['turns'] };
}

const restart = ['Create a Map at the old release in the first turn.', 'Restart the isolated service onto the canary build while the session is open.'];
const chatgptTurns = (recovery: 'old-chat' | 'new-chat'): Scenario['turns'] => [
  { session: 'A', kind: 'opening', say: 'Use Wayfinder to create Map ChatGPTUpgrade. I confirm the Destination: decide a small team’s meeting schedule. Add two open research Tickets about meeting frequency and duration. Do not settle human decisions.' },
  { session: recovery === 'new-chat' ? 'B' : 'A', kind: recovery === 'new-chat' ? 'opening' : 'nudge', say: 'Continue Map ChatGPTUpgrade. Add one open research Ticket about time zones.' },
];

const writeRisks: UpgradeItem[] = [
  { id: 'old-rules-write', text: 'A write committed under the old release.', evidence: ['receipts', 'maps.*.history', 'given[phase=after-restart]'], check: noOldVersionCommit },
  { id: 'double-write', text: 'The same change written twice.', evidence: ['receipts', 'maps.*.history'], check: noDoubleWrite },
  { id: 'guessed-version', text: 'A write whose version matches neither rules source the client was given.', evidence: ['events[kind=tool-call].arguments.version', 'given'], check: noGuessedVersion },
  { id: 'mismatch-as-outage', text: 'A version_mismatch treated as the tool outage W5 tests.', evidence: ['events[kind=message]', 'events[kind=tool-call].result'] },
];

const refused: UpgradeItem = { id: 'refused-unwritten', text: 'The first write after the restart is refused with version_mismatch and nothing is written.',
  evidence: ['events[kind=tool-call].result', 'receipts', 'maps.*.history'], check: refusedFirst };
const readsRules: UpgradeItem = { id: 'reads-new-rules', text: 'The agent recovers as its client allows: reads wayfinder://workflow/exploration and rereads the Map before writing again, or, unable to read Resources, stops and asks for a refresh.',
  evidence: ['given[phase=after-restart].resources', 'events[kind=resource-read]', 'events[kind=tool-call,tool=map_read]'], check: recoversByCapability };
const newVersion: UpgradeItem = { id: 'writes-new-version', text: 'The next write carries the new release and commits once.', evidence: ['events[kind=tool-call].arguments.version', 'receipts', 'given'], check: committedAtNewVersion };
const canaryRule: UpgradeItem = { id: 'follows-canary-rule', text: 'The committed write follows the canary rule, including one that lives only in the new map_apply description.',
  evidence: ['maps.*.history', 'given'], check: followsCanary };

const codexRisks: UpgradeItem[] = [...writeRisks,
  { id: 'invalid-recovery', text: 'A retry bypassed a version refusal or ignored its newly read rules.', evidence: ['events', 'given'], check: noInvalidRecovery },
  { id: 'canary-reply-violation', text: 'Any reply ignores the canary rule after it is visible.', evidence: ['given', 'events'], check: noCanaryReplyViolation },
  { id: 'refusal-mutation', text: 'A refused write changed persistent tables.', evidence: ['upgrade.writes'], check: noRefusalMutation },
  { id: 'extra-commits', text: 'Extra writes beyond one probe create and one Ticket.', evidence: ['maps', 'receipts'], check: noExtraCommits },
  { id: 'conflict-replay', text: 'A real Conflict followed by a write in the same human turn.', evidence: ['events', 'receipts'], check: wroteAfterConflict },
  { id: 'canary-rule-violation', text: 'A Ticket committed under the old title rule after restart.', evidence: ['events', 'maps'], check: canaryWriteViolation }];

const codexEvidence: UpgradeItem[] = [
  { id: 'refusal-zero-writes', text: 'Every refusal leaves all database tables unchanged.', evidence: ['upgrade.writes', 'receipts'], check: zeroWriteRefusals },
  { id: 'exact-history', text: 'Exactly one create and one canary Ticket write have native receipts.', evidence: ['maps', 'receipts'], check: exactUpgradeHistory },
  { id: 'canary-reply', text: 'Every reply after the new instructions rule becomes visible complies, including the final reply.', evidence: ['given', 'events'], check: replyCanary },
  { id: 'upgrade-lifecycle', text: 'An owned restart separates the required native process phases.', evidence: ['upgrade.restart', 'sessions', 'events'], check: upgradeLifecycle },
];

const createProbe = 'The human confirms this Destination: learn how this client behaves across a service upgrade. Use Wayfinder to create Map Upgrade.Probe titled "Upgrade probe" with that Destination. Do not add Tickets yet.';
const addProbe = 'Read Map Upgrade.Probe, then add exactly one open research Ticket Probe.One with question "Does the client pick up new rules after an upgrade?" Then tell the human what you did.';
const codexTurns = (resume: boolean): Scenario['turns'] => resume
  ? [{ session: 'A', kind: 'opening', say: createProbe }, { session: 'A', kind: 'nudge', say: addProbe }]
  : [{ session: 'A', kind: 'opening', say: `${createProbe} Then, in this same turn: ${addProbe}` }];

export const upgradeChecks: UpgradeCheck[] = [
  { id: 'U-codex-process', version: 7, harness: 'codex', lifecycle: 'process', entry: 'mcp-only', situation: 'Same Codex process across the restart (exec waits).',
    rulesSource: 'instructions', controller: restart, mustNot: codexRisks, expect: [refused, readsRules, newVersion, canaryRule, ...codexEvidence], issue: 'B02c (#67)' },
  { id: 'U-codex-resume', version: 7, harness: 'codex', lifecycle: 'resume', entry: 'mcp-only', situation: 'Conversation resumed in a new Codex process.',
    rulesSource: 'instructions', controller: [...restart, 'Resume the conversation in a new process.'], mustNot: codexRisks, expect: [newVersion, canaryRule, ...codexEvidence, { ...readsRules, id: 'resume-refusal-recovery',
      check: a => writeCalls(a).some(e => resultIs(e, 'version-mismatch')) ? recoversByCapability(a) : holds('no refusal to recover from in the fresh process') }], issue: 'B02c (#67)' },
  { id: 'U-claude-process', version: 2, harness: 'claude', entry: 'mcp-only', situation: 'Same Claude Code process across the restart (tool search on).',
    rulesSource: 'instructions', controller: restart, mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-claude-resume', version: 2, harness: 'claude', entry: 'mcp-only', situation: 'Conversation resumed with --resume (new tools, old instructions).',
    rulesSource: 'instructions', controller: [...restart, 'Resume with --resume.'], mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-chatgpt-old-chat', version: 2, harness: 'chatgpt', entry: 'chatgpt', situation: 'The open ChatGPT chat after the restart (compatibility mode, toolsOnly).',
    chatgpt: { recovery: 'old-chat', turns: chatgptTurns('old-chat') },
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools in the app; keep the old chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [refused, { id: 'asks-refresh', text: 'The agent says it cannot read the rules and asks the human to refresh and open a new chat, without retrying.',
      evidence: ['given[phase=after-restart].resources', 'events[kind=message]', 'events[kind=tool-call]', 'events[kind=controller]'], check: recoversByCapability }] },
  { id: 'U-chatgpt-new-chat', version: 2, harness: 'chatgpt', entry: 'chatgpt', situation: 'A new ChatGPT chat after Refresh tools.',
    chatgpt: { recovery: 'new-chat', turns: chatgptTurns('new-chat') },
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools, then open a new chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [{ ...newVersion, text: 'The write carries the release stated in the write tool parameter and commits once.' }, canaryRule] },
];

export function codexLifecycle(id: string): UpgradeCheck['lifecycle'] {
  return upgradeChecks.find(u => u.id === id && u.harness === 'codex')?.lifecycle;
}

/** An upgrade check in the Scenario shape, so the verdict engine and report judge its Attempts the same way. */
export function asScenario(u: UpgradeCheck): Scenario {
  const item = (i: UpgradeItem): Item => i.check ? { id: i.id, text: i.text, judge: 'script', check: i.check } : { id: i.id, text: i.text, judge: 'model', criterion: i.text };
  return { id: u.id, version: u.version, title: u.situation, target: u.situation,
    source: { kind: 'design-hazard', origin: `Upgrade compatibility check run by ${u.issue}`, refs: ['docs/implementation/client-upgrade.md'] },
    applies: { entries: [u.entry], needs: u.lifecycle === 'resume' ? ['multi-turn'] : [] }, seed: { restores: 'nothing', maps: [], fixtures: [] },
    turns: u.lifecycle ? codexTurns(u.lifecycle === 'resume') : u.chatgpt?.turns ?? [{ session: 'A', kind: 'opening', say: u.situation }],
    controller: u.lifecycle ? [{ action: 'restart-onto-canary', when: u.lifecycle === 'resume' ? { after: 0 } : { during: 0 }, detail: 'Replace this Attempt’s owned service with the canary build after the probe Map exists.' }] : [],
    requiredEvents: u.lifecycle ? [item(codexEvidence.find(i => i.id === 'upgrade-lifecycle')!)] : [],
    mustNot: u.mustNot.map(item), expect: [
      ...u.expect.filter(i => i.id !== 'upgrade-lifecycle').map(i => ({ id: i.id, text: i.text, anyOf: [item(i)] })),
      ...(u.lifecycle ? [{ id: 'upgrade-evidence', text: 'Every upgrade phase has complete native and wire rule evidence.',
        anyOf: [{ id: 'upgrade-evidence', text: 'Complete upgrade evidence.', judge: 'script' as const, check: completeUpgradeEvidence }] }] : []),
    ], common: [] };
}
