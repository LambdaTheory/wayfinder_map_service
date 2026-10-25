// The Scenario format (spec R1). A Scenario is harness-neutral: it names Map state, human turns,
// Controller actions and verdict items; Drivers decide how to start a client and read its records.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entries, harnesses } from './evidence.ts';
import type { AttemptRecord, Entry, Harness, TicketType, WireReference, WireSettlement } from './evidence.ts';

export const scenarioKinds = ['real-problem', 'design-hazard', 'diagnostic-probe'] as const;
export type ScenarioKind = typeof scenarioKinds[number];

/** Client capabilities a Scenario may need. A Driver proves each one during onboarding (R2). */
export const capabilities = ['multi-turn', 'new-session', 'concurrent-sessions', 'workspace-files', 'commands',
  'sub-agents', 'async-questions', 'resource-read'] as const;
export type Capability = typeof capabilities[number];

export type CheckStatus = 'holds' | 'violated' | 'unknown';
export interface CheckResult {
  status: CheckStatus;
  reason: string;
  /** Evidence locations, e.g. `events[12]`, `maps.feishu-access-20261022.history[3]`, `receipts[0]`. */
  evidence: string[];
  /** Who decides when a script cannot: the reviewer chain of R4, or the human directly. */
  escalate?: 'model' | 'human';
}
export type ScriptCheck = (attempt: AttemptRecord) => CheckResult;

interface ItemBase {
  id: string;
  /** The behaviour, written as the action itself: a must-not names the wrong action, an expectation the right one. */
  text: string;
  /** A verdict that cannot be decided yet (R6): it never passes or fails on its own and goes to the human. */
  paused?: string;
}
export type Item = ItemBase & (
  | { judge: 'script'; check: ScriptCheck }
  | { judge: 'model' | 'human'; criterion: string }
);

/** Every group must hold; a group holds when at least one of its equivalent ways has evidence (R4). */
export interface ExpectGroup {
  id: string; text: string; anyOf: Item[];
  /** The group applies only to clients with this capability; elsewhere it is reported not applicable. */
  onlyWith?: Capability;
}

export interface Source {
  kind: ScenarioKind;
  /** What happened or what risk the Scenario guards against, with dates. */
  origin: string;
  /** Portable pointers: Map ID and Revision, Issue, document. No private paths. */
  refs: string[];
}

export interface SeedTicket {
  id: string; title: string; question: string; type: TicketType;
  prerequisites?: string[];
  /** Claimant holding an open Ticket. */
  claim?: string;
  settlement?: Omit<WireSettlement, 'introducedAtRevision'>;
}
export interface SeedContent { id: string; text: string; references?: WireReference[] }
export interface SeedMap {
  mapId: string; title: string; destination: string; notes: string;
  tickets: SeedTicket[]; fog?: SeedContent[]; scopeExclusions?: SeedContent[];
}

export interface Seed {
  /**
   * `current-visible-state` rebuilds only what a reader sees now (the agent observes seeding Revisions, not the
   * original history). A Scenario that depends on history, a Conflict or a restart says so through Controller
   * actions or `history`.
   */
  restores: 'nothing' | 'current-visible-state' | 'history';
  maps: SeedMap[];
  /** Directories under `tests/behaviour/fixtures/` copied into the agent's working directory. */
  fixtures: string[];
  /** For a seed taken from a real Map: the source and every conversion step, including Claims kept or cleared and redactions. */
  derivedFrom?: { mapId: string; revision: number; date: string; conversion: string[] };
}

export interface Turn {
  /** Session label; one label is one logical work session with its own credential and Client ID. */
  session: string;
  say: string;
  /**
   * `opening` starts the session. `reply` answers one specific proposal and is sent only after that proposal
   * appeared; otherwise the Attempt stops as `precondition-not-met`. `nudge` carries no answer ("继续").
   */
  kind: 'opening' | 'reply' | 'nudge';
  answers?: {
    proposal: string;
    /** Runtime gate over the session's last assistant message. The precondition is judged again afterwards. */
    cue: RegExp;
  };
  /** Start this session's client afresh (recovery in a new session) instead of resuming it. */
  freshProcess?: boolean;
  /** Start together with the previous turn (concurrent sessions). */
  concurrent?: boolean;
}

