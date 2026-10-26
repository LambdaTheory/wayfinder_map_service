// Fixed evidence and fake review drivers only. No model generations, credentials or everyday services.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { attemptSchema } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { library } from './library.ts';
import { buildReport, renderMarkdown } from './report.ts';
import { CliReviewDriver, codexReviewSandbox, decodeResponse, reviewArgs } from './review-cli.ts';
import { reviewProxyVariables } from './review-proxy.ts';
import { reviewDirectories, reviewPlan } from './review-run.ts';
import { reviewAttempt, reviewersFor, reviewItems } from './model-review.ts';
import { turnWriteEvidence } from './review-no-writes.ts';
import type { ReviewDriver, ReviewRequest, ReviewResponse } from './model-review.ts';
import { decideReviews, evidenceHash, evidenceLocations, missingForReview, reportReason, reviewProblem } from './review-verdict.ts';
import type { Review, ReviewSummary } from './review-verdict.ts';
import { judgeAttempt } from './verdict.ts';

const root = mkdtempSync(join(tmpdir(), 'wayfinder-review-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scenario = library.find(s => s.id === 'S12')!;
const unknown = { known: false as const, reason: 'synthetic fixture' };
function sample(): AttemptRecord {
  return { schema: attemptSchema, attemptId: 'B/S12-1', batchId: 'B', subject: { kind: 'scenario', id: 'S12', version: scenario.version }, entry: 'mcp-only',
    combination: { harness: 'codex', requestedModel: 'gpt-6-astra', visibleModel: { known: true, value: 'gpt-6-astra' }, effort: { known: true, value: 'xhigh' } },
    client: { version: unknown, surface: unknown }, service: { commit: 'fixture', series: 'release', version: '2.0.2' }, given: [{ phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.0.2' }, instructions: { known: true, value: 'fixture rules' }, toolDescriptions: { known: true, value: { map_read: 'fixture tool' } }, resources: 'available', prompts: 'available', extraContext: [] }],
    run: { startedAt: '', endedAt: '', completeness: 'complete' }, controller: { clientId: 'controller' }, baitClientIds: [],
    sessions: [{ label: 'A', nativeId: unknown, clientId: 'A', mcpSessionIds: unknown,
      turns: [{ index: 0, input: 'What next?', startedAt: '', endedAt: '', durationMs: 0 }] }],
    events: [
      { seq: 10, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'I recommend explicitly invoking Wayfinder.' },
      { seq: 11, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'Waiting for your choice.' },
    ], maps: [], receipts: [], usage: unknown, raw: { path: 'B/S12-1/raw', files: [] }, missing: [] };
}
function directory(a: AttemptRecord = sample()): string {
  const dir = mkdtempSync(join(root, 'attempt-'));
  writeFileSync(join(dir, 'attempt.json'), JSON.stringify(a));
  return dir;
}
type Edit = (request: ReviewRequest, response: ReviewResponse, reading: number) => ReviewResponse;
class Fake implements ReviewDriver {
  requests: ReviewRequest[] = [];
  private reading = 0;
  private edit: Edit;
  constructor(edit: Edit = (_, response) => response) { this.edit = edit; }
  async invoke(request: ReviewRequest): Promise<ReviewResponse> {
    this.requests.push(request);
    if (request.kind !== 'availability') this.reading++;
    const items = request.kind === 'availability' ? [] : JSON.parse(request.input.slice(request.input.indexOf('\n{') + 1)).items;
    const text = request.kind === 'availability' ? 'AVAILABLE' : JSON.stringify({ items: items.map((i: { id: string }) => ({ itemId: i.id,
      status: 'holds', reason: 'The recommendation appears at event 10 before the final waiting message.', evidence: ['events[0]'], support: [{ location: 'events[0]', quote: 'explicitly invoking Wayfinder', explanation: `This observation supports item ${i.id}.` }] })) });
    return this.edit(request, { status: 'complete', detail: 'fake generation', text, stdout: text, stderr: '', responseId: `native-${this.requests.length}`,
      visibleModel: request.target.model, cached: false }, this.reading);
  }
}
function status(response: ReviewResponse, value: Review['status']): ReviewResponse {
  const body = JSON.parse(response.text);
  body.items.forEach((i: Review) => { i.status = value; i.reason = `Fixed evidence reading: ${value}`; });
  return { ...response, text: JSON.stringify(body) };
}
async function judged(fake: Fake, a = sample()) {
  const dir = directory(a);
  const result = await reviewAttempt(scenario, a, fake, dir);
  return { dir, result, verdict: judgeAttempt(scenario, { ...a, modelReviews: [result] }) };
}

describe('independent reviews over complete Attempt evidence', () => {
  test('selects exact other-vendor reviewers, including Claude in another harness', () => {
    const a = sample();
    expect(reviewersFor(a)).toEqual({ reviewer: { cli: 'claude', model: 'claude-sonnet-5-5' }, arbiter: { cli: 'claude', model: 'claude-opus-5-5' } });
    a.combination.harness = 'claude';
    expect(reviewersFor(a).reviewer.model).toBe('gpt-6.1-sol');
    a.combination.harness = 'pi'; a.combination.visibleModel = { known: true, value: 'claude-opus-5-5' };
    expect(reviewersFor(a).arbiter.model).toBe('gpt-6-astra');
  });
  test('agreement: two separate calls with identical evidence, no previous answer, no arbitration', async () => {
    const fake = new Fake(); const { result, verdict, dir } = await judged(fake);
    expect(fake.requests.map(r => r.kind)).toEqual(['availability', 'availability', 'review', 'review']);
    expect(fake.requests[2]!.input).toBe(fake.requests[3]!.input);
    expect(fake.requests[2]!.id).not.toBe(fake.requests[3]!.id);
    expect(fake.requests[2]!.input).toContain('I recommend explicitly invoking Wayfinder.');
    expect(fake.requests[2]!.input).toContain('Waiting for your choice.');
    expect(fake.requests[2]!.input).not.toContain('priorReadings');
    expect(result.reviews.some(r => r.itemId === 'status-narration')).toBe(true);
    expect(verdict.outcome).toBe('pass');
    expect(verdict.expect[0]!.items[0]!.evidence).toEqual(['events[0]']);
    expect(readdirSync(dirname(join(dir, result.path))).filter(x => x.endsWith('.input.json'))).toHaveLength(4);
    expect(readdirSync(dirname(join(dir, result.path))).filter(x => x.endsWith('.output.json'))).toHaveLength(4);
  });
  test('neutral synthetic examples cover both verdicts and satisfy the unchanged evidence validator', async () => {
    const inputs: string[] = [];
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      inputs.push(req.input);
      return out;
    });
    expect((await judged(fake)).verdict.outcome).toBe('pass');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const packet = JSON.parse(input.slice(input.indexOf('\n{') + 1));
      expect(packet.syntheticCitationExamples).toHaveLength(2);
      expect(packet.syntheticCitationExamples.map((e: { output: { items: Review[] } }) => e.output.items[0]!.status).sort()).toEqual(['holds', 'violated']);
      expect(JSON.stringify(packet.syntheticCitationExamples)).not.toMatch(/scope|permission|Feishu|asks-scope/i);
      for (const example of packet.syntheticCitationExamples) {
        const a = sample(); const session = a.sessions[0]!;
        session.label = 'SYNTHETIC'; session.turns[0]!.index = 37;
        a.events = [{ ...a.events[0]!, kind: 'message', role: 'assistant', session: session.label, turn: 37, text: example.sources.reply.text }];
        expect(example.sources.reply).toMatchObject({ session: 'SYNTHETIC', turn: 37 });
        const entry = example.output.items[0];
        expect(Object.keys(entry).sort()).toEqual(['evidence', 'itemId', 'reason', 'status', 'support']);
        expect(entry.itemId).toBe('synthetic-label-check');
        expect(entry.support).toHaveLength(2);
        expect(entry.support[1].quote).toBe(turnWriteEvidence(a)[0]![0]!.statement);
        expect(reviewProblem({ ...entry, by: 'fixture', role: 'review', readingId: 'synthetic-example' }, a)).toBeNull();
      }
    }
  });
  test('the guide identifies human events and turns as context and explains decoded quotations', async () => {
    const a = sample();
    a.sessions[0]!.turns[0]!.input = 'Choose "cobalt"\nthen wait.';
    a.events.push({ seq: 12, at: '', session: 'A', turn: 0, actor: 'script-human', kind: 'message', role: 'user', text: 'A human question.' },
      { seq: 13, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'user', text: 'Recorded user input.' },
      { seq: 14, at: '', session: null, turn: null, actor: 'controller', kind: 'message', role: 'user', text: 'Controller setup.' });
    const fake = new Fake(); const { result } = await judged(fake, a);
    expect(result.reviews).toHaveLength(4); // Two requested items, each read twice.
    const requests = fake.requests.filter(r => r.kind === 'review'); expect(requests).toHaveLength(2);
    for (const request of requests) {
      const packet = JSON.parse(request.input.slice(request.input.indexOf('\n{') + 1));
      expect(packet.citationGuide.contextOnly).toEqual(['sessions[0].turns[0]', 'events[2]', 'events[3]']);
      expect(packet.citationGuide.contextOnly.every((p: string) => packet.evidenceLocations.includes(p))).toBe(true);
      expect(request.input).toContain("sessions[i].turns[j] quotes an exact substring of that turn's decoded input field, not its JSON");
      expect(request.input).toContain('Human message events quote decoded text');
    }
    const reading = result.reviews[0]!;
    const context = { location: 'sessions[0].turns[0]', quote: a.sessions[0]!.turns[0]!.input, explanation: 'The human input supplies context only.' };
    const supported = { ...reading, evidence: [...reading.evidence!, context.location], support: [...reading.support!, context] };
    expect(reviewProblem(supported, a)).toBeNull();
    expect(reviewProblem({ ...supported, support: [...reading.support!, { ...context, quote: JSON.stringify(context.quote) }] }, a))
      .toContain('review needs quoted');
    expect(reviewProblem({ ...reading, evidence: [context.location], support: [context] }, a)).toContain('review needs quoted');
  });
  test('disagreement goes to the stronger model with both readings and the full evidence', async () => {
    const fake = new Fake((req, out, n) => req.kind === 'availability' ? out : status(out, n === 1 ? 'holds' : 'violated'));
    const { result, verdict } = await judged(fake);
    expect(fake.requests).toHaveLength(5);
    expect(fake.requests[4]!.target.model).toBe('claude-opus-5-5');
    expect(fake.requests[4]!.input).toContain('priorReadings');
    expect(fake.requests[4]!.input).toContain('native-3');
    expect(fake.requests[4]!.input).toContain('native-4');
    expect(result.reviews.find(r => r.role === 'arbitration')!.reason).toContain('violated');
    expect(verdict.outcome).toBe('fail');
  });
  test('undecided arbitration stays open for the human', async () => {
    const fake = new Fake((req, out, n) => req.kind === 'availability' ? out : status(out, n === 1 ? 'holds' : n === 2 ? 'violated' : 'undecided'));
    const { result, verdict } = await judged(fake);
    expect(result.pending).toContainEqual(expect.objectContaining({ itemId: 'recommends', next: 'human' }));
    expect(verdict.outcome).toBe('insufficient-evidence');
    expect(verdict.expect[0]!.items[0]!.reason).toContain('human verdict required');
  });
  test('unavailable reviewer is reported before reviewing; no model substitution', async () => {
    const fake = new Fake((_, out) => ({ ...out, status: 'unavailable', detail: 'model not available for this account' }));
    const { result, verdict } = await judged(fake);
    expect(fake.requests).toHaveLength(1);
    expect(result.pending[0]!.reason).toContain('claude-sonnet-5-5: unavailable');
    expect(verdict.outcome).toBe('insufficient-evidence');
  });
  test('arbiter availability is checked even when the two reviewers might agree', async () => {
    const fake = new Fake((req, out) => req.target.model.includes('opus') ? { ...out, status: 'unavailable', detail: 'no access' } : out);
    const { result } = await judged(fake);
    expect(fake.requests).toHaveLength(2);
    expect(result.pending[0]!.reason).toContain('claude-opus-5-5');
  });
  test.each(['cache', 'duplicate'] as const)('%s cannot count one response as two readings', async mode => {
    const fake = new Fake((req, out, n) => req.kind === 'review' && n === 2
      ? { ...out, ...(mode === 'cache' ? { cached: true } : { responseId: 'native-3' }) } : out);
    const { result, verdict } = await judged(fake);
    expect(result.reviews.filter(r => r.itemId === 'recommends')).toHaveLength(1);
    expect(result.pending[0]!.reason).toContain('not an independent reading');
    expect(verdict.outcome).toBe('insufficient-evidence');
    expect(fake.requests).toHaveLength(4);
  });
  test.each(['missing-location', 'invented-location', 'final-only', 'empty-reason', 'missing-evidence'] as const)('%s cannot establish holds, even in arbitration', async mode => {
    const a = sample(); if (mode === 'missing-evidence') a.missing = ['events.tool-call'];
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      const json = JSON.parse(out.text);
      json.items.forEach((i: Review) => { if (mode === 'empty-reason') i.reason = ''; else if (mode !== 'missing-evidence') i.evidence = mode === 'missing-location' ? [] : [mode === 'final-only' ? 'events[1]' : 'events[99]']; });
      return { ...out, text: JSON.stringify(json) };
    });
    const { result, verdict } = await judged(fake, a);
    expect(verdict.outcome).toBe('insufficient-evidence');
    expect(result.pending.some(p => p.next === 'retry')).toBe(true);
  });
  test('a concrete violation survives missing evidence and a later passing review round', async () => {
    const a = sample(); a.missing = ['events.tool-call'];
    const failed = await judged(new Fake((req, out) => req.kind === 'availability' ? out : status(out, 'violated')), a);
    expect(failed.verdict.outcome).toBe('fail');
    const clean = sample(); const bad = await judged(new Fake((req, out) => req.kind === 'availability' ? out : status(out, 'violated')), clean);
    const good = await judged(new Fake(), clean);
    expect(judgeAttempt(scenario, { ...clean, modelReviews: [bad.result, good.result] }).outcome).toBe('fail');
  });
  test('a changed or unidentified model is reported, never substituted', async () => {
    const { result } = await judged(new Fake((_, out) => ({ ...out, visibleModel: 'claude-sonnet-5-4' })));
    expect(result.pending[0]!.reason).toContain('no substitution');
  });
  test('a human input alone cannot prove agent success when agent activity is absent', async () => {
    const a = sample(); a.events = [];
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      const json = JSON.parse(out.text); json.items.forEach((i: Review) => { i.evidence = ['sessions[0].turns[0]']; });
      return { ...out, text: JSON.stringify(json) };
    });
    const { verdict, result } = await judged(fake, a);
    expect(verdict.outcome).toBe('insufficient-evidence');
    expect(result.pending[0]!.reason).toContain('valid independent readings');
  });
  test('script decisions and human/paused items never go to the model', () => {
    expect(reviewItems(scenario, sample()).map(i => i.id)).toEqual(['recommends', 'status-narration']);
    const s = { ...scenario, mustNot: [{ id: 'human', text: 'h', judge: 'human' as const, criterion: 'h' },
      { id: 'paused', text: 'p', judge: 'model' as const, criterion: 'p', paused: 'human choice' }] };
    expect(reviewItems(s, sample()).map(i => i.id)).toEqual(['recommends', 'status-narration']);
  });
});

