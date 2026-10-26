// Evidence validation and one cross-round decision rule shared by the review runner and the report.
import { createHash } from 'node:crypto';
import { agentRevisions } from './checks.ts';
import type { AttemptRecord, EventRecord } from './evidence.ts';
import type { Review } from './review-types.ts';
export type { Review, ReviewSummary } from './review-types.ts';

export function evidenceHash(record: AttemptRecord): string {
  const { modelReviews: _, ...evidence } = record;
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export function evidenceLocations(a: AttemptRecord): string[] {
  return [...a.events.flatMap((e, i) => e.actor !== 'controller' ? [`events[${i}]`] : []),
    ...a.sessions.flatMap((s, i) => s.turns.map((_, j) => `sessions[${i}].turns[${j}]`)),
    ...a.maps.flatMap((m, i) => m.history.map((_, j) => `maps[${i}].history[${j}]`)),
    ...a.receipts.flatMap((r, i) => r.outcome.kind === 'unknown' ? [] : [`receipts[${i}]`])];
}

/** Unknown markers fail closed. Only measured metadata is irrelevant to every behavioural item.
 * status-narration needs conversation and supplied rules (to identify quotations), but not Map/action results.
 * All other model items (script escalations included) need the complete rule and action trace.
 */
export function missingForReview(itemId: string, a: AttemptRecord): string[] {
  const quality = itemId === 'status-narration';
  const metadata = /^(usage(?:\.|$)|client\.(version|surface)$|combination\.effort$)/;
  const irrelevantToQuality = /^(maps(?:\[|\.|$)|receipts(?:\[|\.|$)|events\.(tool-call|resource-read|file-read|file-change|command|delegation)(?:\.|$))/;
  const missing = a.missing.filter(p => {
    const instructions = /^given\[(\d+)\]\.instructions$/.exec(p);
    const toolsOnly = instructions && a.given[Number(instructions[1])]?.compatibilityMode === 'toolsOnly';
    return !metadata.test(p) && !toolsOnly && !(quality && irrelevantToQuality.test(p));
  });
  if (!a.given.length) missing.push('given');
  a.given.forEach((g, i) => {
    if (g.compatibilityMode === 'instructions' && !g.instructions.known) missing.push(`given[${i}].instructions`);
    if (!g.toolDescriptions.known) missing.push(`given[${i}].toolDescriptions`);
  });
  if (!quality) {
    if (a.receipts.some(r => r.outcome.kind === 'unknown') || agentRevisions(a).some(r => r.session === null)) missing.push('receipts');
    if (a.events.some(e => e.kind === 'tool-call' && !e.result.known)) missing.push('events.tool-call.result');
    if (a.events.some(e => e.kind === 'command' && e.exitCode === null)) missing.push('events.command.exitCode');
  }
  return [...new Set(missing)];
}

function finalMessage(a: AttemptRecord, e: EventRecord): boolean {
  return e.kind === 'message' && e.role === 'assistant' && !a.events.some(later => later.seq > e.seq
    && later.session === e.session && later.turn === e.turn && later.kind === 'message' && later.role === 'assistant');
}

/** A non-final concrete source. Turns contain user inputs, not independent evidence of an agent action.
 * Receipts and revisions need the matching recorded call, so an unrelated/dangling receipt cannot pad a reply.
 */
function concreteSource(location: string, a: AttemptRecord): unknown | null {
  const event = /^events\[(\d+)\]$/.exec(location);
  if (event) { const e = a.events[Number(event[1])]; return e?.actor === 'agent' && !(e.kind === 'message' && e.role === 'user') && !finalMessage(a, e) ? e : null; }
  const receipt = /^receipts\[(\d+)\]$/.exec(location);
  if (receipt) {
    const r = a.receipts[Number(receipt[1])];
    return r && r.outcome.kind !== 'unknown' && a.events.some(e => e.actor === 'agent' && e.kind === 'tool-call'
      && e.callId === r.callId && e.session === r.session && e.turn === r.turn && e.result.known) ? r : null;
  }
  const revision = /^maps\[(\d+)\]\.history\[(\d+)\]$/.exec(location);
  if (revision) {
    const r = a.maps[Number(revision[1])]?.history[Number(revision[2])];
    return r && a.receipts.some((receipt, i) => receipt.mapId === r.mapId && receipt.outcome.kind === 'committed'
      && receipt.outcome.revision === r.revision && concreteSource(`receipts[${i}]`, a)) ? r : null;
  }
  return null;
}

export function reviewProblem(r: Review, a: AttemptRecord): string | null {
  if (r.rejected) return r.rejected;
  if (!r.reason?.trim()) return 'review has no reason';
  if (r.role === 'human') return null;
  if (!r.readingId?.trim()) return 'review has no native reading ID';
  if (r.status === 'undecided') return null;
  const locations = new Set(evidenceLocations(a));
  if (!r.evidence?.length || r.evidence.some(x => !locations.has(x))) return 'review lacks valid evidence locations';
  const supported = r.support?.some(s => {
    if (!r.evidence!.includes(s.location) || !s.quote?.trim() || !s.explanation?.trim()) return false;
    const source = concreteSource(s.location, a);
    return source !== null && JSON.stringify(source).includes(s.quote);
  });
  if (!supported) return 'review needs quoted, item-relevant evidence beyond the final reply (a concrete event, matched receipt or revision)';
  const missing = r.status === 'holds' ? missingForReview(r.itemId, a) : [];
  return missing.length ? `missing required evidence: ${missing.join(', ')}` : null;
}

export type ReviewDecision = { status: 'holds' | 'violated'; reason: string; evidence: string[] }
  | { open: string; next: 'review' | 'arbitration' | 'human'; evidence: string[] };
/** Raw diagnostics remain private; reportable explanations do not include local paths. */
export const reportReason = (text: string) => text.replace(/(?:~\/|\/(?:Users|home|private|tmp|var|Volumes)\/)[^\n"'<>]*/g, '<private-path>');
const said = (r: Review) => `${r.by}: ${reportReason(r.reason)}`;

/** No round can vote away an earlier claim or an undecided arbitration. Only valid independent readings count. */
export function decideReviews(itemId: string, reviews: Review[], a: AttemptRecord, modelMayDecide = true): ReviewDecision {
  const mine = reviews.filter(r => r.itemId === itemId);
  const human = mine.findLast(r => r.role === 'human' && r.status !== 'undecided' && !reviewProblem(r, a));
  const decision = (r: Review): ReviewDecision => ({ status: r.status as 'holds' | 'violated', reason: said(r), evidence: r.evidence ?? [] });
  if (human) return decision(human);
  const evidence = [...new Set(mine.flatMap(r => r.evidence ?? []))];
  const open = (message: string, next: 'review' | 'arbitration' | 'human'): ReviewDecision => ({ open: message, next, evidence });
  if (!modelMayDecide) return open('evidence is missing; only the human can decide', 'human');
  const claims = mine.filter(r => r.role === 'review');
  // The first native reading owns its identity; a replay cannot add a vote or invalidate an earlier violation.
  const first = (r: Review) => mine.find(x => x.role !== 'human' && x.readingId === r.readingId) === r;
  const readings = claims.filter(r => first(r) && !reviewProblem(r, a));
  const arbitrations = mine.filter(r => r.role === 'arbitration' && first(r) && !reviewProblem(r, a));
  const basis = (r: Review) => r.basedOn ?? claims.filter(x => x.roundId === r.roundId).flatMap(x => x.readingId ? [x.readingId] : []);
  const backed = arbitrations.filter(r => readings.filter(x => basis(r).includes(x.readingId!)).length >= 2);
  const confirmedViolation = backed.find(r => r.status === 'violated');
  if (confirmedViolation) return decision(confirmedViolation);
  // Two valid violation readings in one earlier round are an already confirmed failure.
  const failedPair = readings.find(r => r.status === 'violated' && readings.filter(x => x.status === 'violated' && x.roundId === r.roundId).length >= 2);
  if (failedPair) return { status: 'violated', reason: 'two independent reviews confirm a violation', evidence };
  if (backed.some(r => r.status === 'undecided')) return open('arbitration undecided; human verdict required', 'human');
  if (readings.length < 2) return open(`${readings.length} valid independent readings; two required (rejected outputs${claims.some(r => r.status === 'violated' && reviewProblem(r, a)) ? ', including violation claims,' : ''} are retained, not counted)`, 'review');
  const disputed = readings.some(r => r.status !== readings[0]!.status || r.status === 'undecided')
    || claims.some(r => r.status === 'violated') && readings.some(r => r.status === 'holds');
  if (disputed) {
    // A legacy per-round arbitration cannot settle a claim from another round that it never considered.
    const arbitration = backed.findLast(r => claims.every(x => x.readingId && basis(r).includes(x.readingId)));
    if (arbitration) return decision(arbitration);
    return open('review claims disagree across the evidence history; arbitration must consider every claim', 'arbitration');
  }
  return { status: readings[0]!.status as 'holds' | 'violated', reason: `independent reviews agree: ${readings.map(said).join(' | ')}`, evidence };
}

export function savedReviews(a: AttemptRecord): Review[] {
  return (a.modelReviews ?? []).filter(x => x.schema === 'wayfinder-model-review/1' && x.evidenceHash === evidenceHash(a)).flatMap(x => x.reviews);
}
