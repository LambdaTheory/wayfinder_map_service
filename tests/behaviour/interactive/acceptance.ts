// B09b uses B01 records and B03 verdicts. Capability confirmation is separate from behaviour evidence.
import type { AttemptRecord, EventRecord } from '../evidence.ts';
import type { CheckResult, Scenario } from '../scenario.ts';
import { judgeAttempt } from '../verdict.ts';
import type { Review } from '../verdict.ts';
import { verifiedReadings } from './reviews.ts';
import type { VerifiedReviews } from './reviews.ts';
import { questionTool } from './tools.ts';
import { W1, W7 } from '../scenarios/pace.ts';

export const interactiveVerdictVersion = 2;
export const abilities = ['async-question', 'prepare-while-waiting', 'adjust-recommendation', 'continue-same-turn'] as const;
export type Ability = typeof abilities[number];
export interface Confirmation {
  status: 'supported' | 'unsupported' | 'unverified';
  clientVersion: string;
  surface: string;
  checkedAt: string;
  /** Official documentation + exact flags/mode. A generic product name is insufficient. */
  documentation: string[];
  reason: string;
  /** A separate, earlier minimal probe, with raw locations and an explicit operator reading. */
  probe?: { path: string; capturePath: string; sha256: string; endedAt: string; locations: string[]; reading: string; selection: Selection };
}
export interface Selection {
  question?: number;
  preparation?: number;
  preparationFinding?: string;
  preparationUse?: string;
  answer?: number;
  revisedRecommendation?: number;
  continuation?: number;
}
export interface Assessment {
  schema: 'wayfinder-interactive-assessment/1';
  scenario: 'W1' | 'W7';
  verdictVersion: number;
  confirmations: Record<Ability, Confirmation>;
  selection: Selection;
  reviews: Review[];
}
const ids: Record<Ability, string> = { 'async-question': 'B09Async', 'prepare-while-waiting': 'B09Prepare',
  'adjust-recommendation': 'B09Adjust', 'continue-same-turn': 'B09Continue' };
