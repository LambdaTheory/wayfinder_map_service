// Verdicts (spec R4): one Attempt against its Scenario, then the Attempts of one cell together. Run completeness and
// the behaviour verdict stay separate, and nothing missing, unreviewed or disputed ever reads as a pass.
import { common } from './common.ts';
import type { AttemptRecord, Completeness } from './evidence.ts';
import type { Capability, CheckResult, Item, Scenario } from './scenario.ts';
import { evidenceHash, reviewProblem, savedReviews } from './reviews.ts';
import type { Review } from './reviews.ts';
export type { Review } from './reviews.ts';

export const outcomes = ['pass', 'fail', 'flaky', 'incomplete', 'insufficient-evidence', 'not-applicable'] as const;
export type Outcome = typeof outcomes[number];

type Open = 'unknown' | 'pending-review' | 'paused';
export interface ItemResult { id: string; judge: Item['judge']; status: CheckResult['status'] | Exclude<Open, 'unknown'>; reason: string; evidence: string[] }
export interface GroupResult { id: string; status: ItemResult['status'] | 'not-applicable'; items: ItemResult[]; gap?: string }

export interface AttemptVerdict {
  attemptId: string;
  scenario: { id: string; version: number };
  completeness: Completeness | 'no-record';
  outcome: Exclude<Outcome, 'flaky'>;
  reasons: string[];
  required: ItemResult[];
  mustNot: ItemResult[];
  expect: GroupResult[];
  quality: ItemResult[];
  /** Coverage gaps: expectation groups that could not apply to this client. */
  gaps: string[];
  /** Raw files of the Attempt, relative to the private run root. */
  raw: string | null;
  modelReviews?: { path: string; pending: { itemId: string; reason: string; next: 'human' | 'retry' }[] }[];
}

const isOpen = (s: GroupResult['status']): s is Open => s === 'unknown' || s === 'pending-review' || s === 'paused';
const said = (r: Review) => `${r.by}: ${r.reason}`;

function decide(itemId: string, reviews: Review[], modelMayDecide: boolean): { status: 'holds' | 'violated'; reason: string; evidence: string[] } | { open: string } {
  const mine = reviews.filter(r => r.itemId === itemId && r.status !== 'undecided');
  const human = mine.findLast(r => r.role === 'human');
  if (human) return { status: human.status as 'holds' | 'violated', reason: said(human), evidence: human.evidence ?? [] };
  if (!modelMayDecide) return { open: 'evidence is missing; only the human can decide' };
  const readings = reviews.filter(r => r.itemId === itemId && r.role === 'review');
  if (readings.length < 2) return { open: readings.length ? 'one review so far; two independent reviews are required' : 'awaiting review' };
  if (new Set(readings.map(r => r.readingId)).size !== readings.length) return { open: 'duplicate reading; two independent reviews are required' };
  const arbitration = reviews.findLast(r => r.itemId === itemId && r.role === 'arbitration');
  if (arbitration && readings.some(r => r.readingId === arbitration.readingId)) return { open: 'arbitration reused a review reading' };
  if (arbitration?.status === 'undecided') return { open: `arbitration undecided; human verdict required: ${said(arbitration)}` };
  if (arbitration) return { status: arbitration.status as 'holds' | 'violated', reason: said(arbitration), evidence: arbitration.evidence ?? [] };
  const agreed = readings.every(r => r.status !== 'undecided' && r.status === readings[0]!.status);
  return agreed ? { status: readings[0]!.status as 'holds' | 'violated', reason: `two reviews agree: ${readings.map(said).join(' | ')}`, evidence: [...new Set(readings.flatMap(r => r.evidence ?? []))] }
    : { open: 'the reviews disagree; arbitration pending' };
}

