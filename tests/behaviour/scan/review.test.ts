import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptSchema } from '../evidence.ts';
import type { AttemptRecord } from '../evidence.ts';
import { library } from '../library.ts';
import type { ReviewDriver, ReviewRequest, ReviewResponse } from '../model-review.ts';
import { reviewPlan } from '../review-run.ts';
import { analyze } from './analyze.ts';
import { openLedger, proposeBatch } from './batch.ts';
import type { Ledger } from './batch.ts';
import { digest, loadInputs } from './read.ts';
import { executeReviewBatch, planReviewBatch } from './review.ts';
import type { Manifest } from './types.ts';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const unknown = { known: false as const, reason: 'synthetic fixture' };
function prepare(session = 'codex:question-write') {
  const fixtures = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(fixtures, 'input.json'), 'utf8')) as Manifest;
  const inputs = loadInputs(manifest, fixtures);
  const first = analyze(inputs, manifest);
  const lead = first.leads.find(l => l.session === session && l.kind === 'write')!;
  const report = analyze(inputs, manifest, first.state, [{ leadId: lead.id, evidenceHash: lead.evidenceHash,
    disposition: 'screened', by: 'synthetic-reviewer', basis: 'Synthetic incident selected for bounded review', reason: 'Review the actual context', quotes: [] }]);
  const dir = mkdtempSync(join(tmpdir(), 'b08-review-')); roots.push(dir);
  const scenario = library.find(s => s.id === 'S12')!;
  const attempt: AttemptRecord = { schema: attemptSchema, attemptId: 'Synthetic/S12', batchId: 'Synthetic',
    subject: { kind: 'scenario', id: 'S12', version: scenario.version }, entry: 'mcp-only',
    combination: { harness: 'codex', requestedModel: 'synthetic-model', visibleModel: { known: true, value: 'synthetic-model' }, effort: unknown },
    client: { version: unknown, surface: unknown }, service: { commit: 'synthetic', series: 'release', version: '2.1.0' },
    given: [{ phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.1.0' },
      instructions: { known: true, value: 'synthetic rules' }, toolDescriptions: { known: true, value: { map_read: 'synthetic description' } },
      resources: 'available', prompts: 'available', extraContext: [] }],
    run: { startedAt: '', endedAt: '', completeness: 'complete' }, controller: { clientId: 'controller' }, baitClientIds: [],
    sessions: [{ label: 'A', nativeId: unknown, clientId: 'A', mcpSessionIds: unknown, turns: [{ index: 0, input: 'What next?', startedAt: '', endedAt: '', durationMs: 0 }] }],
    events: [
      { seq: 10, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'I recommend explicitly invoking Wayfinder.' },
      { seq: 11, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'Waiting for your choice.' },
    ], maps: [], receipts: [], usage: unknown, raw: { path: 'Synthetic/S12/raw', files: [] }, missing: [] };
  writeFileSync(join(dir, 'attempt.json'), JSON.stringify(attempt));
  const plan = planReviewBatch(report, [{ leadId: lead.id, directory: dir }]);
  const ledger = openLedger(plan, { planHash: digest(plan), by: 'synthetic-approver', reference: 'synthetic-approval#1' });
  const snapshots: Ledger[] = [];
  const persist = (state: Ledger) => {
    snapshots.push(state);
    writeFileSync(join(dir, `ledger-${snapshots.length}.json`), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  };
  return { dir, report, plan, ledger, snapshots, persist, attempt };
}

class Fake implements ReviewDriver {
  requests: ReviewRequest[] = [];
  constructor(private snapshots: Ledger[], private mode: 'agreement' | 'arbitration' | 'interrupt' | 'undecided' | 'rejected' = 'agreement') {}
  async invoke(request: ReviewRequest): Promise<ReviewResponse> {
    expect(this.snapshots.at(-1)?.results.at(-1)?.status).toBe('reserved');
    this.requests.push(request);
    if (this.mode === 'interrupt' && this.requests.length === 3) throw new Error('synthetic driver interruption');
    const items: { id: string }[] = request.kind === 'availability' ? [] : JSON.parse(request.input.slice(request.input.indexOf('\n{') + 1)).items;
    const text = request.kind === 'availability' ? 'AVAILABLE' : JSON.stringify({ items: items.map(i => ({ itemId: i.id,
      status: this.mode === 'undecided' && request.kind === 'arbitration' ? 'undecided'
        : ['arbitration', 'undecided'].includes(this.mode) && this.requests.length >= 4 ? 'violated' : 'holds',
      reason: 'Synthetic independent reading cites the recorded recommendation', evidence: [this.mode === 'rejected' ? 'events[999]' : 'events[0]'],
      support: [{ location: 'events[0]', quote: 'explicitly invoking Wayfinder', explanation: `This synthetic observation supports item ${i.id}` }] })) });
    return { status: 'complete', detail: 'fake only', text, stdout: text, stderr: '', responseId: `fake-${this.requests.length}`, visibleModel: request.target.model, cached: false };
  }
}

