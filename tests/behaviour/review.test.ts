// Fixed evidence and fake review drivers only. No model generations, credentials or everyday services.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { attemptSchema } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { library } from './library.ts';
import { buildReport, renderMarkdown } from './report.ts';
import { codexReviewSandbox, decodeResponse, reviewArgs } from './review-cli.ts';
import { reviewDirectories, reviewPlan } from './review-run.ts';
import { reviewAttempt, reviewersFor, reviewItems } from './review.ts';
import type { ReviewDriver, ReviewRequest, ReviewResponse } from './review.ts';
import type { Review } from './reviews.ts';
import { judgeAttempt } from './verdict.ts';

const root = mkdtempSync(join(tmpdir(), 'wayfinder-review-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scenario = library.find(s => s.id === 'S12')!;
const unknown = { known: false as const, reason: 'synthetic fixture' };
function sample(): AttemptRecord {
  return { schema: attemptSchema, attemptId: 'B/S12-1', batchId: 'B', subject: { kind: 'scenario', id: 'S12', version: scenario.version }, entry: 'mcp-only',
    combination: { harness: 'codex', requestedModel: 'gpt-6-astra', visibleModel: { known: true, value: 'gpt-6-astra' }, effort: { known: true, value: 'xhigh' } },
    client: { version: unknown, surface: unknown }, service: { commit: 'fixture', series: 'release', version: '2.0.2' }, given: [],
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
      status: 'holds', reason: 'The recommendation appears at event 10 before the final waiting message.', evidence: ['events[0]'] })) });
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
    expect(result.pending.some(p => p.next === 'human')).toBe(true);
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
    expect(result.pending[0]!.reason).toContain('recorded agent activity');
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
    await reviewDirectories([dirs[0]!], new Fake(), 'approved-retry', 5);
    expect(JSON.parse(readFileSync(join(dirs[0]!, 'attempt.json'), 'utf8')).modelReviews).toHaveLength(2);
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
    expect(claude[claude.indexOf('--setting-sources') + 1]).toBe('');
    expect(claude).not.toContain('--fallback-model');
    const codex = reviewArgs({ cli: 'codex', model: 'gpt-6.1-sol' });
    for (const flag of ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--ephemeral', 'project_doc_max_bytes=0', 'skip_host_skill_discovery', 'read-only']) expect(codex).toContain(flag);
    expect(codex).not.toContain('resume');
  });
  test('uses native Claude model/session metadata and rejects exposed tools', () => {
    const rows = [{ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: [], mcp_servers: [] },
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } },
      { type: 'result', subtype: 'success', session_id: 'native', result: 'AVAILABLE' }];
    const out = { stdout: rows.map(x => JSON.stringify(x)).join('\n'), stderr: '', code: 0, timedOut: false };
    expect(decodeResponse('claude', out)).toMatchObject({ status: 'complete', responseId: 'native', visibleModel: 'claude-sonnet-5-5' });
    expect(decodeResponse('claude', { ...out, stdout: out.stdout.replace('"tools":[]', '"tools":["Bash"]') }).detail).toContain('isolation violation');
  });
  test('Codex native model/session header is required by the review layer', () => {
    const r = decodeResponse('codex', { stdout: 'AVAILABLE', stderr: 'model: gpt-6.1-sol\nsession id: native\n', code: 0, timedOut: false });
    expect(r).toMatchObject({ text: 'AVAILABLE', visibleModel: 'gpt-6.1-sol', responseId: 'native' });
    expect(decodeResponse('codex', { stdout: '', stderr: 'model not available', code: 1, timedOut: false }).status).toBe('unavailable');
  });
});
