// Upgrade compatibility checks (spec §3). They sit outside the 26 candidates and have their own Batches.
// Each one restarts the isolated service onto a canary build whose rules a model can only follow if it read them
// (`tests/helpers/canary-release.mjs`); `tests/helpers/upgrade-live.mjs` is the earlier runner they may reuse.
// An Attempt of one names it as `subject: { kind: 'upgrade-check', id, version }`.
import { at, holds, mapCalls, need, resultIs, unknown, violated, writeCalls } from './checks.ts';
import type { AttemptRecord, GivenRules, RulesSource } from './evidence.ts';
import type { Entry, Harness } from './evidence.ts';
import type { ScriptCheck } from './scenario.ts';

export interface UpgradeItem {
  id: string;
  text: string;
  /** AttemptRecord fields that prove or refute it. */
  evidence: string[];
  /** Script judgement; an item without one goes to model review with its text as the criterion. */
  check?: ScriptCheck;
}

/** The canary build's rules (`tests/helpers/canary-release.mjs`): one only in the instructions, one only in map_apply's description. */
export const canary = { version: '9.9.9', replyWord: 'LANTERN', ticketTitlePrefix: 'v2: ' };

const versionOf = (g: GivenRules) => g.rulesSource.kind === 'instructions' ? g.rulesSource.versionLine.replace(/^version:\s*/, '')
  : /\b\d+\.\d+\.\d+\b/.exec(g.rulesSource.description)?.[0] ?? '';
/** The rules before the restart, the rules after it, and where the second phase starts. */
function phases(a: AttemptRecord) {
  const before = a.given.find(g => g.phase === 'initial');
  const after = a.given.find(g => g.phase !== 'initial');
  return before && after ? { old: versionOf(before), current: versionOf(after), from: after.fromSeq } : null;
}
const versionArg = (e: { arguments: unknown }) => (e.arguments as { version?: unknown } | null)?.version;

/** Write calls after the restart, in order; `unknown` when the record lacks either phase or the calls. */
function afterRestart(a: AttemptRecord, label: string) {
  const p = phases(a);
  const gap = need(a, label, 'events.tool-call');
  if (gap) return { gap };
  if (!p) return { gap: unknown(`${label}: the record does not hold the rules before and after the restart`) };
  return { p, writes: writeCalls(a).filter(e => e.seq >= p.from) };
}

