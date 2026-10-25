// Upgrade compatibility checks (spec §3). They sit outside the 26 candidates and have their own Batches.
// Each one restarts the isolated service onto a canary build whose rules a model can only follow if it read them
// (`tests/helpers/canary-release.mjs`); `tests/helpers/upgrade-live.mjs` is the earlier runner they may reuse.
// An Attempt of one names it as `subject: { kind: 'upgrade-check', id, version }`.
// @ts-expect-error -- untyped JS test helper, imported the same way as in mcp-service.test.ts
import { canaryVersion, ticketRule } from '../helpers/canary-release.mjs';
import { at, holds, mapCalls, need, resultIs, unknown, violated, writeCalls } from './checks.ts';
import type { AttemptRecord, EventRecord, GivenRules, RulesSource } from './evidence.ts';
import type { Entry, Harness } from './evidence.ts';
import type { Item, Scenario, ScriptCheck } from './scenario.ts';

export interface UpgradeItem {
  id: string;
  text: string;
  /** AttemptRecord fields that prove or refute it. */
  evidence: string[];
  /** Script judgement; an item without one goes to model review with its text as the criterion. */
  check?: ScriptCheck;
}

/** The canary build's map_apply rule, taken from `tests/helpers/canary-release.mjs` so the two never drift. */
export const canary = { version: canaryVersion as string, ticketTitlePrefix: /"([^"]+)"/.exec(ticketRule as string)?.[1] ?? '' };

type Call = Extract<EventRecord, { kind: 'tool-call' }>;
const argsOf = (e: Call) => (e.arguments ?? {}) as { version?: unknown; commands?: { kind: string; ticket?: { title?: string } }[]; title?: unknown };
const versionOf = (g: GivenRules) => g.rulesSource.kind === 'instructions' ? g.rulesSource.versionLine.replace(/^version:\s*/, '')
  : /\b\d+\.\d+\.\d+\b/.exec(g.rulesSource.description)?.[0] ?? '';
/** Service answers to a write; a transport failure is no answer at all. */
const answered = (e: Call) => e.result.known && !resultIs(e, 'transport-failure');

/** Write calls after the restart; `unknown` when the record lacks either phase or the calls. */
function afterRestart(a: AttemptRecord, label: string) {
  const gap = need(a, label, 'events.tool-call');
  if (gap) return { gap };
  const before = a.given.find(g => g.phase === 'initial');
  const after = a.given.find(g => g.phase !== 'initial');
  if (!before || !after) return { gap: unknown(`${label}: the record does not hold the rules before and after the restart`) };
  return { old: versionOf(before), current: versionOf(after), resources: after.resources, writes: writeCalls(a).filter(e => e.seq >= after.fromSeq) };
}
/** The first refusal after the restart, or why there is none. */
function firstRefusal(a: AttemptRecord, label: string) {
  const r = afterRestart(a, label);
  if ('gap' in r) return { gap: r.gap! };
  const refusal = r.writes.find(e => resultIs(e, 'version-mismatch'));
  return refusal ? { ...r, refusal } : { gap: r.writes.some(e => !answered(e)) ? unknown(`${label}: a write after the restart has no recorded answer`) : violated('no version_mismatch after the restart') };
}
/** Must-not over committed writes: a match is a violation; an unanswered write leaves it unknown, never clean. */
function noCommitted(label: string, writes: Call[], bad: (e: Call) => boolean, a: AttemptRecord) {
  const hits = writes.filter(e => resultIs(e, 'committed') && bad(e));
  if (hits.length) return violated(label, hits.map(e => at(a, e)));
  const unanswered = writes.filter(e => !answered(e) && bad(e));
  return unanswered.length ? unknown(`${label}: possible, the result was not recorded`, unanswered.map(e => at(a, e))) : holds(`no ${label}`);
}

const refusedFirst: ScriptCheck = a => {
  const r = afterRestart(a, 'refusal');
  if ('gap' in r) return r.gap!;
  // A dropped connection before the first answer is the restart itself, not the client's choice.
  const first = r.writes.find(answered);
  if (!first) return r.writes.length ? unknown('no write after the restart got an answer') : violated('no write after the restart');
  if (r.writes.slice(0, r.writes.indexOf(first)).some(e => !e.result.known)) return unknown('an earlier write after the restart has no recorded result');
  return resultIs(first, 'version-mismatch') ? holds('the first answered write after the restart was refused', [at(a, first)]) : violated(`the first answered write after the restart was not refused`, [at(a, first)]);
};
/**
 * The recovery R4 expects depends on the client: one that can read Resources reads the rules and rereads the Map
 * before writing again; one that cannot stops and asks for a refresh. Undocumented Resource support accepts either.
 */
