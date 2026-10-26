// Persisted model readings and their evidence boundary. This module never starts a client.
import { createHash } from 'node:crypto';
import { agentRevisions } from './checks.ts';
import { missingMarkers } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';

export interface Review {
  itemId: string;
  status: 'holds' | 'violated' | 'undecided';
  reason: string;
  by: string;
  role: 'review' | 'arbitration' | 'human';
  /** Native response/session ID, not the model name or a locally assigned request ID. */
  readingId?: string;
  /** Separate review rounds never borrow one another's arbitration. */
  roundId?: string;
  evidence?: string[];
}

export interface ReviewSummary {
  schema: 'wayfinder-model-review/1';
  roundId: string;
  evidenceHash: string;
  /** Relative to the Attempt directory; inputs and raw outputs live alongside this result. */
  path: string;
  reviews: Review[];
  pending: { itemId: string; reason: string; next: 'human' | 'retry' }[];
}

/** Bind reviews to all original record fields, including any Driver-specific evidence. */
export function evidenceHash(record: AttemptRecord): string {
  const { modelReviews: _, ...evidence } = record;
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

/** Enumerated locators prevent invented turns, arbitrary paths and missing results from becoming evidence. */
export function evidenceLocations(a: AttemptRecord): string[] {
  return [
    ...a.events.flatMap((e, i) => e.actor === 'agent' || e.actor === 'script-human' ? [`events[${i}]`] : []),
    ...a.sessions.flatMap((s, i) => s.turns.map((_, j) => `sessions[${i}].turns[${j}]`)),
    ...a.maps.flatMap((m, i) => m.history.map((_, j) => `maps[${i}].history[${j}]`)),
    ...a.receipts.flatMap((r, i) => r.outcome.kind === 'unknown' ? [] : [`receipts[${i}]`]),
  ];
}

export function reviewProblem(r: Review, a: AttemptRecord): string | null {
  if (!r.reason?.trim()) return 'review has no reason';
  if (r.role === 'human' || r.status === 'undecided') return null;
  if (!r.readingId?.trim()) return 'review has no native reading ID';
  const locations = new Set(evidenceLocations(a));
  if (!r.evidence?.length || r.evidence.some(x => !locations.has(x))) return 'review lacks valid evidence locations';
  // A concrete turn/event must anchor each decision, even when it also cites persisted Map state.
  if (!r.evidence.some(x => x.startsWith('events[') || x.startsWith('sessions['))) return 'review lacks an event or turn';
  const citesAgent = r.evidence.some(x => {
    const event = /^events\[(\d+)\]$/.exec(x);
    if (event) return a.events[Number(event[1])]?.actor === 'agent';
    const turn = /^sessions\[(\d+)\]\.turns\[(\d+)\]$/.exec(x);
    if (!turn) return false;
    const session = a.sessions[Number(turn[1])]; const index = session?.turns[Number(turn[2])]?.index;
    return a.events.some(e => e.actor === 'agent' && e.session === session?.label && e.turn === index);
  });
  if (!citesAgent) return 'review does not cite recorded agent activity';
  const assistantEvents = a.events.flatMap((e, i) => e.kind === 'message' && e.role === 'assistant' && e.actor === 'agent' ? [i] : []);
  if (assistantEvents.length > 1 && r.evidence.every(x => x === `events[${assistantEvents.at(-1)}]`)) return 'review cites only the final reply';
  if (r.status === 'holds' && (a.missing.some(x => (missingMarkers as readonly string[]).includes(x))
    || a.receipts.some(x => x.outcome.kind === 'unknown')
    || a.events.some(x => x.kind === 'tool-call' && !x.result.known)
    || agentRevisions(a).some(x => x.session === null))) return 'missing evidence cannot be cleared by a model';
  return null;
}

export function savedReviews(a: AttemptRecord): Review[] {
  return (a.modelReviews ?? []).filter(x => x.schema === 'wayfinder-model-review/1' && x.evidenceHash === evidenceHash(a)).flatMap(x => x.reviews);
}