function prepareTwo() {
  const a = prepare(); const b = prepare('claude:normal-write');
  const report = { ...a.report, leads: [...a.report.leads.filter(l => l.status === 'screened'), ...b.report.leads.filter(l => l.status === 'screened')] };
  const bindings = [a, b].map(p => ({ leadId: p.plan.reviewRuns![0]!.leadId, directory: p.dir }));
  const plan = planReviewBatch(report, bindings);
  const ledger = openLedger(plan, { planHash: digest(plan), by: 'synthetic-approver', reference: 'synthetic-two-lead-approval' });
  return { a, b, plan, ledger, snapshots: a.snapshots, persist: a.persist };
}

describe('B08 approval handed to the existing B03b reviewer at each native invocation', () => {
  it.each(['undecided', 'rejected', 'interrupt'] as const)('continues the approved Batch after one lead ends %s', async mode => {
    const p = prepareTwo();
    const a = new Fake(p.snapshots, mode); const b = new Fake(p.snapshots, 'arbitration');
    const driver: ReviewDriver = { invoke: request => p.snapshots.at(-1)!.results.at(-1)!.workId.startsWith(p.plan.reviewRuns![0]!.leadId)
      ? a.invoke(request) : b.invoke(request) };
    const result = await executeReviewBatch(p.plan, p.ledger, driver, p.persist);
    expect(a.requests).toHaveLength(mode === 'undecided' ? 5 : mode === 'rejected' ? 4 : 3);
    expect(b.requests).toHaveLength(5);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]!.pending.length).toBeGreaterThan(0);
    if (mode === 'undecided') expect(result.summaries[0]!.pending.every(p => p.next === 'human')).toBe(true);
    expect(result.summaries[1]!.pending).toEqual([]);
    for (const [index, item] of [p.a, p.b].entries()) {
      const round = result.summaries[index]!;
      const approval = JSON.parse(readFileSync(join(item.dir, 'model-reviews', round.roundId, 'review-plan.json'), 'utf8'));
      expect(approval.callCeiling).toBe(5);
    }
    expect(result.status.results).toHaveLength(a.requests.length + b.requests.length);
    expect(result.status.stoppedAtCeiling).toBe(mode === 'undecided');
    const resumed = await executeReviewBatch(p.plan, result.ledger, driver, p.persist);
    expect(resumed.status.results).toEqual(result.status.results);
    expect(b.requests).toHaveLength(5);
  });

  it.each(['agreement', 'interrupt'] as const)('resumes a durable prefix ending in %s by running the unstarted lead without replaying calls', async mode => {
    const p = prepareTwo();
    // A real completed B03b round supplies the durable prefix of the two-lead ledger.
    const first = await executeReviewBatch(p.a.plan, p.a.ledger, new Fake(p.snapshots, mode), p.persist);
    const checkpoint: Ledger = JSON.parse(JSON.stringify({ ...p.ledger, results: first.ledger.results }));
    const fake = new Fake(p.snapshots, 'arbitration');
    const resumed = await executeReviewBatch(p.plan, checkpoint, fake, p.persist);
    expect(fake.requests).toHaveLength(5);
    expect(resumed.ledger.results.slice(0, checkpoint.results.length)).toEqual(checkpoint.results);
    expect(resumed.ledger.results).toHaveLength(checkpoint.results.length + 5);
    expect(resumed.summaries[0]!.pending).toEqual([]);
    expect(JSON.parse(readFileSync(join(p.a.dir, 'attempt.json'), 'utf8')).modelReviews).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(p.b.dir, 'attempt.json'), 'utf8')).modelReviews).toHaveLength(1);
  });

  it('keeps paid output in B03b when saving the response fails, then resumes unstarted leads from the durable reservation', async () => {
    const p = prepareTwo(); const fake = new Fake(p.snapshots);
    let durable = p.ledger;
    const result = await executeReviewBatch(p.plan, p.ledger, fake, state => {
      if (state.results.length === 3 && state.results.at(-1)!.status === 'complete') throw new Error('synthetic post-call disk failure');
      durable = state; p.persist(state);
    });
    expect(fake.requests).toHaveLength(3);
    expect(result.issues).toContainEqual(expect.objectContaining({ kind: 'ledger-save-failed' }));
    expect(result.stopped).toContain('Ledger persistence failed');
    const response = JSON.parse(readFileSync(join(p.a.dir, 'model-reviews', result.summaries[0]!.roundId, '3-review.output.json'), 'utf8'));
    expect(response).toMatchObject({ status: 'complete', responseId: 'fake-3' });
    expect(response.stdout).toContain('Synthetic independent reading');
    expect(result.summaries[0]!.reviews.length).toBeGreaterThan(0);
    expect(durable.results.at(-1)!.status).toBe('reserved');
    const next = new Fake(p.snapshots, 'arbitration');
    const resumed = await executeReviewBatch(p.plan, durable, next, p.persist);
    expect(next.requests).toHaveLength(5);
    expect(resumed.status.unresolved).toHaveLength(1);
    expect(resumed.ledger.results).toHaveLength(8);
  });

  it.each(['agreement', 'arbitration'] as const)('%s uses the shared five-call plan and persists every probe/reading/result', async mode => {
    const p = prepare();
    expect(proposeBatch(p.report).plan.ceiling).toBe(5);
    expect(p.plan.ceiling).toBe(reviewPlan([p.dir])[0]!.callCeiling);
    const fake = new Fake(p.snapshots, mode);
    const result = await executeReviewBatch(p.plan, p.ledger, fake, p.persist);
    expect(fake.requests.map(r => r.kind)).toEqual(['availability', 'availability', 'review', 'review', ...(mode === 'arbitration' ? ['arbitration'] : [])]);
    expect(result.ledger.results).toHaveLength(mode === 'arbitration' ? 5 : 4);
    expect(result.ledger.results.every(r => r.status === 'complete' && JSON.stringify(r.result).includes('stdout'))).toBe(true);
    expect(result.status.stoppedAtCeiling).toBe(mode === 'arbitration');
    expect(result.status.remaining).toHaveLength(mode === 'arbitration' ? 0 : 1);
    expect(result.summaries[0]!.pending).toEqual([]);
    expect(JSON.parse(readFileSync(join(p.dir, 'attempt.json'), 'utf8')).modelReviews).toHaveLength(1);
  });

  it('counts interruption, keeps partial results/remaining work and never replays probes on resume', async () => {
    const p = prepare(); const fake = new Fake(p.snapshots, 'interrupt');
    const result = await executeReviewBatch(p.plan, p.ledger, fake, p.persist);
    expect(fake.requests).toHaveLength(3);
    expect(result.ledger.results.map(r => r.status)).toEqual(['complete', 'complete', 'failed']);
    expect(JSON.stringify(result.ledger.results[2]!.result)).toContain('synthetic driver interruption');
    expect(result.status.remaining).toHaveLength(2);
    expect(result.summaries[0]!.pending.length).toBeGreaterThan(0);
    const resumed = await executeReviewBatch(p.plan, result.ledger, fake, p.persist);
    expect(fake.requests).toHaveLength(3);
    expect(resumed.status.results).toEqual(result.status.results);
    expect(resumed.status.remaining).toEqual(result.status.remaining);
  });

  it('starts no driver call without a durable reservation and retains unresolved consumption', async () => {
    const p = prepare(); const fake = new Fake(p.snapshots);
    const result = await executeReviewBatch(p.plan, p.ledger, fake, state => {
      p.persist(state);
      if (state.results.length === 3) throw new Error('synthetic interruption after reserving');
    });
    expect(fake.requests).toHaveLength(2);
    expect(result.status.unresolved).toHaveLength(1);
    expect(result.status.remaining).toHaveLength(2);
    const resumed = await executeReviewBatch(p.plan, result.ledger, fake, p.persist);
    expect(resumed.status.unresolved).toEqual(result.status.unresolved);
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses an under-budget plan and changed evidence before any driver call', async () => {
    const p = prepare(); const fake = new Fake(p.snapshots);
    const under = { ...p.plan, ceiling: 3 };
    const approval = openLedger(under, { by: 'synthetic', reference: 'synthetic', planHash: digest(under) });
    await expect(executeReviewBatch(under, approval, fake, p.persist)).rejects.toThrow(/ceiling/);
    p.attempt.run.detail = 'changed evidence';
    writeFileSync(join(p.dir, 'attempt.json'), JSON.stringify(p.attempt));
    const changed = await executeReviewBatch(p.plan, p.ledger, fake, p.persist);
    expect(changed.issues).toEqual([expect.objectContaining({ kind: 'review-failed', detail: expect.stringContaining('changed after approval') })]);
    expect(fake.requests).toEqual([]);
  });
});
