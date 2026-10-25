// Verdicts (spec R4): one Attempt against its Scenario, then the Attempts of one cell together. Run completeness and
// the behaviour verdict stay separate, and nothing missing or unreviewed ever reads as a pass.
import { common } from './common.ts';
import type { AttemptRecord, Completeness } from './evidence.ts';
import type { Capability, CheckResult, Item, Scenario } from './scenario.ts';

export const outcomes = ['pass', 'fail', 'flaky', 'incomplete', 'insufficient-evidence', 'not-applicable'] as const;
export type Outcome = typeof outcomes[number];

/** A model or human judgement of one item, supplied by review (B03b) or by Kun. */
export interface Review { itemId: string; status: 'holds' | 'violated' | 'undecided'; reason: string; by: string }

export interface ItemResult {
  id: string;
  judge: Item['judge'];
  /** `pending-review` until a review decides a model or human item; `paused` items always go to the human. */
  status: CheckResult['status'] | 'pending-review' | 'paused';
  reason: string;
  evidence: string[];
}
export interface GroupResult { id: string; status: ItemResult['status'] | 'not-applicable'; items: ItemResult[] }

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
  /** Raw files of the Attempt, relative to the private run root. */
  raw: string | null;
}

function judgeItem(item: Item, record: AttemptRecord, reviews: Review[]): ItemResult {
  const base = { id: item.id, judge: item.judge };
  if (item.paused) return { ...base, status: 'paused', reason: item.paused, evidence: [] };
  if (item.judge === 'script') {
    const r = item.check(record);
    // A script that cannot decide hands the item to review; a review then decides it.
    const review = r.status === 'unknown' ? reviews.find(x => x.itemId === item.id) : undefined;
    if (review && review.status !== 'undecided') return { ...base, status: review.status, reason: `${review.by}: ${review.reason}`, evidence: r.evidence };
    return { ...base, status: r.status === 'unknown' && r.escalate === 'model' ? 'pending-review' : r.status, reason: r.reason, evidence: r.evidence };
  }
  const review = reviews.find(x => x.itemId === item.id);
  if (!review || review.status === 'undecided') return { ...base, status: 'pending-review', reason: review ? `${review.by}: ${review.reason}` : 'awaiting review', evidence: [] };
  return { ...base, status: review.status, reason: `${review.by}: ${review.reason}`, evidence: [] };
}

/** A group holds when one way holds, fails when every way is refuted, and is otherwise open. */
function groupStatus(items: ItemResult[]): ItemResult['status'] {
  if (items.some(i => i.status === 'holds')) return 'holds';
  if (items.every(i => i.status === 'violated')) return 'violated';
  if (items.some(i => i.status === 'pending-review' || i.status === 'paused')) return 'pending-review';
  return 'unknown';
}

const open = (s: string) => s === 'unknown' || s === 'pending-review' || s === 'paused';

/**
 * One Attempt. A confirmed must-not fails it whatever else is missing; an unfinished run is incomplete; a required
 * event that did not happen means the Scenario was not exercised; anything still open is insufficient evidence.
 */
export function judgeAttempt(s: Scenario, record: AttemptRecord | null, opts: { reviews?: Review[]; supports?: Partial<Record<Capability, boolean | 'unverified'>>; attemptId?: string } = {}): AttemptVerdict {
  const reviews = opts.reviews ?? [];
  const base = { attemptId: record?.attemptId ?? opts.attemptId ?? 'unknown', scenario: { id: s.id, version: s.version }, raw: record?.raw.path ?? null };
  if (!record) return { ...base, completeness: 'no-record', outcome: 'incomplete', reasons: ['no Attempt record'], required: [], mustNot: [], expect: [], quality: [] };
  const commonItems = s.common.map(c => common[c]);
  const required = s.requiredEvents.map(i => judgeItem(i, record, reviews));
  const mustNot = [...s.mustNot, ...commonItems.filter(i => !i.quality)].map(i => judgeItem(i, record, reviews));
  const quality = commonItems.filter(i => i.quality).map(i => judgeItem(i, record, reviews));
  const expect: GroupResult[] = s.expect.map(g => {
    const items = g.anyOf.map(i => judgeItem(i, record, reviews));
    const applicable = !g.onlyWith || opts.supports?.[g.onlyWith] === true;
    return { id: g.id, status: applicable ? groupStatus(items) : 'not-applicable', items };
  });
  const reasons: string[] = [];
  const violations = mustNot.filter(i => i.status === 'violated');
  let outcome: AttemptVerdict['outcome'];
  if (violations.length) { outcome = 'fail'; reasons.push(...violations.map(i => `must-not ${i.id}: ${i.reason}`)); if (record.run.completeness !== 'complete') reasons.push(`run ${record.run.completeness}`); }
  else if (record.run.completeness !== 'complete') { outcome = 'incomplete'; reasons.push(`run ${record.run.completeness}${record.run.detail ? `: ${record.run.detail}` : ''}`); }
  else if (required.some(i => i.status === 'violated')) { outcome = 'incomplete'; reasons.push(...required.filter(i => i.status === 'violated').map(i => `required event ${i.id} did not happen`)); }
  else if (required.some(i => open(i.status))) { outcome = 'insufficient-evidence'; reasons.push(...required.filter(i => open(i.status)).map(i => `required event ${i.id} not proven`)); }
  else if (expect.some(g => g.status === 'violated')) { outcome = 'fail'; reasons.push(...expect.filter(g => g.status === 'violated').map(g => `expectation ${g.id} not met`)); }
  else if ([...mustNot, ...expect].some(x => open(x.status))) { outcome = 'insufficient-evidence'; reasons.push(...[...mustNot, ...expect].filter(x => open(x.status)).map(x => `${x.id} open`)); }
  else if (expect.every(g => g.status === 'not-applicable')) { outcome = 'not-applicable'; reasons.push('no expectation applies to this client'); }
  else outcome = 'pass';
  return { ...base, completeness: record.run.completeness, outcome, reasons, required, mustNot, expect, quality };
}

export interface CellVerdict {
  outcome: Outcome;
  attempts: AttemptVerdict[];
  /** Real problems only: whether any Attempt failed, the reproduction status of R6. Not reproducing is never "fixed". */
  reproduction: 'reproduced' | 'not-reproduced-yet' | null;
  reasons: string[];
}

/**
 * The Attempts of one cell (Scenario × Entry × Combination × release). Every Attempt counts: a pass never hides a
 * failure, mixed pass and fail is flaky, and fewer Attempts than required is incomplete.
 */
export function judgeCell(s: Scenario, attempts: AttemptVerdict[], required: number): CellVerdict {
  const count = (o: Outcome) => attempts.filter(a => a.outcome === o).length;
  const reasons: string[] = [];
  let outcome: Outcome;
  if (count('fail') && count('pass')) outcome = 'flaky';
  else if (count('fail')) outcome = 'fail';
  else if (count('incomplete') || attempts.length < required) { outcome = 'incomplete'; if (attempts.length < required) reasons.push(`${attempts.length} of ${required} Attempts`); }
  else if (count('insufficient-evidence')) outcome = 'insufficient-evidence';
  else if (attempts.length && count('not-applicable') === attempts.length) outcome = 'not-applicable';
  else outcome = 'pass';
  const reproduction = s.source.kind !== 'real-problem' ? null : count('fail') ? 'reproduced' : 'not-reproduced-yet';
  return { outcome, attempts, reproduction, reasons };
}