function judgeItem(item: Item, record: AttemptRecord, reviews: Review[]): ItemResult {
  const base = { id: item.id, judge: item.judge };
  if (item.paused) return { ...base, status: 'paused', reason: item.paused, evidence: [] };
  const script = item.judge === 'script' ? item.check(record) : null;
  if (script && script.status !== 'unknown') return { ...base, status: script.status, reason: script.reason, evidence: script.evidence };
  // A script that could not decide escalates to the model chain only when it said so; missing evidence goes to the human.
  const modelMayDecide = item.judge === 'model' || script?.escalate === 'model';
  const mine = reviews.filter(r => r.itemId === item.id).map(r => {
    const problem = reviewProblem(r, record);
    return problem ? { ...r, status: 'undecided' as const, reason: problem } : r;
  });
  const human = mine.filter(r => r.role === 'human');
  const rounds = [...new Set(mine.filter(r => r.role !== 'human').map(r => r.roundId ?? 'manual'))];
  const decisions = (rounds.length ? rounds : ['manual']).map(round => decide(item.id,
    [...mine.filter(r => r.role !== 'human' && (r.roundId ?? 'manual') === round), ...human], modelMayDecide));
  // A later review round cannot erase an already observed violation. A human can resolve it explicitly.
  const d = decisions.find(x => 'status' in x && x.status === 'violated') ?? decisions.find(x => 'status' in x) ?? decisions.at(-1)!;
  if ('status' in d) return { ...base, status: d.status, reason: d.reason, evidence: [...new Set([...(script?.evidence ?? []), ...d.evidence])] };
  return { ...base, status: modelMayDecide ? 'pending-review' : 'unknown', reason: script ? `${script.reason}; ${d.open}` : d.open, evidence: script?.evidence ?? [] };
}

/** A group holds when one way holds, fails when every way is refuted, and is otherwise open. */
function groupStatus(items: ItemResult[]): ItemResult['status'] {
  if (items.some(i => i.status === 'holds')) return 'holds';
  if (items.every(i => i.status === 'violated')) return 'violated';
  return items.some(i => i.status === 'pending-review' || i.status === 'paused') ? 'pending-review' : 'unknown';
}

export interface JudgeOptions {
  reviews?: Review[];
  /** The client's capabilities; a group for a capability not proven true is not applicable and reported as a gap. */
  supports?: Partial<Record<Capability, boolean | 'unverified'>>;
  attemptId?: string;
  /** The Batch's outcome line, shown when there is no record. */
  outcome?: { completeness: string; detail?: string };
}

/**
 * One Attempt. A confirmed must-not fails it whatever else is missing; an unfinished run is incomplete; a required
 * event that did not happen means the Scenario was not exercised; anything still open is insufficient evidence.
 */
