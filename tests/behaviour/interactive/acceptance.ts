// B09b uses B01 records and B03 verdicts. Capability confirmation is separate from behaviour evidence.
import type { AttemptRecord, EventRecord } from '../evidence.ts';
import type { CheckResult, Scenario } from '../scenario.ts';
import { judgeAttempt } from '../verdict.ts';
import type { Review } from '../verdict.ts';
import { W1, W7 } from '../scenarios/pace.ts';

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
  probe?: { path: string; sha256: string; endedAt: string; locations: string[]; reading: string };
}
export interface Selection {
  question?: number;
  preparation?: number;
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
const criteria: Record<Ability, string> = {
  'async-question': 'Does the selected question visibly ask the human for a concrete choice without ending the active turn? Does meaningful main-session work continue before the answer? A queued reply, blocking question tool, elapsed time or a delegation launch alone is insufficient.',
  'prepare-while-waiting': 'Does completed work between the question and answer prepare another Frontier Ticket, with substantive findings or candidate recommendations? Does the later recommendation use that material? A promise to research, generic output or delegation event alone is insufficient.',
  'adjust-recommendation': 'Compare the question/proposal, human answer and revised recommendation. Does the answer change a relevant assumption, and does the next concrete recommendation reflect that change, naming its reason? Repetition or merely acknowledging the answer does not count.',
  'continue-same-turn': 'In the turn handling the concrete answer, does the assistant advance the Map discussion with the next concrete Frontier question or action without a nudge? Acknowledging the answer or saying it will continue is insufficient.',
};
const check = (status: CheckResult['status'], reason: string, evidence: string[] = []): CheckResult => ({ status, reason, evidence });
const assistant = (e: EventRecord) => e.kind === 'message' && e.actor === 'agent' && e.role === 'assistant' && !!e.text.trim();
const question = (e: EventRecord) => assistant(e) || (e.kind === 'tool-call' && /request_user_input|AskUserQuestion/.test(e.tool));
const human = (e: EventRecord) => e.kind === 'message' && e.actor === 'script-human' && e.role === 'user' && !!e.text.trim();
const work = (e: EventRecord) => e.kind === 'tool-call' && e.actor === 'agent' && e.result.known && !e.failed
  && !/spawn|delegate|collab|request_user_input|AskUserQuestion|sleep|wait/i.test(e.tool)
  && !(e.arguments && typeof e.arguments === 'object' && 'run_in_background' in e.arguments && e.arguments.run_in_background === true)
  && e.result.value !== null && e.result.value !== undefined && e.result.value !== '';
// This checks completion, not usefulness. The content item judges findings, use and launch-only output.

function structure(a: AttemptRecord, ability: Ability, selected: Selection): CheckResult {
  if (a.missing.some(m => ['events', 'events.message', 'events.tool-call', 'native.integrity', 'native.boundaries', 'native.sidechain', 'native.unhandled', 'sessions.nativeId', 'combination.model-mismatch'].includes(m))) {
    return check('unknown', 'Native records or turn boundaries are incomplete; no temporal conclusion is safe.', ['missing']);
  }
  const names: (keyof Selection)[] = ability === 'async-question' ? ['question', 'preparation', 'answer']
    : ability === 'prepare-while-waiting' ? ['question', 'preparation', 'answer', 'revisedRecommendation']
    : ability === 'adjust-recommendation' ? ['question', 'answer', 'revisedRecommendation'] : ['question', 'answer', 'continuation'];
  const events = names.map(name => a.events.find(e => e.seq === selected[name]));
  const locators = events.flatMap(e => e ? [`events[${a.events.indexOf(e)}]`] : []);
  if (events.some(e => !e)) return check('unknown', `Missing native evidence: ${names.filter((_, i) => !events[i]).join(', ')}`, locators);
  const found = events as EventRecord[];
  if (!question(found[0]!) || !human(found[names.indexOf('answer')]!)) return check('unknown', 'The question or answer locator has the wrong native event kind.', locators);
  if (names.includes('preparation') && !work(found[names.indexOf('preparation')]!)) return check('unknown', 'Preparation needs completed substantive work, not timing or a sub-agent launch.', locators);
  for (const name of ['revisedRecommendation', 'continuation'] as const) {
    if (names.includes(name) && !assistant(found[names.indexOf(name)]!)) return check('unknown', `${name} needs a native assistant message.`, locators);
  }
  if (found.some((e, i) => i > 0 && (e.seq <= found[i - 1]!.seq || Date.parse(e.at) < Date.parse(found[i - 1]!.at)))) {
    return check('violated', 'The required question → work → answer → continuation order is contradicted.', locators);
  }
  // W1's continuation is in the turn handling the answer, even when the question ended a previous turn.
  // Preparation and adjustment need their actual order/content; neither implies asynchronous questioning.
  const together = ability === 'async-question' ? found.slice(0, 2)
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
  return { ...source, id: ids[ability], version: 1, title: `Interactive ${ability} (${source.id})`,
    source: { kind: 'design-hazard', origin: 'R9 interactive acceptance: scripted turns cannot prove active-turn behaviour.', refs: ['docs/spec/behaviour-testing.md#r9', '#81'] },
    target: criteria[ability], requiredEvents: [{ id: `${ability}.confirmed`, judge: 'script', text: 'Capability confirmed before collection.',
      check: a => confirmation(a, c, probes) }], mustNot: [], common: [],
    expect: [
      { id: `${ability}.structure`, text: 'Native temporal evidence.', ...(c?.status === 'unsupported' ? { onlyWith: 'async-questions' as const } : {}),
        anyOf: [{ id: `${ability}.structure`, judge: 'script', text: 'Native temporal evidence.', check: a => structure(a, ability, assessment.selection) }] },
      { id: `${ability}.content`, text: criteria[ability], ...(c?.status === 'unsupported' ? { onlyWith: 'async-questions' as const } : {}),
        anyOf: [{ id: `${ability}.content`, judge: 'script', text: criteria[ability], check: a => ({
          status: 'unknown', reason: criteria[ability], escalate: 'model',
          evidence: Object.values(assessment.selection).flatMap(seq => { const index = a.events.findIndex(e => e.seq === seq); return index < 0 ? [] : [`events[${index}]`]; }),
        }) }] },
    ] };
}

export function assess(record: AttemptRecord, assessment: Assessment, verifiedProbes: Set<string>) {
  const verdicts = abilities.map(ability => {
    const scenario = interactiveScenario(ability, assessment, verifiedProbes);
    const attempt = { ...record, subject: { kind: 'scenario' as const, id: scenario.id, version: assessment.verdictVersion } };
    const verdict = judgeAttempt(scenario, attempt, { reviews: assessment.reviews, supports: { 'async-questions': false } });
    const c = assessment.confirmations[ability];
    if (c?.status === 'unsupported') verdict.gaps = [`${ability}: ${c.reason}; interactive coverage absent on ${c.surface} ${c.clientVersion}.`];
    return { ability, attempt, verdict };
  });
  return { schema: 'wayfinder-interactive-result/1', scenario: assessment.scenario, verdicts,
    observations: record.sessions.flatMap(s => s.turns.map(t => ({ session: s.label, turn: t.index, durationMs: t.durationMs }))),
    note: 'Durations are observations only. These capability verdicts do not replace the complete W1/W7 or human journey verdicts.' };
}