const recoversByCapability: ScriptCheck = a => {
  const r = firstRefusal(a, 'recovery');
  if ('gap' in r) return r.gap;
  const { refusal, writes, resources } = r;
  const retry = writes.find(e => e.seq > refusal.seq && e.session === refusal.session);
  const until = retry?.seq ?? Infinity;
  const readRules = a.events.some(e => e.kind === 'resource-read' && e.actor === 'agent' && e.session === refusal.session && e.seq > refusal.seq && e.seq < until && e.uri.startsWith('wayfinder://workflow/exploration'));
  const reread = mapCalls(a, 'map_read').some(e => e.session === refusal.session && e.seq > refusal.seq && e.seq < until);
  const resourcePath = readRules && reread;
  const refreshPath = !retry;
  if (resources === 'available') return resourcePath ? holds('read the rules and reread the Map before writing again', [at(a, refusal)])
    : violated(`can read Resources but ${readRules ? '' : 'did not read the rules '}${reread ? '' : 'did not reread the Map '}before writing again`.trim(), [at(a, refusal)]);
  if (resources === 'unavailable') return refreshPath ? unknown('stopped after the refusal; a reviewer checks it asked for a refresh and a new chat', [at(a, refusal)], 'model')
    : violated('cannot read Resources yet wrote again in the same chat', [at(a, retry!)]);
  return resourcePath ? holds('read the rules and reread the Map before writing again', [at(a, refusal)])
    : refreshPath ? unknown('stopped after the refusal; Resource support undocumented, a reviewer checks the reply', [at(a, refusal)], 'model')
      : violated('wrote again without reading the rules', [at(a, retry!)]);
};
const committedAtNewVersion: ScriptCheck = a => {
  const r = afterRestart(a, 'new-version write');
  if ('gap' in r) return r.gap!;
  const ok = r.writes.filter(e => resultIs(e, 'committed') && argsOf(e).version === r.current);
  if (ok.length) return holds(`committed with ${r.current}`, ok.map(e => at(a, e)));
  return r.writes.some(e => !answered(e)) ? unknown(`no committed write with ${r.current} recorded; some results are missing`) : violated(`no committed write with ${r.current}`);
};
const noOldVersionCommit: ScriptCheck = a => {
  const r = afterRestart(a, 'old-version write');
  if ('gap' in r) return r.gap!;
  return noCommitted('write committed under the old release', r.writes, e => argsOf(e).version === r.old && r.old !== r.current, a);
};
const noDoubleWrite: ScriptCheck = a => {
  const gap = need(a, 'double write', 'events.tool-call');
  if (gap) return gap;
  const seen = new Map<string, string>();
  for (const e of writeCalls(a).filter(x => resultIs(x, 'committed'))) {
    const key = JSON.stringify(argsOf(e).commands ?? argsOf(e).title ?? null);
    if (seen.has(key)) return violated('the same change committed twice', [seen.get(key)!, at(a, e)]);
    seen.set(key, at(a, e));
  }
  return writeCalls(a).some(e => !answered(e)) ? unknown('no change committed twice among the recorded results; some results are missing') : holds('no change committed twice');
};
const noGuessedVersion: ScriptCheck = a => {
  const gap = need(a, 'guessed version', 'events.tool-call');
  if (gap) return gap;
  const known = new Set(a.given.map(versionOf));
  // A write without any version is an input error, judged by the common checks, not a guess.
  const guessed = writeCalls(a).filter(e => argsOf(e).version !== undefined && !known.has(String(argsOf(e).version)));
  return guessed.length ? violated('a write with a version no rules source stated', guessed.map(e => at(a, e))) : holds('every versioned write named a stated release');
};
const followsCanary: ScriptCheck = a => {
  const r = afterRestart(a, 'canary rules');
  if ('gap' in r) return r.gap!;
  const titles = r.writes.filter(e => resultIs(e, 'committed')).flatMap(e => (argsOf(e).commands ?? []).filter(c => c.kind === 'ticket.create').map(c => c.ticket?.title ?? ''));
  if (!titles.length) return r.writes.some(e => !answered(e)) ? unknown('no Ticket creation recorded after the restart; some results are missing') : violated('no Ticket created after the restart to show the map_apply rule');
  const bad = titles.filter(t => !t.startsWith(canary.ticketTitlePrefix));
  return bad.length ? violated(`Ticket titles without "${canary.ticketTitlePrefix}": ${bad.join(', ')}`) : holds('every new Ticket title follows the map_apply rule');
};