export const criteria: Record<Ability, string> = {
  'async-question': 'Does the selected question visibly ask the human for a concrete choice without ending the active turn? Does meaningful main-session work continue before the answer? A queued reply, blocking question tool, elapsed time or a delegation launch alone is insufficient.',
  'prepare-while-waiting': 'Does completed work between the question and answer prepare another Frontier Ticket, with substantive findings or candidate recommendations? Does the later recommendation use that material? A promise to research, generic output or delegation event alone is insufficient.',
  'adjust-recommendation': 'Compare the question/proposal, human answer and revised recommendation. Does the answer change a relevant assumption, and does the next concrete recommendation reflect that change, naming its reason? Repetition or merely acknowledging the answer does not count.',
  'continue-same-turn': 'In the turn handling the concrete answer, does the assistant advance the Map discussion with the next concrete Frontier question or action without a nudge? Acknowledging the answer or saying it will continue is insufficient.',
};
const check = (status: CheckResult['status'], reason: string, evidence: string[] = []): CheckResult => ({ status, reason, evidence });
const assistant = (e: EventRecord) => e.kind === 'message' && e.actor === 'agent' && e.role === 'assistant' && !!e.text.trim();
const question = (e: EventRecord) => assistant(e) || (e.kind === 'tool-call' && questionTool(e.tool) !== null);
const human = (e: EventRecord) => e.kind === 'message' && e.actor === 'script-human' && e.role === 'user' && !!e.text.trim();
function workOutput(e: EventRecord): string | null {
  if (e.kind !== 'tool-call' || e.actor !== 'agent' || !e.result.known || e.failed) return null;
  // A closed allowlist: agent lifecycle/control events and arbitrary shell success are not work products.
  const value = e.result.value;
  if (['exec_command', 'functions.exec_command', 'Bash'].includes(e.tool)) {
    const args = e.arguments && typeof e.arguments === 'object' ? e.arguments as Record<string, unknown> : {};
    const command = args.cmd ?? args.command;
    if (typeof command !== 'string' || !/^(?:cat|head|tail|rg|grep|sed|wc)\s/.test(command.trim()) || /[\n;&|`$<>]/.test(command)) return null;
    if (!value || typeof value !== 'object') return null;
    const result = value as Record<string, unknown>;
    const output = result.stdout ?? result.output;
    return (result.exit_code === 0 || result.exitCode === 0) && typeof output === 'string' && output.trim() ? output : null;
  }
  if (!['Read', 'read_file', 'functions.read_file', 'map_read'].includes(e.tool)) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return null;
}

export const selectedNames = (ability: Ability): (keyof Selection)[] => ability === 'async-question' ? ['question', 'preparation', 'answer']
    : ability === 'prepare-while-waiting' ? ['question', 'preparation', 'answer', 'revisedRecommendation']
    : ability === 'adjust-recommendation' ? ['question', 'answer', 'revisedRecommendation'] : ['question', 'answer', 'continuation'];

export function structure(a: AttemptRecord, ability: Ability, selected: Selection): CheckResult {
  if (!a.combination.visibleModel.known || !a.combination.effort.known) return check('unknown', 'Visible model and effort must both be evidenced.', ['combination.visibleModel', 'combination.effort']);
  if (a.missing.some(m => ['events', 'events.message', 'events.tool-call', 'native.integrity', 'native.boundaries', 'native.sidechain', 'native.unhandled', 'sessions.nativeId', 'combination.model-mismatch', 'combination.visibleModel', 'combination.effort'].includes(m))) {
    return check('unknown', 'Native records or turn boundaries are incomplete; no temporal conclusion is safe.', ['missing']);
  }
  const names = selectedNames(ability);
  const events = names.map(name => a.events.find(e => e.seq === selected[name]));
  const locators = events.flatMap(e => e ? [`events[${a.events.indexOf(e)}]`] : []);
  if (events.some(e => !e)) return check('unknown', `Missing native evidence: ${names.filter((_, i) => !events[i]).join(', ')}`, locators);
  const found = events as EventRecord[];
  if (!question(found[0]!) || !human(found[names.indexOf('answer')]!)) return check('unknown', 'The question or answer locator has the wrong native event kind.', locators);
  const asked = found[0]!;
  if (ability === 'async-question' && asked.kind === 'tool-call' && questionTool(asked.tool) === 'blocking') {
    return check('violated', 'A blocking question tool cannot establish asynchronous questioning.', locators);
  }
  if (names.includes('preparation')) {
    const output = workOutput(found[names.indexOf('preparation')]!);
    if (!output || !selected.preparationFinding?.trim() || !output.includes(selected.preparationFinding)) {
      return check('unknown', 'Preparation needs a cited finding in a completed read result, not a launch, control event or wait.', locators);
    }
    const next = found[names.indexOf('revisedRecommendation')];
    if (ability === 'prepare-while-waiting' && (!selected.preparationUse?.trim() || !next || next.kind !== 'message' || !next.text.includes(selected.preparationUse))) {
      return check('unknown', 'Cite where the later recommendation uses the prepared finding; relevance still needs review.', locators);
    }
  }
  for (const name of ['revisedRecommendation', 'continuation'] as const) {
    if (names.includes(name) && !assistant(found[names.indexOf(name)]!)) return check('unknown', `${name} needs a native assistant message.`, locators);
  }
  if (found.some((e, i) => i > 0 && (e.seq <= found[i - 1]!.seq || Date.parse(e.at) < Date.parse(found[i - 1]!.at)))) {
    return check('violated', 'The required question → work → answer → continuation order is contradicted.', locators);
  }
  // W1's continuation is in the turn handling the answer, even when the question ended a previous turn.
  // Preparation and adjustment need their actual order/content; neither implies asynchronous questioning.
  const together = ability === 'async-question' ? found
    : ability === 'continue-same-turn' ? found.slice(1) : [];
  if (together.length) {
    if (together.some(e => e.turn === null) || !a.sessions[0]?.turns.some(t => t.index === together[0]!.turn)) return check('unknown', 'No completed native turn brackets the selected events.', locators);
    if (together.some(e => e.turn !== together[0]!.turn || e.session !== together[0]!.session)) return check('violated', 'The native record ended the turn before the required behaviour.', locators);
  }
  const answer = found[names.indexOf('answer')]!;
  if (ability === 'continue-same-turn' && a.events.some(e => e.seq > answer.seq && e.seq < found.at(-1)!.seq && human(e))) {
    return check('violated', 'Another human message intervened before continuation.', locators);
  }
  return check('holds', 'Native event types, order and turn boundaries support the structural requirement; content still requires review.', locators);
}

function confirmation(a: AttemptRecord, c: Confirmation | undefined, verifiedProbes: Set<string>): CheckResult {
  if (!c || !['supported', 'unsupported'].includes(c.status)) return check('unknown', 'Capability has not been confirmed on this version and surface.');
  if (!c.reason?.trim() || !c.documentation?.length || !c.documentation.every(d => /^https:\/\//.test(d))
    || !a.client.version.known || a.client.version.value !== c.clientVersion
    || !a.client.surface.known || a.client.surface.value !== c.surface
    || !Number.isFinite(Date.parse(a.run.startedAt)) || !Number.isFinite(Date.parse(c.checkedAt)) || Date.parse(c.checkedAt) >= Date.parse(a.run.startedAt)) {
    return check('unknown', 'Capability confirmation must precede collection and match this exact client version and surface.');
  }
  if (c.status === 'supported' && (!c.probe || !verifiedProbes.has(c.probe.sha256) || !c.probe.locations.length || !c.probe.reading.trim()
    || !Number.isFinite(Date.parse(c.probe.endedAt)) || Date.parse(c.probe.endedAt) > Date.parse(c.checkedAt))) {
    return check('unknown', 'Supported capability needs a retained, verified earlier minimal probe and an operator reading.');
  }
  return check('holds', `${c.status}: ${c.reason}`, c.probe?.locations ?? c.documentation);
}

/** Separate interactive variants; W1/W7's scripted verdicts and versions are unchanged. */
export function interactiveScenario(ability: Ability, assessment: Assessment, probes: Set<string>): Scenario {
  const source = assessment.scenario === 'W1' ? W1 : W7;
  const c = assessment.confirmations[ability];
  return { ...source, id: ids[ability], version: interactiveVerdictVersion, title: `Interactive ${ability} (${source.id})`,
    source: { kind: 'design-hazard', origin: 'R9 interactive acceptance: scripted turns cannot prove active-turn behaviour.', refs: ['docs/spec/behaviour-testing.md#r9', '#81'] },
    target: criteria[ability], requiredEvents: [{ id: `${ability}.confirmed`, judge: 'script', text: 'Capability confirmed before collection.',
      check: a => confirmation(a, c, probes) }],
    mustNot: [{ id: `${ability}.temporal-violation`, judge: 'script', text: 'A native temporal contradiction is already proved.', check: a => {
      if (c?.status !== 'supported') return check('holds', 'No applicable temporal claim.');
      const result = structure(a, ability, assessment.selection);
      return result.status === 'violated' ? result : check('holds', 'No temporal contradiction proved; missing positive evidence is judged separately.');
    } }], common: [],
    expect: [
      { id: `${ability}.structure`, text: 'Native temporal evidence.', ...(c?.status === 'unsupported' ? { onlyWith: 'async-questions' as const } : {}),
        anyOf: [{ id: `${ability}.structure`, judge: 'script', text: 'Native temporal evidence.', check: a => structure(a, ability, assessment.selection) }] },
      { id: `${ability}.content`, text: criteria[ability], ...(c?.status === 'unsupported' ? { onlyWith: 'async-questions' as const } : {}),
        anyOf: [{ id: `${ability}.content`, judge: 'model', text: criteria[ability], criterion: criteria[ability] }] },
    ] };
}

export function assess(record: AttemptRecord, assessment: Assessment, verifiedProbes: Set<string>, reviews?: VerifiedReviews) {
  const verdicts = abilities.map(ability => {
    const scenario = interactiveScenario(ability, assessment, verifiedProbes);
    const attempt = { ...record, subject: { kind: 'scenario' as const, id: scenario.id, version: assessment.verdictVersion } };
    const verdict = judgeAttempt(scenario, attempt, { reviews: verifiedReadings(record, assessment, reviews), supports: { 'async-questions': false } });
    const c = assessment.confirmations[ability];
    verdict.gaps = c?.status === 'unsupported' && verdict.outcome === 'not-applicable'
      ? [`${ability}: ${c.reason}; coverage absent on ${c.surface} ${c.clientVersion}; unsupported is an operator declaration, not a passed capability probe.`] : [];
    for (const group of verdict.expect) {
      if (group.status === 'not-applicable' && verdict.outcome === 'not-applicable') group.gap = `${ability}: ${c?.reason ?? 'support unconfirmed'}`;
      else delete group.gap;
      for (const item of group.items) if (item.id.endsWith('.content')) item.evidence = selectedNames(ability).flatMap(name => {
        const index = record.events.findIndex(e => e.seq === assessment.selection[name]); return index < 0 ? [] : [`events[${index}]`];
      });
    }
    return { ability, attempt, verdict };
  });
  return { schema: 'wayfinder-interactive-result/1', scenario: assessment.scenario, verdicts,
    observations: record.sessions.flatMap(s => s.turns.map(t => ({ session: s.label, turn: t.index, durationMs: t.durationMs }))),
    note: 'Durations are observations only. These capability verdicts do not replace the complete W1/W7 or human journey verdicts.' };
}
