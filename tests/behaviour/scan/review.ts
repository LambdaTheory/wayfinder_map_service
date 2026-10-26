// Explicit, approved B03b handoff. Never imported by the scan CLI; callers supply the actual Driver.
import { reviewDirectories, reviewPlan } from '../review-run.ts';
import type { ReviewDriver, ReviewRequest } from '../model-review.ts';
import type { ReviewSummary } from '../review-types.ts';
import type { ScanReport } from './analyze.ts';
import { batchStatus, finish, reserve, reviewWork, reviewWorkId } from './batch.ts';
import type { BatchPlan, Ledger } from './batch.ts';
import { digest } from './read.ts';

/** Bind screened leads to real B01 plans BEFORE requesting approval; this operation spends no quota. */
export function planReviewBatch(report: ScanReport, bindings: { leadId: string; directory: string; retry?: boolean }[]): BatchPlan {
  if (!bindings.length || new Set(bindings.map(b => b.leadId)).size !== bindings.length) throw new Error('Unique screened lead bindings required');
  const reviewRuns = bindings.map(binding => {
    const lead = report.leads.find(l => l.id === binding.leadId);
    if (!lead || lead.status !== 'screened' || !lead.hasHumanWords || lead.kind === 'missing-evidence') throw new Error('Review requires a screened lead and original human evidence');
    return { leadId: lead.id, plan: reviewPlan([binding.directory], binding.retry)[0]!, retry: binding.retry ?? false };
  });
  if (new Set(reviewRuns.map(r => r.plan.directory)).size !== reviewRuns.length) throw new Error('An Attempt can be bound only once in a Batch');
  const work = reviewRuns.flatMap(r => reviewWork(r.leadId, r.plan.evidenceHash, r.plan.calls));
  return { schema: 'wayfinder-scan-batch/1', id: `review-${digest(reviewRuns).slice(0,16)}`, reviewRuns, work,
    ceiling: reviewRuns.reduce((n, r) => n + r.plan.callCeiling, 0) };
}

export interface BatchReviewIssue {
  leadId: string; kind: 'recorded-round' | 'review-failed' | 'ledger-save-failed'; detail: string;
}

/** One shared approved ceiling, reserved at every B03b driver invocation, including availability probes. */
export async function executeReviewBatch(plan: BatchPlan, initial: Ledger, driver: ReviewDriver,
  persist: (ledger: Ledger) => void | Promise<void>): Promise<{ ledger: Ledger; summaries: ReviewSummary[]; issues: BatchReviewIssue[]; status: ReturnType<typeof batchStatus>; stopped: string | null }> {
  batchStatus(plan, initial); // Verifies the exact approval and all existing reservations.
  if (!plan.reviewRuns?.length) throw new Error('Bind B01 review evidence before approving execution');
  const expectedWork = plan.reviewRuns.flatMap(r => reviewWork(r.leadId, r.plan.evidenceHash, r.plan.calls));
  if (digest(plan.work) !== digest(expectedWork) || plan.ceiling !== plan.reviewRuns.reduce((n,r) => n + r.plan.callCeiling, 0)) throw new Error('B03b work/ceiling differs from the approved invocation plan');
  let ledger = structuredClone(initial);
  const summaries: ReviewSummary[] = [];
  const issues: BatchReviewIssue[] = [];
  let stopped: string | null = null;
  for (const run of plan.reviewRuns) {
    const workIds = run.plan.calls.map(c => reviewWorkId(run.leadId, c.id));
    // Never turn a partially spent round into a fresh round of probes on resume.
    if (ledger.results.some(r => workIds.includes(r.workId))) {
      issues.push({ leadId: run.leadId, kind: 'recorded-round', detail: 'Skipped recorded round; preserve its results and reconcile unfinished items before separately approving retry' });
      continue;
    }
    if (ledger.results.length >= plan.ceiling) { stopped = 'Batch ceiling reached'; break; }
    const save = async () => {
      try { await persist(structuredClone(ledger)); }
      catch (error) {
        issues.push({ leadId: run.leadId, kind: 'ledger-save-failed', detail: String(error) });
        stopped = 'Ledger persistence failed; preserve the reserved slots and native outputs before resuming';
        return false;
      }
      return true;
    };
    let nextCall = 0;
    const bounded: ReviewDriver = { invoke: async (request: ReviewRequest) => {
      if (stopped) throw new Error(stopped);
      const expected = run.plan.calls[nextCall];
      if (!expected || expected.kind !== request.kind || digest(expected.target) !== digest(request.target)) {
        stopped = 'Unplanned B03b driver invocation'; throw new Error(stopped);
      }
      const id = `${reviewWorkId(run.leadId, expected.id)}/1`;
      ledger = reserve(plan, ledger, id);
      if (!await save()) throw new Error(stopped!); // A failed durable reservation starts no model.
      nextCall++;
      try {
        const response = await driver.invoke(request);
        ledger = finish(plan, ledger, id, response.status === 'complete' ? 'complete' : 'failed', { request, response });
        // B03b must save the actual paid output even when the post-call ledger write fails.
        await save();
        return response;
      } catch (error) {
        if (ledger.results.find(r => r.id === id)?.status === 'reserved') {
          ledger = finish(plan, ledger, id, 'failed', { request, error: String(error), outcome: 'interrupted or driver failed; do not infer completion' });
          await save();
        }
        throw error;
      }
    } };
    try {
      const current = reviewPlan([run.plan.directory], run.retry)[0]!;
      if (digest(current) !== digest(run.plan)) throw new Error('B01 evidence/review plan changed after approval');
      summaries.push(...await reviewDirectories([run.plan.directory], bounded, plan.id, run.plan.callCeiling, run.retry));
    } catch (error) {
      issues.push({ leadId: run.leadId, kind: 'review-failed', detail: String(error) });
    }
    // Pending human verdicts, rejected readings and individual failures do not cancel other approved runs.
    if (stopped) break;
  }
  return { ledger, summaries, issues, status: batchStatus(plan, ledger), stopped };
}