export function judgeAttempt(s: Scenario, record: AttemptRecord | null, opts: JudgeOptions = {}): AttemptVerdict {
  const reviews = [...(record ? savedReviews(record) : []), ...(opts.reviews ?? [])];
  const empty = { required: [], mustNot: [], expect: [], quality: [], gaps: [] };
  const base = { attemptId: record?.attemptId ?? opts.attemptId ?? 'unknown', scenario: { id: s.id, version: record?.subject.version ?? s.version }, raw: record?.raw.path ?? null };
  if (!record) return { ...base, ...empty, completeness: 'no-record', outcome: 'incomplete',
    reasons: [`no Attempt record${opts.outcome ? ` (${opts.outcome.completeness}${opts.outcome.detail ? `: ${opts.outcome.detail}` : ''})` : ''}`] };
  // Its own items judged it when it ran; today's definition may differ, so an old record is never re-judged by it.
  if (record.subject.version !== s.version) return { ...base, ...empty, completeness: record.run.completeness, outcome: 'insufficient-evidence',
    reasons: [`recorded under ${s.id} v${record.subject.version}; the current definition is v${s.version}, so it is not re-judged`] };
  const commonItems = s.common.map(c => common[c]);
  const required = s.requiredEvents.map(i => judgeItem(i, record, reviews));
  const mustNot = [...s.mustNot, ...commonItems.filter(i => !i.quality)].map(i => judgeItem(i, record, reviews));
  const quality = commonItems.filter(i => i.quality).map(i => judgeItem(i, record, reviews));
  const expect: GroupResult[] = s.expect.map(g => {
    const items = g.anyOf.map(i => judgeItem(i, record, reviews));
    const support = g.onlyWith ? opts.supports?.[g.onlyWith] : true;
    if (support === true) return { id: g.id, status: groupStatus(items), items };
    return { id: g.id, status: 'not-applicable', items, gap: `${g.id} needs ${g.onlyWith}, ${support === false ? 'which this client lacks' : 'not yet proven for this client'}` };
  });
  const reasons: string[] = [];
  const listOpen = (xs: { id: string; status: GroupResult['status'] }[], what: string) => xs.filter(x => isOpen(x.status)).map(x => `${what} ${x.id} open`);
  const violations = mustNot.filter(i => i.status === 'violated');
  let outcome: AttemptVerdict['outcome'];
  if (violations.length) {
    outcome = 'fail';
    reasons.push(...violations.map(i => `must-not ${i.id}: ${i.reason}`));
    if (record.run.completeness !== 'complete') reasons.push(`run ${record.run.completeness}`);
  } else if (record.run.completeness !== 'complete') { outcome = 'incomplete'; reasons.push(`run ${record.run.completeness}${record.run.detail ? `: ${record.run.detail}` : ''}`); }
  else if (required.some(i => i.status === 'violated')) { outcome = 'incomplete'; reasons.push(...required.filter(i => i.status === 'violated').map(i => `required event ${i.id} did not happen`)); }
  else if (required.some(i => isOpen(i.status))) { outcome = 'insufficient-evidence'; reasons.push(...listOpen(required, 'required event')); }
  else if (expect.some(g => g.status === 'violated')) { outcome = 'fail'; reasons.push(...expect.filter(g => g.status === 'violated').map(g => `expectation ${g.id} not met`)); }
  else if ([...mustNot, ...expect].some(x => isOpen(x.status))) { outcome = 'insufficient-evidence'; reasons.push(...listOpen(mustNot, 'must-not'), ...listOpen(expect, 'expectation')); }
  else if (expect.every(g => g.status === 'not-applicable')) { outcome = 'not-applicable'; reasons.push('no expectation applies to this client'); }
  else outcome = 'pass';
  return { ...base, completeness: record.run.completeness, outcome, reasons, required, mustNot, expect, quality, gaps: expect.flatMap(g => g.gap ? [g.gap] : []),
    modelReviews: (record.modelReviews ?? []).map(r => ({ path: r.path, pending: r.evidenceHash === evidenceHash(record) ? r.pending
      : [{ itemId: '*', reason: 'evidence changed; saved reviews do not apply', next: 'retry' }] })) };
}

export type Counts = Record<Exclude<Outcome, 'flaky'>, number>;
export interface CellVerdict {
  outcome: Outcome;
  attempts: AttemptVerdict[];
  counts: Counts;
  /** Real problems on their original Combination only: whether any Attempt failed (R6). Not reproducing is never "fixed". */
  reproduction: 'reproduced' | 'not-reproduced-yet' | null;
  reasons: string[];
}

/**
 * The Attempts of one cell. Every Attempt counts: a pass never hides a failure, mixed pass and fail is flaky, and an
 * undecided Attempt blocks a pass. A cell needs `required` decided Attempts; one cut short by a rate limit and run
 * again does not block it.
 */
export function judgeCell(s: Scenario, attempts: AttemptVerdict[], required: number, combination = ''): CellVerdict {
  const counts = Object.fromEntries((['pass', 'fail', 'incomplete', 'insufficient-evidence', 'not-applicable'] as const)
    .map(o => [o, attempts.filter(a => a.outcome === o).length])) as Counts;
  const decided = counts.pass + counts.fail;
  const reasons: string[] = [];
  let outcome: Outcome;
  if (counts.fail && counts.pass) outcome = 'flaky';
  else if (counts.fail) outcome = 'fail';
  else if (attempts.length && counts['not-applicable'] === attempts.length) outcome = 'not-applicable';
  // An undecided Attempt might still turn out a failure, so it blocks a pass; an unfinished one can be run again.
  else if (counts['insufficient-evidence']) outcome = 'insufficient-evidence';
  else if (decided < required) { outcome = 'incomplete'; reasons.push(`${decided} of ${required} decided Attempts`); }
  else outcome = 'pass';
  const original = s.source.originalCombination;
  const reproduction = s.source.kind !== 'real-problem' || (original && !combination.startsWith(original)) ? null
    : counts.fail ? 'reproduced' : 'not-reproduced-yet';
  return { outcome, attempts, counts, reproduction, reasons };
}