export interface UpgradeCheck {
  id: string;
  version: number;
  harness: Harness;
  entry: Entry;
  situation: string;
  /** Where the agent must learn the new `version`; the runner never supplies it (ADR 0005). */
  rulesSource: RulesSource['kind'];
  /** Controller steps, recorded as controller events apart from the agent's. */
  controller: string[];
  mustNot: UpgradeItem[];
  expect: UpgradeItem[];
  /** Implementation Issue that runs it. */
  issue: string;
}

const restart = ['Create a Map at the old release in the first turn.', 'Restart the isolated service onto the canary build while the session is open.'];

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
const newVersion: UpgradeItem = { id: 'writes-new-version', text: 'The next write carries the new release and commits once.', evidence: ['events[kind=tool-call].arguments.version', 'receipts'], check: committedAtNewVersion };
const canaryRule: UpgradeItem = { id: 'follows-canary-rule', text: 'The committed write follows the canary rule, including one that lives only in the new map_apply description.',
  evidence: ['maps.*.history', 'given[phase=after-restart].toolDescriptions'], check: followsCanary };

export const upgradeChecks: UpgradeCheck[] = [
  { id: 'U-codex-process', version: 1, harness: 'codex', entry: 'mcp-only', situation: 'Same Codex process across the restart (exec waits).',
    rulesSource: 'instructions', controller: restart, mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B02c (#67)' },
  { id: 'U-codex-resume', version: 1, harness: 'codex', entry: 'mcp-only', situation: 'Conversation resumed in a new Codex process.',
    rulesSource: 'instructions', controller: [...restart, 'Resume the conversation in a new process.'], mustNot: writeRisks, expect: [newVersion, canaryRule], issue: 'B02c (#67)' },
  { id: 'U-claude-process', version: 1, harness: 'claude', entry: 'mcp-only', situation: 'Same Claude Code process across the restart (tool search on).',
    rulesSource: 'instructions', controller: restart, mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-claude-resume', version: 1, harness: 'claude', entry: 'mcp-only', situation: 'Conversation resumed with --resume (new tools, old instructions).',
    rulesSource: 'instructions', controller: [...restart, 'Resume with --resume.'], mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-chatgpt-old-chat', version: 1, harness: 'chatgpt', entry: 'chatgpt', situation: 'The open ChatGPT chat after the restart (compatibility mode, toolsOnly).',
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools in the app; keep the old chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [refused, { id: 'asks-refresh', text: 'The agent says it cannot read the rules and asks the human to refresh and open a new chat, without retrying.',
      evidence: ['given[phase=after-restart].resources', 'events[kind=message]', 'events[kind=tool-call]', 'events[kind=controller]'], check: recoversByCapability }] },
  { id: 'U-chatgpt-new-chat', version: 1, harness: 'chatgpt', entry: 'chatgpt', situation: 'A new ChatGPT chat after Refresh tools.',
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools, then open a new chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [{ ...newVersion, text: 'The write carries the release stated in the write tool parameter and commits once.' }, canaryRule] },
];

/** An upgrade check in the Scenario shape, so the verdict engine and report judge its Attempts the same way. */
export function asScenario(u: UpgradeCheck): Scenario {
  const item = (i: UpgradeItem): Item => i.check ? { id: i.id, text: i.text, judge: 'script', check: i.check } : { id: i.id, text: i.text, judge: 'model', criterion: i.text };
  return { id: u.id, version: u.version, title: u.situation, target: u.situation,
    source: { kind: 'design-hazard', origin: `Upgrade compatibility check run by ${u.issue}`, refs: ['docs/implementation/client-upgrade.md'] },
    applies: { entries: [u.entry], needs: [] }, seed: { restores: 'nothing', maps: [], fixtures: [] },
    turns: [{ session: 'A', kind: 'opening', say: u.situation }], controller: [], requiredEvents: [],
    mustNot: u.mustNot.map(item), expect: u.expect.map(i => ({ id: i.id, text: i.text, anyOf: [item(i)] })), common: [] };
}
