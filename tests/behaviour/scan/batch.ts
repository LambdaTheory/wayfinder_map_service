// Quota accounting only. This module cannot launch a model; the scan CLI never accepts approval or runs work.
import { digest } from './read.ts';
import type { ScanReport } from './analyze.ts';
import { reviewCalls } from '../review-plan.ts';
import type { ReviewCall } from '../review-plan.ts';
import type { reviewPlan } from '../review-run.ts';

export interface Work {
  id: string; kind: 'availability' | 'reading' | 'reproduction' | 'regression' | 'arbitration';
  combination: { harness: string; model: string; effort: string; entry: string };
  scope: string[]; repetitions: number; extraReviews: number;
  /** Bind readings to exactly the evidence the approver saw. */
  evidenceHash: string; prerequisites: string[];
}
export interface BatchPlan {
  schema: 'wayfinder-scan-batch/1'; id: string; work: Work[]; ceiling: number;
  /** Present only after explicit B01 evidence binding; the scan proposal itself is not executable. */
  reviewRuns?: { leadId: string; scanEvidenceHash: string; plan: ReturnType<typeof reviewPlan>[number]; retry: boolean }[];
}
export interface Approval { planHash: string; reference: string; by: string }
export interface Reservation { id: string; workId: string; status: 'reserved' | 'complete' | 'failed'; result: unknown }
export interface Ledger { schema: 'wayfinder-scan-ledger/1'; planHash: string; approval: Approval; results: Reservation[] }

export function reviewWork(leadId: string, evidenceHash: string, calls: ReviewCall[]): Work[] {
  return calls.map(call => ({ id: `${leadId}-${call.id}`, kind: call.kind === 'review' ? 'reading' : call.kind,
    combination: { harness: call.target.cli, model: call.target.model, effort: 'client-default', entry: 'review' },
    scope: [leadId], repetitions: 1, extraReviews: 0, evidenceHash,
    prerequisites: [call.conditional ? 'Only if independent readings disagree; otherwise leave unspent' : 'Bind complete B01 evidence and obtain exact Batch approval'] }));
}

export function proposeBatch(report: ScanReport): { plan: BatchPlan; deferred: { leadId: string; reason: string }[] } {
  const work: Work[] = []; const deferred: { leadId: string; reason: string }[] = [];
  for (const lead of report.leads.filter(l => l.status === 'screened' && l.change !== 'seen' && l.kind !== 'missing-evidence')) {
    const session = report.inventory.find(s => s.key === lead.session)!;
    if (!lead.hasHumanWords || !session.model || session.harness === 'unknown') {
      deferred.push({ leadId: lead.id, reason: 'Original words or Combination unavailable; collect evidence before a model Batch' }); continue;
    }
    const calls = reviewCalls({ combination: { harness: session.harness, requestedModel: session.model,
      visibleModel: { known: true, value: session.model }, effort: { known: false, reason: 'Reviewer plan only' } } });
    work.push(...reviewWork(lead.id, lead.evidenceHash, calls));
  }
  return { plan: { schema: 'wayfinder-scan-batch/1', id: `scan-${digest(work).slice(0,16)}`, work,
    ceiling: work.reduce((n, w) => n + w.repetitions + w.extraReviews, 0) }, deferred };
}

export function plannedInvocations(plan: BatchPlan): { id: string; workId: string }[] {
  if (plan.schema !== 'wayfinder-scan-batch/1' || !plan.id || !Array.isArray(plan.work) || !Number.isSafeInteger(plan.ceiling) || plan.ceiling < 0) throw new Error('Invalid Batch plan');
  const ids = new Set<string>();
  return plan.work.flatMap(w => {
    if (!w.id || ids.has(w.id) || !['availability', 'reading', 'reproduction', 'regression', 'arbitration'].includes(w.kind)
      || !Number.isSafeInteger(w.repetitions) || w.repetitions < 1 || !Number.isSafeInteger(w.extraReviews) || w.extraReviews < 0
      || !Array.isArray(w.scope) || !w.scope.length || w.scope.some(x => typeof x !== 'string' || !x.trim()) || !w.evidenceHash
      || !w.combination || ['harness', 'model', 'effort', 'entry'].some(k => {
        const value = w.combination[k as keyof Work['combination']];
        return typeof value !== 'string' || !value.trim() || value === 'unknown';
      })) throw new Error('Incomplete or duplicate Batch work');
    ids.add(w.id);
    return Array.from({ length: w.repetitions + w.extraReviews }, (_, i) => ({ id: `${w.id}/${i + 1}`, workId: w.id }));
  });
}

export function openLedger(plan: BatchPlan, approval: Approval): Ledger {
  plannedInvocations(plan);
  if (!approval?.by?.trim() || !approval.reference?.trim() || approval.planHash !== digest(plan)) throw new Error('Exact Batch approval required');
  return { schema: 'wayfinder-scan-ledger/1', planHash: digest(plan), approval: structuredClone(approval), results: [] };
}

function validateLedger(plan: BatchPlan, ledger: Ledger) {
  openLedger(plan, ledger.approval);
  const invocations = plannedInvocations(plan);
  if (ledger.schema !== 'wayfinder-scan-ledger/1' || ledger.planHash !== digest(plan) || !Array.isArray(ledger.results)
    || ledger.results.length > plan.ceiling || new Set(ledger.results.map(r => r.id)).size !== ledger.results.length
    || ledger.results.some(r => !invocations.some(i => i.id === r.id && i.workId === r.workId) || !['reserved', 'complete', 'failed'].includes(r.status))) throw new Error('Invalid Batch ledger');
}

/** Persist this reservation BEFORE calling the existing runner/reviewer. A crash consumes its slot, never auto-retries it. */
export function reserve(plan: BatchPlan, ledger: Ledger, id: string): Ledger {
  validateLedger(plan, ledger);
  const item = plannedInvocations(plan).find(i => i.id === id);
  if (!item || ledger.results.some(r => r.id === id)) throw new Error('Unplanned or already reserved work');
  if (ledger.results.length >= plan.ceiling) throw new Error('Batch ceiling reached');
  return { ...structuredClone(ledger), results: [...structuredClone(ledger.results), { ...item, status: 'reserved', result: null }] };
}

/** Preserve every complete result (including failures), rather than replacing it with a success-only summary. */
export function finish(plan: BatchPlan, ledger: Ledger, id: string, status: 'complete' | 'failed', result: unknown): Ledger {
  validateLedger(plan, ledger);
  const found = ledger.results.find(r => r.id === id);
  if (!found || found.status !== 'reserved' || result === undefined || result === null || !['complete', 'failed'].includes(status)) throw new Error('A reserved invocation and full result are required');
  return { ...structuredClone(ledger), results: ledger.results.map(r => r.id === id ? { ...r, status, result: structuredClone(result) } : structuredClone(r)) };
}

export function batchStatus(plan: BatchPlan, ledger: Ledger) {
  validateLedger(plan, ledger);
  return { stoppedAtCeiling: ledger.results.length >= plan.ceiling, results: structuredClone(ledger.results),
    unresolved: ledger.results.filter(r => r.status === 'reserved').map(r => r.id),
    remaining: plannedInvocations(plan).filter(i => !ledger.results.some(r => r.id === i.id)),
    slotsLeft: plan.ceiling - ledger.results.length };
}