describe('manual review command and report integration', () => {
  test('plans without a driver and refuses a ceiling below all planned invocations', async () => {
    const dir = directory(); const driver = new Fake();
    expect(reviewPlan([dir])[0]!.callCeiling).toBe(5);
    await expect(reviewDirectories([dir], driver, 'approved', 4)).rejects.toThrow('at least 5');
    expect(driver.requests).toHaveLength(0);
  });
  test('writes multiple Attempts, preserves originals and reads their saved review evidence in reports', async () => {
    const batch = mkdtempSync(join(root, 'batch-')); const dirs = ['S12-1', 'S12-2'].map(id => join(batch, id));
    dirs.forEach((dir, i) => { mkdirSync(dir); writeFileSync(join(dir, 'attempt.json'), JSON.stringify({ ...sample(), attemptId: `B/S12-${i + 1}`, isolation: { fixture: true } })); });
    writeFileSync(join(batch, 'batch.json'), JSON.stringify({ batchId: 'B', combination: 'codex:gpt-6-astra:xhigh', entry: 'mcp-only',
      outcomes: dirs.map((_, i) => ({ attemptId: `S12-${i + 1}`, scenario: 'S12', completeness: 'complete', record: `S12-${i + 1}/attempt.json` })) }));
    await reviewDirectories(dirs, new Fake(), 'approved-review-batch', 10);
    const record = JSON.parse(readFileSync(join(dirs[0]!, 'attempt.json'), 'utf8'));
    expect(record.isolation).toEqual({ fixture: true });
    expect(record.events).toEqual(sample().events);
    const report = buildReport([batch]);
    expect(report.cells[0]!.verdict.outcome).toBe('pass');
    expect(renderMarkdown(report)).toContain('events[0]');
    expect(renderMarkdown(report)).toContain(record.modelReviews[0].path);
    await expect(reviewDirectories([dirs[0]!], new Fake(), 'approved-retry', 5, true)).rejects.toThrow('No retryable items');
    expect(JSON.parse(readFileSync(join(dirs[0]!, 'attempt.json'), 'utf8')).modelReviews).toHaveLength(1);
  });
  test('stale reviews do not decide edited evidence, nor does an old Scenario get re-judged', async () => {
    const a = sample(); const { result } = await judged(new Fake(), a);
    a.events[0] = { ...a.events[0]!, kind: 'message', role: 'assistant', text: 'No recommendation.' };
    expect(judgeAttempt(scenario, { ...a, modelReviews: [result] }).outcome).toBe('insufficient-evidence');
    a.subject.version--;
    expect(() => reviewItems(scenario, a)).toThrow('do not re-judge');
  });
  test('an occupied Attempt lock prevents calls', async () => {
    const dir = directory(); writeFileSync(join(dir, '.model-review.lock'), 'another worker'); const driver = new Fake();
    await expect(reviewDirectories([dir], driver, 'approved', 5)).rejects.toThrow();
    expect(driver.requests).toHaveLength(0);
  });
  test('concurrent evidence edits preserve raw review output without attaching stale decisions', async () => {
    const dir = directory();
    const fake = new Fake((_, out) => {
      const changed = sample(); changed.run.detail = 'changed by another process';
      writeFileSync(join(dir, 'attempt.json'), JSON.stringify(changed));
      return out;
    });
    await expect(reviewDirectories([dir], fake, 'approved', 5)).rejects.toThrow('Attempt changed while reviewing');
    expect(JSON.parse(readFileSync(join(dir, 'attempt.json'), 'utf8')).modelReviews).toBeUndefined();
    const rounds = readdirSync(join(dir, 'model-reviews'));
    expect(readdirSync(join(dir, 'model-reviews', rounds[0]!))).toContain('result.json');
    expect(() => reviewPlan([dir], true)).toThrow('Unattached review round');
  });
  test('approval provenance is durable before the first driver invocation', async () => {
    const dir = directory();
    const fake = new Fake((_, out) => {
      const rounds = readdirSync(join(dir, 'model-reviews'));
      const plan = JSON.parse(readFileSync(join(dir, 'model-reviews', rounds[0]!, 'review-plan.json'), 'utf8'));
      expect(plan).toMatchObject({ batch: 'approved-early', callCeiling: 5, retry: false });
      expect(plan.plan[0].attemptId).toBe('B/S12-1');
      return out;
    });
    await reviewDirectories([dir], fake, 'approved-early', 5);
    expect(fake.requests).toHaveLength(4);
  });
  test('one JSON fence is accepted without extra calls', async () => {
    const fake = new Fake((req, out) => req.kind === 'availability' ? out : { ...out, text: '```json\n' + out.text + '\n```' });
    expect((await judged(fake)).verdict.outcome).toBe('pass');
    expect(fake.requests).toHaveLength(4);
  });
  test('private diagnostic paths stay in raw output, outside reportable reasons', async () => {
    const fake: ReviewDriver = { async invoke() { throw new Error('failed at /Users/fixture/private/state'); } };
    const a = sample(); const dir = directory(a); const result = await reviewAttempt(scenario, a, fake, dir);
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(readFileSync(join(dirname(join(dir, result.path)), '1-availability.output.json'), 'utf8')).toContain('/Users/fixture');
    expect(reportReason('reason /Users/fixture/private/file')).toBe('reason <private-path>');
  });
});