export const controllerActions = ['conflicting-write', 'cut-agent-route', 'stop-service', 'start-service',
  'restart-onto-canary'] as const;
export interface ControllerAction {
  /** Index into `turns`: before it starts, after it ends, or while it runs (once the agent has read the Map). */
  when: { before: number } | { after: number } | { during: number };
  action: typeof controllerActions[number];
  detail: string;
}

export const commonChecks = ['no-chat-in-question-or-notes', 'attributable-evidence', 'no-partial-probe',
  'input-error-correction', 'reference-shape', 'status-narration'] as const;
export type CommonCheck = typeof commonChecks[number];

/** Historical problems that must point at a concrete assertion, not at a similar Scenario name. */
export const historicalProblems = ['catalog-pagination', 'complete-command-shape', 'reference-shape',
  'correction-after-refusal', 'stale-replay-after-conflict', 'answer-lost', 'claim-stuck',
  'out-of-scope-settled', 'borrowed-credentials', 'imitated-interface-unread'] as const;
export type HistoricalProblem = typeof historicalProblems[number];

export interface Scenario {
  id: string;
  /** Raised whenever a verdict item changes, so results across versions are marked not directly comparable (R5). */
  version: number;
  title: string;
  source: Source;
  target: string;
  applies: { entries: Entry[]; needs: Capability[]; note?: string };
  seed: Seed;
  turns: Turn[];
  controller: ControllerAction[];
  /** Events that must be proven before any other verdict counts (R4), e.g. a real Conflict. */
  requiredEvents: Item[];
  mustNot: Item[];
  expect: ExpectGroup[];
  common: CommonCheck[];
  /** Historical problem → id of the item in this Scenario that asserts it. */
  covers?: Partial<Record<HistoricalProblem, string>>;
  /** Why the Scenario cannot run yet. A not-ready Scenario stays in every count. */
  pending?: string[];
}