const refusedFirst: ScriptCheck = a => {
  const r = afterRestart(a, 'refusal');
  if ('gap' in r) return r.gap!;
  const first = r.writes[0];
  if (!first) return violated('no write after the restart');
  return resultIs(first, 'version-mismatch') ? holds('the first write after the restart was refused', [at(a, first)]) : violated('the first write after the restart was not refused', [at(a, first)]);
};
/** A client that can read Resources recovers by reading the rules and rereading the Map before writing again. */
const readsBeforeRetry: ScriptCheck = a => {
  const r = afterRestart(a, 'recovery');
  if ('gap' in r) return r.gap!;
  const refusal = r.writes.find(e => resultIs(e, 'version-mismatch'));
  if (!refusal) return violated('no version_mismatch to recover from');
  const retry = r.writes.find(e => e.seq > refusal.seq && e.session === refusal.session);
  const until = retry?.seq ?? Infinity;
  const read = a.events.some(e => e.kind === 'resource-read' && e.actor === 'agent' && e.session === refusal.session && e.seq > refusal.seq && e.seq < until && e.uri.startsWith('wayfinder://workflow/exploration'));
  const reread = mapCalls(a, 'map_read').some(e => e.session === refusal.session && e.seq > refusal.seq && e.seq < until);
  return read && reread ? holds('read the rules and reread the Map before writing again', [at(a, refusal)]) : violated(`before writing again: ${read ? '' : 'no Resource read '}${reread ? '' : 'no map_read'}`.trim(), [at(a, refusal)]);
};
const committedAtNewVersion: ScriptCheck = a => {
  const r = afterRestart(a, 'new-version write');
  if ('gap' in r) return r.gap!;
  const ok = r.writes.filter(e => resultIs(e, 'committed') && versionArg(e) === r.p.current);
  return ok.length ? holds(`committed with ${r.p.current}`, ok.map(e => at(a, e))) : violated(`no committed write with ${r.p.current}`);
};
const noOldVersionCommit: ScriptCheck = a => {
  const r = afterRestart(a, 'old-version write');
  if ('gap' in r) return r.gap!;
  const bad = r.writes.filter(e => resultIs(e, 'committed') && versionArg(e) === r.p.old && r.p.old !== r.p.current);
  return bad.length ? violated('a write committed under the old release', bad.map(e => at(a, e))) : holds('nothing committed under the old release');
};
const noDoubleWrite: ScriptCheck = a => {
  const gap = need(a, 'double write', 'events.tool-call');
  if (gap) return gap;
  const seen = new Map<string, string>();
  for (const e of writeCalls(a).filter(x => resultIs(x, 'committed'))) {
    const key = JSON.stringify((e.arguments as { commands?: unknown; title?: unknown } | null)?.commands ?? (e.arguments as { title?: unknown } | null)?.title ?? null);
    if (seen.has(key)) return violated('the same change committed twice', [seen.get(key)!, at(a, e)]);
    seen.set(key, at(a, e));
  }
  return holds('no change committed twice');
};
const noGuessedVersion: ScriptCheck = a => {
  const gap = need(a, 'guessed version', 'events.tool-call');
  if (gap) return gap;
  const known = new Set(a.given.map(versionOf));
  const guessed = writeCalls(a).filter(e => !known.has(String(versionArg(e))));
  return guessed.length ? violated('a write with a version no rules source stated', guessed.map(e => at(a, e))) : holds('every write named a stated release');
};
const followsCanary: ScriptCheck = a => {
  const r = afterRestart(a, 'canary rules');
  if ('gap' in r) return r.gap!;
  const titles = r.writes.filter(e => resultIs(e, 'committed')).flatMap(e => ((e.arguments as { commands?: { kind: string; ticket?: { title?: string } }[] } | null)?.commands ?? [])
    .filter(c => c.kind === 'ticket.create').map(c => c.ticket?.title ?? ''));
  if (!titles.length) return violated('no Ticket created after the restart to show the map_apply rule');
  const bad = titles.filter(t => !t.startsWith(canary.ticketTitlePrefix));
  return bad.length ? violated(`Ticket titles without "${canary.ticketTitlePrefix}": ${bad.join(', ')}`) : holds('every new Ticket title follows the map_apply rule');
};
const noRetryInOldChat: ScriptCheck = a => {
  const r = afterRestart(a, 'old chat');
  if ('gap' in r) return r.gap!;
  const refusal = r.writes.find(e => resultIs(e, 'version-mismatch'));
  if (!refusal) return violated('no version_mismatch in the old chat');
  const retries = r.writes.filter(e => e.seq > refusal.seq && e.session === refusal.session);
  // Not retrying is scriptable; asking the human to refresh and open a new chat is read by a reviewer either way.
  return retries.length ? violated('the old chat wrote again after the refusal', retries.map(e => at(a, e)))
    : unknown('no write after the refusal; a reviewer checks the reply asked for a refresh and a new chat', [at(a, refusal)], 'model');
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
const readsRules: UpgradeItem = { id: 'reads-new-rules', text: 'The agent reads wayfinder://workflow/exploration and rereads the Map before writing again.',
  evidence: ['events[kind=resource-read]', 'events[kind=tool-call,tool=map_read]'], check: readsBeforeRetry };
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
      evidence: ['events[kind=message]', 'events[kind=tool-call]', 'events[kind=controller]'], check: noRetryInOldChat }] },
  { id: 'U-chatgpt-new-chat', version: 1, harness: 'chatgpt', entry: 'chatgpt', situation: 'A new ChatGPT chat after Refresh tools.',
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools, then open a new chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [{ ...newVersion, text: 'The write carries the release stated in the write tool parameter and commits once.' }, canaryRule] },
];