describe('final replies with independent same-turn evidence', () => {
  const f11 = library.find(s => s.id === 'F11')!;
  type Context = 'event' | 'receipt' | 'unchanged-map';
  function fixture(context: Context, status: 'holds' | 'violated') {
    const a = sample(); const mapId = 'Fixture.Scope';
    a.subject = { kind: 'scenario', id: f11.id, version: f11.version };
    a.attemptId = 'B/F11-1'; a.raw.path = 'B/F11-1/raw';
    a.sessions[0]!.turns[0]!.input = 'Does this permission belong to the Agent system rather than Feishu?';
    a.maps = [{ mapId, seedHeadRevision: 1, history: [{ mapId, revision: 1, priorRevision: null, kind: 'create',
      author: { actorId: 'fixture', clientId: a.controller.clientId, occurredAt: '' }, changes: [],
      state: { id: mapId, title: 'Permission boundaries', destination: 'Separate Agent policy from Feishu access.', notes: '',
        currentRevision: 1, fog: [], scopeExclusions: [], tickets: [{ id: 'D03', title: 'Permission scope',
          question: 'Which permissions belong to the Agent system and which to Feishu?', type: 'grilling', prerequisites: [], status: 'open', claim: null }] } }] }];
    const text = status === 'holds'
      ? 'Agent policy governs delegated actions; Feishu enforces access.\nShould we move the Agent-side part out of this Map?'
      : 'I will continue with the next task.';
    a.events = [{ seq: 1, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text }];
    if (context !== 'unchanged-map') a.events.unshift({ seq: 0, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'tool-call',
      callId: 'scope-call', server: 'wayfinder', tool: context === 'event' ? 'map_read' : 'map_apply', arguments: { mapId },
      result: { known: true, value: context === 'event' ? { question: 'Agent policy and Feishu access' } : { kind: 'rejected', code: 'version_mismatch' } },
      failed: context === 'receipt', requestId: unknown });
    if (context === 'receipt') a.receipts = [{ callId: 'scope-call', session: 'A', turn: 0, tool: 'map_apply', mapId,
      outcome: { kind: 'not-written', because: 'version-mismatch' } }];
    const reply = `events[${a.events.length - 1}]`;
    const location = context === 'event' ? 'events[0]' : context === 'receipt' ? 'receipts[0]' : 'turnWrites[0][0]';
    const support = [{ location: reply, quote: text,
      explanation: status === 'holds' ? 'The reply explains the two permission layers and asks before moving scope.' : 'The reply neither answers the question nor asks whether to move scope.' },
    { location, quote: context === 'event' ? 'Agent policy and Feishu access' : context === 'receipt' ? 'not-written'
      : noWriteClaim(0, [{ mapId, before: 1, after: 1 }]),
      explanation: context === 'event' ? 'The read in this turn identifies the permission issue that the reply must answer.'
        : 'The recorded receipts and catalog heads corroborate the asks-scope requirement that the reply precede any Map change in this turn.' }];
    const reviews: Review[] = ['first', 'second'].map(readingId => ({ itemId: 'asks-scope', status, reason: support[0]!.explanation,
      by: 'fixture', role: 'review', roundId: 'fixed', readingId, evidence: [reply, location], support: structuredClone(support) }));
    return { a, reviews, reply };
  }

  const noWriteClaim = (turn: number, heads: { mapId: string; before: number | null; after: number | null }[]) =>
    `No agent writes in session A turn ${turn}; committed receipts: []; catalog heads (before -> after): ${JSON.stringify(heads)}.`;
  function noWriteReadings(a: AttemptRecord, itemId: string, status: 'holds' | 'violated', heads: Parameters<typeof noWriteClaim>[1] = [], replyIndex = 0, turnIndex = 0): Review[] {
    const reply = a.events[replyIndex]!;
    if (reply.kind !== 'message') throw new Error('fixture requires a reply');
    const location = `turnWrites[0][${turnIndex}]`;
    return ['first', 'second'].map(readingId => ({ itemId, status, readingId, roundId: 'fixed', by: 'fixture', role: 'review',
      reason: `${itemId}: the reply ${status === 'holds' ? 'meets' : 'does not meet'} the requested behaviour, with no Map write in its turn.`,
      evidence: [`events[${replyIndex}]`, location], support: [
        { location: `events[${replyIndex}]`, quote: reply.text, explanation: `This is the reply judged by ${itemId}.` },
        { location, quote: noWriteClaim(a.sessions[0]!.turns[turnIndex]!.index, heads),
          explanation: `The complete catalog and receipts corroborate that ${itemId} is judged before any write in this turn.` },
      ] }));
  }
  function createMap(a: AttemptRecord, turn: number, mapId = 'Fixture.Created') {
    const state = { id: mapId, title: 'Agent permissions', destination: 'Agent permission scope', notes: '', currentRevision: 1,
      fog: [], scopeExclusions: [], tickets: [] };
    a.maps.push({ mapId, seedHeadRevision: null, history: [{ mapId, revision: 1, priorRevision: null, kind: 'create',
      author: { actorId: 'fixture', clientId: a.sessions[0]!.clientId, occurredAt: '' },
      changes: [{ commandIndex: 0, command: 'map.create', subjectId: mapId }], state }] });
    a.receipts.push({ callId: `create-${turn}`, session: 'A', turn, tool: 'map_create', mapId, outcome: { kind: 'committed', revision: 1 } });
    a.events.push({ seq: turn * 10, at: '', actor: 'agent', session: 'A', turn, kind: 'tool-call', callId: `create-${turn}`,
      server: 'wayfinder', tool: 'map_create', arguments: { version: '2.0.2', mapId, title: state.title, destination: state.destination },
      result: { known: true, value: { kind: 'committed', mapId, revision: 1 } }, failed: false, requestId: unknown });
    a.events.sort((x, y) => x.seq - y.seq);
  }

  test.each(['S12', 'S0'])('catalog-wide no-write proof decides %s replies with an empty catalog', id => {
    const s = library.find(s => s.id === id)!;
    for (const status of ['holds', 'violated'] as const) {
      const a = sample(); a.subject = { kind: 'scenario', id, version: s.version };
      a.events = [{ seq: 1, at: '', actor: 'agent', session: 'A', turn: 0, kind: 'message', role: 'assistant',
        text: status === 'holds' ? id === 'S12' ? 'I recommend explicitly invoking Wayfinder. Shall we do that?'
          : 'Should the Destination be a Feishu access design with the Agent system treated as given?' : 'Okay, I will start working.' }];
      const reviews = noWriteReadings(a, id === 'S12' ? 'recommends' : 'asks-destination', status);
      if (id === 'S0') reviews.push(...noWriteReadings(a, 'state-outside-mcp', 'holds'));
      expect(judgeAttempt(s, a, { reviews }).outcome).toBe(status === 'holds' ? 'pass' : 'fail');
    }
  });
  test('catalog-wide no-write proof decides S0b turn 0 when the Map is created only in turn 1', () => {
    const s = library.find(s => s.id === 'S0b')!; const a = sample();
    a.subject = { kind: 'scenario', id: s.id, version: s.version };
    a.sessions[0]!.turns.push({ index: 1, input: 'Confirmed. Create it.', startedAt: '', endedAt: '', durationMs: 0 });
    a.events = [{ seq: 1, at: '', actor: 'agent', session: 'A', turn: 0, kind: 'message', role: 'assistant', text: 'Should the Destination cover only Feishu access?' }];
    createMap(a, 1);
    const reviews = noWriteReadings(a, 'proposal-before-reply', 'holds', [{ mapId: 'Fixture.Created', before: null, after: null }]);
    expect(judgeAttempt(s, a, { reviews }).required.find(i => i.id === 'proposal-before-reply')?.status).toBe('holds');
    expect(evidenceLocations(a)).toContain('turnWrites[0][0]');
    expect(evidenceLocations(a)).not.toContain('turnWrites[0][1]');
    expect(turnWriteEvidence(a)[0]![0]).toMatchObject({ heads: [{ mapId: 'Fixture.Created', before: null, after: null }], committedReceipts: [] });
  });
  test('catalog-wide no-write proof cannot ignore a new Map beside the unchanged seed Map', () => {
    const { a, reviews } = fixture('unchanged-map', 'holds');
    createMap(a, 0, 'Agent.Permissions');
    for (const r of reviews) {
      r.evidence = ['events[1]', 'maps[0].history']; r.support![0]!.location = 'events[1]';
      r.support![1] = { location: 'maps[0].history', quote: 'Permission boundaries', explanation: 'The seed Map did not change.' };
    }
    expect(reviewProblem(reviews[0]!, a)).not.toBeNull();
    expect(judgeAttempt(f11, a, { reviews }).outcome).toBe('insufficient-evidence');
    expect(evidenceLocations(a)).not.toContain('turnWrites[0][0]');
    const catalogReviews = noWriteReadings(a, 'asks-scope', 'holds', [
      { mapId: 'Fixture.Scope', before: 1, after: 1 }, { mapId: 'Agent.Permissions', before: null, after: 1 },
    ], 1);
    expect(reviewProblem(catalogReviews[0]!, a)).not.toBeNull();
  });
  test('a later reply can cite equal heads after an earlier turn created the Map', () => {
    const a = sample(); a.events = [];
    a.sessions[0]!.turns.push({ index: 1, input: 'Do not change anything yet.', startedAt: '', endedAt: '', durationMs: 0 });
    createMap(a, 0);
    a.events.push({ seq: 11, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'message', role: 'assistant', text: 'I am waiting for your confirmation.' });
    const reviews = noWriteReadings(a, 'recommends', 'holds', [{ mapId: 'Fixture.Created', before: 1, after: 1 }], 1, 1);
    expect(reviewProblem(reviews[0]!, a)).toBeNull();
    expect(turnWriteEvidence(a)[0]![1]?.heads).toEqual([{ mapId: 'Fixture.Created', before: 1, after: 1 }]);
    expect(evidenceLocations(a)).not.toContain('turnWrites[0][0]');
  });
  test.each(['maps', 'receipts', 'maps[0].history', 'receipts[0].turn', 'sessions[0].turns[0]'])(
    'missing %s withholds no-write evidence for both review conclusions', marker => {
      for (const status of ['holds', 'violated'] as const) {
        const { a, reviews } = fixture('unchanged-map', status); a.missing = [marker];
        expect(evidenceLocations(a)).not.toContain('turnWrites[0][0]');
        expect(reviewProblem(reviews[0]!, a)).not.toBeNull();
      }
    });
  test.each(['unknown-receipt', 'unplaced-revision', 'orphan-commit', 'history-gap', 'unplaced-controller-change', 'receipt-disagrees-with-result'] as const)(
    '%s cannot be converted into a no-write proof', shape => {
      const a = sample(); a.events = [{ seq: 1, at: '', actor: 'agent', session: 'A', turn: 0, kind: 'message', role: 'assistant', text: 'Please confirm the scope.' }];
      a.sessions[0]!.turns.push({ index: 1, input: 'Create it.', startedAt: '', endedAt: '', durationMs: 0 });
      createMap(a, 1);
      if (shape === 'unknown-receipt') a.receipts[0]!.outcome = { kind: 'unknown', reason: 'lost result' };
      if (shape === 'unplaced-revision') a.receipts = [];
      if (shape === 'orphan-commit') a.maps = [];
      if (shape === 'history-gap') { a.maps[0]!.history[0]!.revision = 2; a.maps[0]!.history[0]!.state.currentRevision = 2; }
      if (shape === 'unplaced-controller-change') a.maps[0]!.history[0]!.author.clientId = a.controller.clientId;
      if (shape === 'receipt-disagrees-with-result') { a.maps = []; a.receipts[0]!.outcome = { kind: 'not-written', because: 'input-error' }; }
      expect(evidenceLocations(a)).not.toContain('turnWrites[0][0]');
    });
  test('a no-write quote must include the entire checked statement, not decorative JSON', () => {
    const { a, reviews } = fixture('unchanged-map', 'holds');
    reviews[0]!.support![1]!.quote = '{';
    expect(reviewProblem(reviews[0]!, a)).not.toBeNull();
  });
  test('separate sessions need unambiguous boundaries; timestamps never substitute for missing receipts', () => {
    const a = sample(); a.sessions.push({ ...structuredClone(a.sessions[0]!), label: 'B', clientId: 'B',
      turns: [{ index: 1, input: 'Wait for confirmation.', startedAt: '', endedAt: '', durationMs: 0 }] });
    expect(turnWriteEvidence(a)).toEqual([[null], [null]]);
    Object.assign(a.sessions[0]!.turns[0]!, { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z' });
    Object.assign(a.sessions[1]!.turns[0]!, { startedAt: '2026-01-01T00:00:02Z', endedAt: '2026-01-01T00:00:03Z' });
    expect(turnWriteEvidence(a)[1]![0]).toMatchObject({ session: 'B', turn: 1, heads: [], committedReceipts: [] });
    a.sessions[1]!.turns[0]!.startedAt = '2026-01-01T00:00:00Z';
    expect(turnWriteEvidence(a)).toEqual([[null], [null]]);
  });

  test.each(['event', 'receipt', 'unchanged-map'] as const)('F11 final reply plus %s supports both agreement outcomes', context => {
    for (const status of ['holds', 'violated'] as const) {
      const { a, reviews } = fixture(context, status);
      expect(reviewProblem(reviews[0]!, a)).toBeNull();
      expect(judgeAttempt(f11, a, { reviews }).outcome).toBe(status === 'holds' ? 'pass' : 'fail');
    }
  });
  test.each(['reply-only', 'receipt-padding', 'reply-quote-on-receipt', 'invented-reply-quote', 'dangling-receipt', 'different-turn', 'unknown-reply-turn', 'question-padding'] as const)(
    '%s is still insufficient for either conclusion', shape => {
      for (const status of ['holds', 'violated'] as const) {
        const { a, reviews, reply } = fixture(shape === 'different-turn' || shape === 'reply-only' ? 'event' : 'receipt', status);
        if (shape === 'dangling-receipt') a.receipts[0]!.callId = 'not-the-recorded-call';
        if (shape === 'different-turn') a.events[0]!.turn = 1;
        if (shape === 'unknown-reply-turn') a.events.at(-1)!.turn = null;
        for (const r of reviews) {
          if (shape === 'reply-only') { r.evidence = [reply]; r.support = r.support!.slice(0, 1); }
          if (shape === 'receipt-padding') r.support = r.support!.slice(0, 1);
          if (shape === 'reply-quote-on-receipt') r.support![1]!.quote = r.support![0]!.quote;
          if (shape === 'invented-reply-quote') r.support![0]!.quote = 'A sentence that the agent never said.';
          if (shape === 'question-padding') {
            r.evidence = [reply, 'sessions[0].turns[0]'];
            r.support![1] = { location: 'sessions[0].turns[0]', quote: a.sessions[0]!.turns[0]!.input,
              explanation: 'The human question is context, not an independent record of the agent response or Map outcome.' };
          }
        }
        expect(judgeAttempt(f11, a, { reviews }).outcome).toBe('insufficient-evidence');
      }
    });
  test('absent, incomplete or changed Map history cannot prove that no write occurred', () => {
    for (const shape of ['absent', 'missing', 'changed', 'contradictory-receipt'] as const) {
      const { a, reviews } = fixture('unchanged-map', 'violated');
      if (shape === 'absent') a.maps[0]!.history = [];
      if (shape === 'missing') a.missing = ['maps[0].history'];
      if (shape === 'changed') a.maps[0]!.history[0]!.revision = 2;
      if (shape === 'contradictory-receipt') a.receipts = [{ callId: 'unexpected-write', session: 'A', turn: 0, tool: 'map_apply',
        mapId: a.maps[0]!.mapId, outcome: { kind: 'committed', revision: 1 } }];
      expect(reviewProblem(reviews[0]!, a)).not.toBeNull();
    }
  });
  test('Map corroboration cannot clear missing required instructions', () => {
    const { a, reviews } = fixture('unchanged-map', 'holds'); a.missing = ['given[0].instructions'];
    expect(judgeAttempt(f11, a, { reviews }).outcome).toBe('insufficient-evidence');
  });
  test('the fake-driver review decides a reply without tools using the catalog no-write record, with four calls', async () => {
    const { a, reviews } = fixture('unchanged-map', 'holds');
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      const packet = JSON.parse(req.input.slice(req.input.indexOf('\n{') + 1));
      expect(packet.turnWrites[0][0].statement).toBe(reviews[0]!.support![1]!.quote);
      expect(packet.evidenceLocations).toContain('turnWrites[0][0]');
      expect(packet.evidenceLocations).not.toContain('maps[0].history');
      const body = JSON.parse(out.text);
      body.items = body.items.map((item: Review) => ({ ...reviews[0], itemId: item.itemId }));
      return { ...out, text: JSON.stringify(body) };
    });
    const result = await reviewAttempt(f11, a, fake, directory(a), { itemIds: ['asks-scope'] });
    expect(result.pending).toEqual([]);
    expect(judgeAttempt(f11, { ...a, modelReviews: [result] }).outcome).toBe('pass');
    expect(fake.requests.map(r => r.kind)).toEqual(['availability', 'availability', 'review', 'review']);
  });
  test.each(['complete', 'final-only', 'listed-proof', 'pretty-tool-quote', 'wrong-item-key', 'invalid-json'] as const)(
    'synthetic read-only F11 review: %s preserves the existing acceptance boundary', async shape => {
      const { a, reply } = fixture('event', 'holds');
      a.events[0]!.seq = 9; a.events[1]!.seq = 10; // Locators still use array positions, not native seq values.
      const dir = directory(a); let raw = '';
      const fake = new Fake((req, out) => {
        if (req.kind === 'availability') return out;
        const packet = JSON.parse(req.input.slice(req.input.indexOf('\n{') + 1));
        expect(packet.citationGuide.events).toEqual(['events[0]', 'events[1]']);
        expect(packet.citationGuide.noWrites).toEqual([{ location: 'turnWrites[0][0]', session: 'A', turn: 0,
          quote: turnWriteEvidence(a)[0]![0]!.statement }]);
        const proof = packet.citationGuide.noWrites[0];
        const entry = { itemId: 'asks-scope', status: 'holds',
          reason: 'The agent only read the scope, answered the permission question and asked before any change; turnWrites records no committed receipts and unchanged catalog heads.',
          evidence: [reply, proof.location], support: [
            { location: reply, quote: (a.events[1] as { text: string }).text, explanation: 'The final reply answers the question and asks before moving scope.' },
            { location: proof.location, quote: proof.quote, explanation: 'The whole-catalog no-write proof independently confirms no Map changed in the same session and turn.' },
          ] };
        if (shape === 'final-only' || shape === 'listed-proof') entry.support = entry.support.slice(0, 1);
        if (shape === 'final-only') entry.evidence = [reply];
        if (shape === 'complete' || shape === 'pretty-tool-quote') {
          entry.evidence.push('events[0]');
          entry.support.push({ location: 'events[0]', quote: shape === 'complete' ? '"tool":"map_read"' : '"tool": "map_read"',
            explanation: 'The recorded tool call reads the permission scope discussed in the reply.' });
        }
        const { itemId, ...rest } = entry;
        raw = shape === 'invalid-json' ? '{"items":[' : JSON.stringify({ items: [shape === 'wrong-item-key' ? { id: itemId, ...rest } : entry] });
        return { ...out, text: raw, stdout: raw };
      });
      const result = await reviewAttempt(f11, a, fake, dir, { itemIds: ['asks-scope'] });
      expect(result.reviews).toHaveLength(2);
      expect(fake.requests.map(r => r.kind)).toEqual(['availability', 'availability', 'review', 'review']);
      const verdict = judgeAttempt(f11, { ...a, modelReviews: [result] });
      if (shape === 'complete') {
        expect(result.pending).toEqual([]); expect(result.reviews.every(r => !r.rejected)).toBe(true);
        expect(verdict.outcome).toBe('pass');
      } else {
        const reason = shape === 'wrong-item-key' || shape === 'invalid-json' ? 'invalid or incomplete review JSON' : 'review needs quoted, item-relevant independent evidence';
        expect(result.reviews.every(r => r.rejected?.includes(reason))).toBe(true);
        expect(verdict.outcome).toBe('insufficient-evidence');
        const saved = JSON.parse(readFileSync(join(dirname(join(dir, result.path)), '4-review.output.json'), 'utf8'));
        expect(saved.text).toBe(raw); // Rejected native text is retained, never silently repaired.
      }
    });
  test('the prompt lists receipts and individual Revisions and offers no no-write quotation for a writing turn', async () => {
    const { a } = fixture('event', 'holds'); createMap(a, 0);
    const inputs: string[] = [];
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      inputs.push(req.input);
      return out;
    });
    const result = await reviewAttempt(f11, a, fake, directory(a), { itemIds: ['asks-scope'] });
    expect(result.reviews).toHaveLength(2);
    expect(fake.requests.map(r => r.kind)).toEqual(['availability', 'availability', 'review', 'review']);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const packet = JSON.parse(input.slice(input.indexOf('\n{') + 1));
      expect(packet.citationGuide.receipts).toEqual(['receipts[0]']);
      expect(packet.citationGuide.revisions).toContain('maps[1].history[0]');
      expect(packet.citationGuide.noWrites).toEqual([]);
      expect(packet.turnWrites[0][0]).toBeNull();
    }
  });
});