export const fixturesRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Structural errors. Every library Scenario must have none, ready or not. */
export function validateScenario(s: Scenario): string[] {
  const errors: string[] = [];
  const err = (message: string) => errors.push(`${s.id || '<no id>'}: ${message}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(s.id ?? '')) err('id must be a stable identifier like S0b');
  if (!Number.isInteger(s.version) || s.version < 1) err('version must be a positive integer');
  if (!s.title?.trim()) err('title is required');
  if (!s.target?.trim()) err('target behaviour is required');
  if (!scenarioKinds.includes(s.source?.kind)) err('source.kind must be real-problem, design-hazard or diagnostic-probe');
  if (!s.source?.origin?.trim()) err('source.origin is required');
  if (!s.source?.refs?.length) err('source.refs needs at least one pointer');
  if (s.source?.kind === 'diagnostic-probe') err('diagnostic probes are not library Scenarios');
  if (!s.applies?.entries?.length) err('applies.entries is empty');
  for (const entry of s.applies?.entries ?? []) if (!entries.includes(entry)) err(`unknown entry ${entry}`);
  for (const need of s.applies?.needs ?? []) if (!capabilities.includes(need)) err(`unknown capability ${need}`);
  if (!['nothing', 'current-visible-state', 'history'].includes(s.seed?.restores)) err('seed.restores is required');
  if (s.seed?.restores === 'nothing' && s.seed.maps.length) err('a seed that restores nothing has no Maps');
  if (s.seed?.restores === 'current-visible-state' && !s.seed.maps.length) err('a state seed needs at least one Map');
  if (s.seed?.restores === 'history') err('history fixtures are not supported yet; use Controller actions');
  for (const map of s.seed?.maps ?? []) validateSeedMap(map, err);
  if (!s.turns?.length) err('at least one turn is required');
  const sessions = new Set<string>();
  s.turns?.forEach((turn, index) => {
    if (!turn.say?.trim()) err(`turn ${index} says nothing`);
    if (!sessions.has(turn.session) && turn.kind !== 'opening') err(`turn ${index} is the first of session ${turn.session} but not an opening`);
    if (sessions.has(turn.session) && turn.kind === 'opening' && !turn.freshProcess) err(`turn ${index} reopens session ${turn.session} without freshProcess`);
    if (turn.kind === 'reply' && !turn.answers) err(`turn ${index} is a reply without the proposal it answers`);
    if (turn.kind !== 'reply' && turn.answers) err(`turn ${index} declares a proposal but is not a reply`);
    if (turn.concurrent && index === 0) err('the first turn cannot be concurrent');
    sessions.add(turn.session);
  });
  if (sessions.size > 1 && !s.applies.needs.includes('concurrent-sessions') && s.turns.some(t => t.concurrent)) err('concurrent turns need the concurrent-sessions capability');
  if (s.turns.some((t, i) => i > 0 && t.session === s.turns[i - 1]!.session && !t.freshProcess) && !s.applies.needs.includes('multi-turn')) err('several turns in one session need the multi-turn capability');
  if (s.turns.some(t => t.freshProcess) && !s.applies.needs.includes('new-session')) err('freshProcess needs the new-session capability');
  for (const action of s.controller ?? []) {
    const index = 'before' in action.when ? action.when.before : 'after' in action.when ? action.when.after : action.when.during;
    if (!s.turns[index]) err(`controller action ${action.action} points at missing turn ${index}`);
  }
  // A Controller action that should provoke a reaction must be proven to have taken effect (R4).
  const proven = (pattern: RegExp) => s.requiredEvents.some(e => e.judge === 'script' && pattern.test(e.id));
  if (s.controller.some(a => a.action === 'conflicting-write') && !proven(/conflict/i)) err('a conflicting write needs a script-proven required event that the agent got a Conflict');
  if (s.controller.some(a => a.action === 'cut-agent-route') && !proven(/route|outage|unreachable/i)) err('a cut route needs a script-proven required event that the agent hit it');
  if (s.turns.some(t => t.kind === 'reply') && !s.requiredEvents.some(e => /proposal|precondition/i.test(e.id))) err('reply turns need a required event re-judging that the proposal appeared');
  if (!s.expect?.some(group => !group.onlyWith)) err('at least one unconditional expectation group is required: "did nothing wrong" alone cannot pass');
  const ids = new Set<string>();
  const checkItem = (item: Item, where: string) => {
    if (!item.id?.trim()) err(`${where} item without id`);
    if (ids.has(item.id)) err(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (!item.text?.trim()) err(`${item.id}: text is required`);
    if (item.judge === 'script' && typeof item.check !== 'function') err(`${item.id}: script item without check`);
    if ((item.judge === 'model' || item.judge === 'human') && !item.criterion?.trim()) err(`${item.id}: ${item.judge} item without criterion`);
  };
  s.requiredEvents?.forEach(item => checkItem(item, 'required event'));
  s.mustNot?.forEach(item => checkItem(item, 'must-not'));
  for (const group of s.expect ?? []) {
    if (!group.id?.trim() || !group.text?.trim()) err('expectation group without id or text');
    if (!group.anyOf?.length) err(`expectation group ${group.id} has no way to hold`);
    if (group.anyOf?.length && group.anyOf.every(item => item.paused)) err(`expectation group ${group.id} is entirely paused`);
    if (group.onlyWith && !capabilities.includes(group.onlyWith)) err(`group ${group.id}: unknown capability ${group.onlyWith}`);
    group.anyOf?.forEach(item => checkItem(item, `group ${group.id}`));
  }
  for (const check of s.common ?? []) if (!commonChecks.includes(check)) err(`unknown common check ${check}`);
  for (const [problem, itemId] of Object.entries(s.covers ?? {})) {
    if (!historicalProblems.includes(problem as HistoricalProblem)) err(`unknown historical problem ${problem}`);
    if (!ids.has(itemId!) && !commonChecks.includes(itemId as CommonCheck)) err(`covers ${problem} points at missing item ${itemId}`);
  }
  return errors;
}

function validateSeedMap(map: SeedMap, err: (m: string) => void) {
  const ids = new Set(map.tickets.map(t => t.id));
  if (ids.size !== map.tickets.length) err(`${map.mapId}: duplicate Ticket ids`);
  for (const t of map.tickets) {
    for (const p of t.prerequisites ?? []) if (!ids.has(p)) err(`${map.mapId}/${t.id}: prerequisite ${p} missing`);
    if (t.settlement && t.claim) err(`${map.mapId}/${t.id}: a settled Ticket holds no Claim`);
    if (t.settlement) {
      const expected = t.type === 'research' ? 'finding' : t.type === 'task' ? 'completion' : 'decision';
      if (t.settlement.outcome.kind !== expected) err(`${map.mapId}/${t.id}: ${t.type} settles as ${expected}`);
      for (const p of t.prerequisites ?? []) if (!map.tickets.find(x => x.id === p)?.settlement) err(`${map.mapId}/${t.id}: settled with open prerequisite ${p}`);
    }
  }
}

/** Reasons a structurally valid Scenario cannot run yet. */
export function readiness(s: Scenario): string[] {
  const reasons = [...(s.pending ?? [])];
  for (const fixture of s.seed.fixtures) if (!existsSync(fixturesRoot + fixture)) reasons.push(`fixture ${fixture} is not prepared`);
  return reasons;
}

/**
 * What each client is expected to support. `onboarded` turns true only when its Driver has passed the five
 * onboarding checks of R2 (B02a for Codex, B06 for the others); until then no cell is shown as applicable.
 */
export const clientProfiles: Record<Harness, { onboarded: boolean; entries: Entry[]; supports: Partial<Record<Capability, boolean | 'unverified'>> }> = {
  codex: { onboarded: false, entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': true,
    'workspace-files': true, commands: true, 'resource-read': true, 'sub-agents': 'unverified', 'async-questions': false } },
  claude: { onboarded: false, entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': true,
    'workspace-files': true, commands: true, 'resource-read': true, 'sub-agents': 'unverified', 'async-questions': false } },
  chatgpt: { onboarded: false, entries: ['chatgpt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': 'unverified',
    'workspace-files': false, commands: false, 'resource-read': false, 'sub-agents': false, 'async-questions': false } },
  pi: { onboarded: false, entries: ['mcp-only'], supports: {} },
  grok: { onboarded: false, entries: ['mcp-only'], supports: {} },
};

export type Cell = { state: 'applicable' } | { state: 'not-applicable' | 'unverified' | 'not-ready'; reasons: string[] };

/** One cell of the applicability matrix: a Scenario on one client through one Entry. */
export function cell(s: Scenario, harness: Harness, entry: Entry): Cell {
  const profile = clientProfiles[harness];
  if (!profile.entries.includes(entry) || !s.applies.entries.includes(entry)) return { state: 'not-applicable', reasons: [`entry ${entry}`] };
  const missing = s.applies.needs.filter(need => profile.supports[need] === false);
  if (missing.length) return { state: 'not-applicable', reasons: missing };
  const unverified = s.applies.needs.filter(need => profile.supports[need] !== true);
  const notReady = readiness(s);
  if (notReady.length) return { state: 'not-ready', reasons: notReady };
  if (!profile.onboarded) return { state: 'unverified', reasons: [...unverified, 'driver not onboarded'] };
  if (unverified.length) return { state: 'unverified', reasons: unverified };
  return { state: 'applicable' };
}

export { harnesses, entries };
