// Quota accounting only. This module cannot launch a model; the scan CLI never accepts approval or runs work.
import { digest } from './read.ts';
import type { ScanReport } from './analyze.ts';

export interface Work {
  id: string; kind: 'reading' | 'reproduction' | 'regression' | 'arbitration';
  combination: { harness: string; model: string; effort: string; entry: string };
  scope: string[]; repetitions: number; extraReviews: number;
  /** Bind readings to exactly the evidence the approver saw. */
  evidenceHash: string; prerequisites: string[];
}
export interface BatchPlan {
  schema: 'wayfinder-scan-batch/1'; id: string; work: Work[]; ceiling: number;
}
export interface Approval { planHash: string; reference: string; by: string }
export interface Reservation { id: string; workId: string; status: 'reserved' | 'complete' | 'failed'; result: unknown }
export interface Ledger { schema: 'wayfinder-scan-ledger/1'; planHash: string; approval: Approval; results: Reservation[] }

export function proposeBatch(report: ScanReport): { plan: BatchPlan; deferred: { leadId: string; reason: string }[] } {
  const work: Work[] = []; const deferred: { leadId: string; reason: string }[] = [];
  for (const lead of report.leads.filter(l => l.status !== 'dismissed' && l.kind !== 'missing-evidence')) {
    const session = report.inventory.find(s => s.key === lead.session)!;
    if (!lead.fragments.some(f => f.role === 'user')) { deferred.push({ leadId: lead.id, reason: 'Original words unavailable; screen whether a verdict needs them before requesting any' }); continue; }
    const claude = session.harness === 'claude' || /claude|sonnet|opus|haiku|fable/i.test(session.model ?? '');
    const combination = { harness: claude ? 'codex' : 'claude', model: claude ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'high', entry: 'review' };
    work.push({ id: `${lead.id}-reading`, kind: 'reading', combination, scope: [lead.id], repetitions: 2, extraReviews: 0,
      evidenceHash: lead.evidenceHash, prerequisites: ['Operator screens the signal and selects relevant full native evidence',
        'B03b review of an evidence-complete Attempt with specified verdict items; otherwise remain pending', 'Confirm exact reviewer availability without substitution'] });
    work.push({ id: `${lead.id}-arbitration`, kind: 'arbitration', combination: { ...combination, model: claude ? 'gpt-6-astra' : 'claude-opus-5-5' },
      scope: [lead.id], repetitions: 1, extraReviews: 0, evidenceHash: lead.evidenceHash,
      prerequisites: ['Only if the two independent readings disagree; otherwise leave unspent'] });
    if (lead.status === 'confirmed') deferred.push({ leadId: lead.id,
      reason: 'Prepare B04 Scenario and original Combination first; list two reproductions and separate regression/review work in a new approval plan' });
  }
  return { plan: { schema: 'wayfinder-scan-batch/1', id: `scan-${digest(work).slice(0,16)}`, work,
    ceiling: work.reduce((n, w) => n + w.repetitions + w.extraReviews, 0) }, deferred };
}

export function plannedInvocations(plan: BatchPlan): { id: string; workId: string }[] {
  if (plan.schema !== 'wayfinder-scan-batch/1' || !plan.id || !Array.isArray(plan.work) || !Number.isSafeInteger(plan.ceiling) || plan.ceiling < 0) throw new Error('Invalid Batch plan');
  const ids = new Set<string>();
  return plan.work.flatMap(w => {
    if (!w.id || ids.has(w.id) || !['reading', 'reproduction', 'regression', 'arbitration'].includes(w.kind)
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