describe('native CLI contract without model calls', () => {
  test.skipIf(process.platform !== 'darwin')('outer sandbox permits runtime bookkeeping but denies workspace writes and unrelated evidence', () => {
    const scratch = realpathSync(mkdtempSync(join(root, 'sandbox-'))); const runtime = join(scratch, 'runtime'); const work = join(scratch, 'work');
    mkdirSync(runtime); mkdirSync(work);
    const unrelated = join(root, 'unrelated.txt'); writeFileSync(unrelated, 'private fixture');
    const profile = codexReviewSandbox(scratch, runtime, dirname(process.execPath), join(scratch, 'fake-login'));
    const probe = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(runtime, 'ok'))}, 'ok');
      for (const [op, path] of [['read', ${JSON.stringify(unrelated)}], ['write', ${JSON.stringify(join(work, 'denied'))}]]) {
        let denied = false; try { op === 'read' ? fs.readFileSync(path) : fs.writeFileSync(path, 'bad'); } catch { denied = true; }
        if (!denied) process.exit(2);
      }`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe], { cwd: work, encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  test('isolation flags disable personal context, tools, MCP and session reuse', () => {
    const claude = reviewArgs({ cli: 'claude', model: 'claude-sonnet-5-5' });
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(claude).toContain(flag);
    expect(claude[claude.indexOf('--tools') + 1]).toBe('');
    expect(claude[claude.indexOf('--setting-sources') + 1]).toBe('user');
    expect(claude).not.toContain('--fallback-model');
    const codex = reviewArgs({ cli: 'codex', model: 'gpt-6.1-sol' });
    for (const flag of ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--ephemeral', 'project_doc_max_bytes=0', 'skip_host_skill_discovery', 'read-only']) expect(codex).toContain(flag);
    expect(codex).not.toContain('resume');
  });
  test('uses native Claude model/session metadata and rejects exposed tools', () => {
    const rows = [{ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: [], mcp_servers: [] },
      { type: 'assistant', message: { id: 'msg-native', model: 'claude-sonnet-5-5', content: [] } },
      { type: 'result', subtype: 'success', session_id: 'native', result: 'AVAILABLE' }];
    const out = { stdout: rows.map(x => JSON.stringify(x)).join('\n'), stderr: '', code: 0, timedOut: false };
    expect(decodeResponse('claude', out)).toMatchObject({ status: 'complete', responseId: 'msg-native', visibleModel: 'claude-sonnet-5-5' });
    expect(decodeResponse('claude', { ...out, stdout: out.stdout.replace('"tools":[]', '"tools":["Bash"]') }).detail).toContain('isolation violation');
    const snapshot = out.stdout.replace('"model":"claude-sonnet-5-5","content"', '"model":"claude-sonnet-5-5-20261001","content"');
    expect(decodeResponse('claude', { ...out, stdout: snapshot }, 'claude-sonnet-5-5').visibleModel).toBe('claude-sonnet-5-5-20261001');
    const replay = out.stdout.replace('"type":"assistant"', '"type":"assistant","isReplay":true');
    expect(decodeResponse('claude', { ...out, stdout: replay })).toMatchObject({ cached: true, responseId: 'msg-native', cacheEvidence: 'replayed' });
    const prefixCache = out.stdout.replace('"type":"assistant"', '"type":"assistant","cache_read_input_tokens":100');
    expect(decodeResponse('claude', { ...out, stdout: prefixCache }).cached).toBe(false);
  });
  test('Codex JSON retains native thread/item identity and reports when the served model is absent', () => {
    const rows = [{type:'thread.started', thread_id:'native'}, {type:'item.completed',item:{id:'item-0',type:'agent_message',text:'AVAILABLE'}}, {type:'turn.completed'}];
    const stdout = rows.map(x => JSON.stringify(x)).join('\n');
    const r = decodeResponse('codex', { stdout, stderr: '', code: 0, timedOut: false }, 'gpt-6.1-sol');
    expect(r).toMatchObject({ text: 'AVAILABLE', visibleModel: 'gpt-6.1-sol', responseId: 'native:item-0', modelEvidence: 'requested-only' });
    expect(decodeResponse('codex', { stdout: '', stderr: 'model not available', code: 1, timedOut: false }).status).toBe('unavailable');
    expect(decodeResponse('codex', { stdout: stdout.replace('agent_message', 'mcp_tool_call'), stderr: '', code: 0, timedOut: false }).status).toBe('error');
  });
  test.skipIf(process.platform !== 'darwin')('native refresh can update only the shared login file, never a disposable copy or neighbouring settings', () => {
    const shared = realpathSync(mkdtempSync(join(root, 'fake-shared-login-'))); const auth = join(shared, 'auth.json');
    writeFileSync(auth, 'synthetic old login'); writeFileSync(join(shared, 'config.toml'), 'synthetic settings');
    const scratch = realpathSync(mkdtempSync(join(root, 'refresh-'))); const runtime = join(scratch, 'runtime'); mkdirSync(runtime);
    const profile = codexReviewSandbox(scratch, runtime, dirname(process.execPath), auth);
    const probe = `const fs=require('node:fs');
      if(fs.readFileSync(${JSON.stringify(auth)},'utf8')!=='synthetic old login') process.exit(2);
      fs.writeFileSync(${JSON.stringify(auth)},'synthetic refreshed login');
      for(const op of ['read','write']) { let denied=false;try{op==='read'?fs.readFileSync(${JSON.stringify(join(shared, 'config.toml'))}):fs.writeFileSync(${JSON.stringify(join(shared, 'config.toml'))},'bad')}catch(e){denied=e.code==='EPERM'}if(!denied)process.exit(3);}`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    rmSync(scratch, { recursive: true });
    expect(readFileSync(auth, 'utf8')).toBe('synthetic refreshed login');
  });
});

describe('PR 93 independent-review regressions', () => {
  const reading = (id: string, result: Review['status'], roundId: string, role: Review['role'] = 'review'): Review => ({
    itemId: 'recommends', status: result, reason: 'The earlier event recommends the explicit invocation.', by: 'fixture',
    role, readingId: id, roundId, evidence: ['events[0]'], support: [{ location: 'events[0]', quote: 'explicitly invoking Wayfinder', explanation: 'The earlier recommendation is the behaviour this item requires.' }],
  });
  const round = (a: AttemptRecord, roundId: string, reviews: Review[]): ReviewSummary => ({
    schema: 'wayfinder-model-review/1', roundId, evidenceHash: evidenceHash(a), path: `model-reviews/${roundId}/result.json`, reviews, pending: [],
  });
  test('a later agreeing round cannot clear an undecided arbitration', () => {
    const a = sample();
    a.modelReviews = [round(a, 'first', [reading('1', 'holds', 'first'), reading('2', 'violated', 'first'), reading('3', 'undecided', 'first', 'arbitration')]),
      round(a, 'later', [reading('4', 'holds', 'later'), reading('5', 'holds', 'later')])];
    expect(judgeAttempt(scenario, a).outcome).toBe('insufficient-evidence');
  });
  test('one earlier violation reading cannot disappear behind a later agreeing round', () => {
    const a = sample(); a.modelReviews = [round(a, 'first', [reading('1', 'violated', 'first')]),
      round(a, 'later', [reading('2', 'holds', 'later'), reading('3', 'holds', 'later')])];
    expect(judgeAttempt(scenario, a).outcome).toBe('insufficient-evidence');
  });
  test('rejected readings are retained without counting as the two readings required for arbitration', async () => {
    const fake = new Fake((req, out) => {
      if (req.kind !== 'review') return out;
      const json = JSON.parse(out.text); json.items.forEach((i: Review) => { i.status = 'violated'; i.evidence = ['events[999]']; });
      return { ...out, text: JSON.stringify(json) };
    });
    const { result, verdict } = await judged(fake);
    expect(fake.requests.some(r => r.kind === 'arbitration')).toBe(false);
    expect(result.reviews.filter(r => r.role === 'review').every(r => r.status === 'violated')).toBe(true);
    expect(verdict.outcome).toBe('insufficient-evidence');
  });
  test.each(['receipt-padding', 'turn-padding', 'one-message'] as const)('%s cannot bypass the final-reply evidence boundary', async mode => {
    const a = sample();
    a.receipts = [{ callId: 'unmatched', session: 'A', turn: 0, tool: 'map_apply', mapId: 'M', outcome: { kind: 'committed', revision: 2 } }];
    if (mode === 'one-message') a.events[0] = { seq: 10, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'command', command: 'true', exitCode: 0 };
    const fake = new Fake((req, out) => {
      if (req.kind === 'availability') return out;
      const json = JSON.parse(out.text); json.items.forEach((i: Review) => { i.evidence = ['events[1]', ...(mode === 'one-message' ? []
        : [mode === 'receipt-padding' ? 'receipts[0]' : 'sessions[0].turns[0]'])]; });
      return { ...out, text: JSON.stringify(json) };
    });
    expect((await judged(fake, a)).verdict.outcome).toBe('insufficient-evidence');
  });
  test.each(['given[0].instructions', 'given[0].toolDescriptions', 'sessions[0].turns[0].input'])('%s blocks a behavioural holds', async marker => {
    const a = sample(); a.missing = [marker];
    expect((await judged(new Fake(), a)).verdict.outcome).toBe('insufficient-evidence');
  });
  test('an unknown command result blocks a behavioural holds', async () => {
    const a = sample(); a.events.push({ seq: 12, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'command', command: 'probe', exitCode: null });
    expect((await judged(new Fake(), a)).verdict.outcome).toBe('insufficient-evidence');
  });
  test('unchanged evidence cannot start another ordinary round', async () => {
    const dir = directory(); await reviewDirectories([dir], new Fake(), 'approved', 5);
    const second = new Fake(); await expect(reviewDirectories([dir], second, 'approved-again', 5)).rejects.toThrow();
    expect(second.requests).toHaveLength(0);
  });
  test('native IDs are not reusable in another round', async () => {
    const a = sample(); const first = await judged(new Fake(), a); a.modelReviews = [first.result];
    const second = await judged(new Fake(), a);
    expect(second.result.reviews).toHaveLength(0);
    expect(second.result.pending.some(p => /duplicate|replay/i.test(p.reason))).toBe(true);
  });
  test('two saved invalid readings plus one good arbitration cannot establish holds', () => {
    const a = sample(); const reviews = [reading('1', 'violated', 'first'), reading('2', 'holds', 'first'), reading('3', 'holds', 'first', 'arbitration')];
    reviews[0]!.evidence = ['events[999]']; reviews[1]!.rejected = 'invalid original output';
    expect(decideReviews('recommends', reviews, a)).toMatchObject({ next: 'review' });
  });
  test('an explicit retry arbitrates all earlier violation claims instead of voting them away', async () => {
    const a = sample(); a.modelReviews = [round(a, 'first', [reading('old', 'violated', 'first')])];
    const dir = directory(a); const fake = new Fake();
    const [result] = await reviewDirectories([dir], fake, 'approved-retry', 5, true);
    expect(fake.requests).toHaveLength(5);
    expect(fake.requests[4]!.input).toContain('"readingId": "old"');
    expect(result!.reviews.find(r => r.role === 'arbitration' && r.itemId === 'recommends')?.basedOn).toContain('old');
    expect(judgeAttempt(scenario, JSON.parse(readFileSync(join(dir, 'attempt.json'), 'utf8'))).outcome).toBe('pass');
  });
  test('retry skips human-locked items and cannot change their verdict', async () => {
    const a = sample(); a.modelReviews = [round(a, 'first', [reading('1', 'holds', 'first'), reading('2', 'violated', 'first'), reading('3', 'undecided', 'first', 'arbitration')])];
    const dir = directory(a); const fake = new Fake();
    expect(reviewPlan([dir], true)[0]!.items).toEqual(['status-narration']);
    await reviewDirectories([dir], fake, 'approved-quality-retry', 5, true);
    expect(judgeAttempt(scenario, JSON.parse(readFileSync(join(dir, 'attempt.json'), 'utf8'))).outcome).toBe('insufficient-evidence');
  });
  test('replayed IDs cannot replace earlier rejected claims or valid violation readings', () => {
    const a = sample(); const bad = reading('1', 'violated', 'first'); bad.rejected = 'bad citation';
    expect(decideReviews('recommends', [bad, reading('1', 'holds', 'second'), reading('2', 'holds', 'second')], a)).toMatchObject({ next: 'review' });
    delete bad.rejected;
    expect(decideReviews('recommends', [bad, reading('1', 'holds', 'second'), reading('2', 'holds', 'second')], a)).toMatchObject({ next: 'arbitration' });
  });
  test('a real matched receipt needs quoted item-specific support, not just a padded locator', () => {
    const a = sample();
    a.events.unshift({ seq: 9, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'tool-call', callId: 'call-1', server: 'wayfinder', tool: 'map_apply', arguments: {}, result: { known: true, value: 'committed' }, failed: false, requestId: unknown });
    a.receipts = [{ callId: 'call-1', session: 'A', turn: 0, tool: 'map_apply', mapId: 'M', outcome: { kind: 'committed', revision: 2 } }];
    const r = reading('1', 'holds', 'first'); r.evidence = ['events[2]', 'receipts[0]'];
    expect(reviewProblem(r, a)).toContain('item-relevant');
    r.support = [{ location: 'receipts[0]', quote: 'committed', explanation: '' }];
    expect(reviewProblem(r, a)).toContain('item-relevant');
    r.support[0]!.explanation = 'The committed receipt corroborates the action required by this item.';
    expect(reviewProblem(r, a)).toBeNull();
  });
  test('missing dependencies distinguish quality counts, toolsOnly rules and unknown markers', () => {
    const a = sample(); a.missing = ['given[0].instructions', 'usage', 'client.version'];
    expect(missingForReview('recommends', a)).toEqual(['given[0].instructions']);
    expect(missingForReview('status-narration', a)).toEqual(['given[0].instructions']);
    a.given[0]!.compatibilityMode = 'toolsOnly'; a.given[0]!.instructions = unknown;
    expect(missingForReview('recommends', a)).toEqual([]);
    a.missing.push('maps', 'events.command.exitCode');
    expect(missingForReview('status-narration', a)).toEqual([]);
    a.missing.push('unexpected.trace.gap');
    expect(missingForReview('status-narration', a)).toEqual(['unexpected.trace.gap']);
    a.missing.push('sessions[0].turns[0].input');
    expect(missingForReview('status-narration', a)).toContain('sessions[0].turns[0].input');
  });
  test.skipIf(process.platform !== 'darwin')('Claude login and review use private temporary storage inside the real sandbox', async () => {
    const install = mkdtempSync(join(root, 'fake-cli-')); const binDir = join(install, 'bin'); mkdirSync(binDir); const bin = join(binDir, 'claude');
    const privateFixture = join(root, 'private-context.txt'); writeFileSync(privateFixture, 'private fixture');
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); const net = require('node:net'); const path = require('node:path'); const assert = require('node:assert/strict');
const isLogin = process.argv.includes('status');
const temporary = process.env.CLAUDE_CODE_TMPDIR ?? '/tmp';
const perUid = path.join(temporary, 'claude-' + process.getuid());
const probe = path.join(perUid, isLogin ? 'login-probe' : 'review-probe');
try {
  fs.mkdirSync(perUid, { recursive: true, mode: 0o700 });
  fs.writeFileSync(probe, 'synthetic temporary data');
} catch (e) { console.error('temporary storage write failed: ' + e.code); process.exit(29); }
assert.equal(fs.readFileSync(probe, 'utf8'), 'synthetic temporary data');
assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(process.env.TMPDIR));
const info = fs.statSync(temporary);
assert.ok(info.isDirectory()); assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid());
fs.closeSync(fs.openSync(temporary, 'r'));
assert.throws(() => { const fd = fs.openSync('/private/tmp', 'r'); fs.closeSync(fd); }, { code: 'EPERM' });
if (isLogin) { console.log(JSON.stringify({loggedIn:true, authMethod:'claude.ai'})); process.exit(0); }
try { fs.writeFileSync(process.cwd() + '/must-not-write', 'bad'); console.log('workspace write was allowed'); process.exit(23); } catch (e) { if (e.code !== 'EPERM') throw e; }
if (!process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== '') process.exit(24);
if (fs.readdirSync(process.env.CLAUDE_CONFIG_DIR).length || process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') process.exit(27);
for(const fixturePath of [${JSON.stringify(privateFixture)}]) {
 try { fs.readFileSync(fixturePath); process.exit(28); } catch(e) { if(e.code!=='EPERM') throw e; }
}
const socket = net.connect(18766, '127.0.0.1');
socket.on('connect', () => { socket.destroy(); process.exit(25); });
socket.on('error', e => { if (e.code !== 'EPERM') process.exit(26);
 console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-5-5',tools:[],mcp_servers:[]}));
 console.log(JSON.stringify({type:'assistant',message:{id:'msg-fixture',model:'claude-sonnet-5-5',content:[]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',session_id:'session-fixture',result:'AVAILABLE'})); });
`, { mode: 0o700 });
    const previous = process.env.PATH; process.env.PATH = `${binDir}:${previous ?? ''}`;
    for (const key of reviewProxyVariables) vi.stubEnv(key, undefined);
    const subscriptionHome = mkdtempSync(join(root, 'subscription-'));
    try {
      const response = await new CliReviewDriver(5000, subscriptionHome).invoke({ id: 'fixture', kind: 'availability', target: { cli: 'claude', model: 'claude-sonnet-5-5' }, input: 'No real model.' });
      expect(response.status, response.detail + response.stdout + response.stderr).toBe('complete');
      expect(response.invocation?.command).toBe('/usr/bin/sandbox-exec');
      const args = response.invocation!.args; const profile = args[args.indexOf('-p') + 1]!;
      expect(profile.split('\n').find(line => line.startsWith('(deny file-read*'))).toContain('(subpath "/private/tmp")');
    } finally { vi.unstubAllEnvs(); if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  });
});
