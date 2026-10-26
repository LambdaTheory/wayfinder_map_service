// Fixed evidence for the verdict branches of B03a: no record turns into a pass by being incomplete, unreviewed or
// unattributable, and a violation already seen survives missing evidence.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { attemptSchema } from './evidence.ts';
import type { AttemptRecord, EventRecord, GivenRules, Receipt, WireRevision, WireState } from './evidence.ts';
import { library } from './library.ts';
import { buildReport, compare, renderMarkdown } from './report.ts';
import type { Report } from './report.ts';
import type { SeedMap } from './scenario.ts';
import { asScenario, upgradeChecks } from './upgrade-checks.ts';
import { judgeAttempt, judgeCell } from './verdict.ts';
import type { Review } from './verdict.ts';

const byId = (id: string) => library.find(s => s.id === id)!;
const unknownField = { known: false as const, reason: 'sample' };

function stateOf(map: SeedMap, revision: number): WireState {
  return { id: map.mapId, title: map.title, destination: map.destination, notes: map.notes, currentRevision: revision,
    fog: (map.fog ?? []).map(c => ({ id: c.id, text: c.text, references: c.references ?? [] })),
    scopeExclusions: (map.scopeExclusions ?? []).map(c => ({ id: c.id, text: c.text, references: c.references ?? [] })),
    tickets: map.tickets.map(t => ({ id: t.id, title: t.title, question: t.question, type: t.type, prerequisites: t.prerequisites ?? [],
      status: t.settlement ? 'settled' as const : 'open' as const, claim: t.claim ?? null, ...(t.settlement ? { settlement: t.settlement } : {}) })) };
}

interface AgentWrite { changes: WireRevision['changes']; edit?: (s: WireState) => WireState; session?: string; turn?: number; receipt?: boolean }

/** A record of one Attempt: the seed as Revision 1, then the agent's writes, each with a receipt unless told otherwise. */
function sample(scenarioId: string, writes: AgentWrite[] = [], over: Partial<AttemptRecord> = {}, mapIndex = 0): AttemptRecord {
  const s = byId(scenarioId);
  const seed = s.seed.maps[mapIndex];
  const labels = [...new Set(s.turns.map(t => t.session))];
  const history: WireRevision[] = [];
  let state = seed ? stateOf(seed, 1) : null;
  if (seed) history.push({ mapId: seed.mapId, revision: 1, priorRevision: null, kind: 'create', author: { actorId: 'r', clientId: 'Behaviour-Controller', occurredAt: '' }, changes: [], state: state! });
  const receipts: Receipt[] = [];
  for (const w of writes) {
    const revision = history.length + 1;
    const session = w.session ?? 'A';
    state = { ...(w.edit ? w.edit(state ?? stateOf({ mapId: 'New.Map', title: 't', destination: 'd', notes: '', tickets: [] }, revision)) : state!), currentRevision: revision };
    const mapId = state.id;
    history.push({ mapId, revision, priorRevision: revision - 1 || null, kind: w.changes.some(c => c.command === 'map.create') ? 'create' : 'apply',
      author: { actorId: 'r', clientId: `agent-${session}`, occurredAt: '' }, changes: w.changes, state });
    if (w.receipt !== false) receipts.push({ callId: `c${revision}`, session, turn: w.turn ?? 0, tool: 'map_apply', mapId, outcome: { kind: 'committed', revision } });
  }
  const mapId = history[0]?.mapId;
  return {
    schema: attemptSchema, attemptId: `T/${scenarioId}`, batchId: 'T', subject: { kind: 'scenario', id: s.id, version: s.version }, entry: 'mcp-only',
    combination: { harness: 'codex', requestedModel: 'm', visibleModel: { known: true, value: 'm' }, effort: unknownField },
    client: { version: unknownField, surface: unknownField }, service: { commit: 'c', series: 'release', version: '2.0.2' },
    given: [{ phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.0.2' },
      instructions: { known: true, value: 'captured instructions' }, toolDescriptions: { known: true, value: { map_apply: 'In this release every Ticket title begins with \"v2: \".' } }, resources: 'available', prompts: 'available', extraContext: [] }],
    run: { startedAt: '', endedAt: '', completeness: 'complete' }, controller: { clientId: 'Behaviour-Controller' }, baitClientIds: [],
    sessions: labels.map(label => ({ label, nativeId: unknownField, clientId: `agent-${label}`, mcpSessionIds: unknownField, turns: [] })),
    events: [{ seq: 0, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'I recommend the explicit invocation.' }, { seq: 1, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'message', role: 'assistant', text: 'Waiting for your choice.' }],
    maps: mapId ? [{ mapId, seedHeadRevision: seed ? 1 : null, history }] : [], receipts, usage: unknownField, raw: { path: `T/${scenarioId}/raw`, files: [] }, missing: [],
    ...over,
  };
}

const call = (seq: number, tool: string, result: unknown, extra: Partial<{ session: string; turn: number; args: unknown }> = {}): EventRecord =>
  ({ seq, at: '', session: extra.session ?? 'A', turn: extra.turn ?? 0, actor: 'agent', kind: 'tool-call', callId: `e${seq}`, server: 'wayfinder', tool,
     arguments: extra.args ?? {}, result: result === undefined ? unknownField : { known: true, value: result }, failed: false, requestId: unknownField });
const holdsAll = (...ids: string[]): Review[] => ids.flatMap(itemId => (['first', 'second'] as const).map(by => ({ itemId, status: 'holds' as const, reason: 'sample review', by, role: 'review' as const, readingId: by, evidence: ['events[0]'], support: [{ location: 'events[0]', quote: 'explicit invocation', explanation: 'This earlier recommendation supports the requested item.' }] })));
const createdMap: AgentWrite = { changes: [{ commandIndex: 0, command: 'map.create', subjectId: 'New.Map' }], edit: s => s };

describe('Attempt verdicts on fixed evidence', () => {
  test('correct pass: script items hold and reviews decide the model items', () => {
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: holdsAll('recommends', 'status-narration') }).outcome).toBe('pass');
  });

  test('without the review the same Attempt is insufficient evidence, not a pass', () => {
    expect(judgeAttempt(byId('S12'), sample('S12')).outcome).toBe('insufficient-evidence');
  });

  test('clear violation fails', () => {
    const v = judgeAttempt(byId('S12'), sample('S12', [createdMap]), { reviews: holdsAll('recommends') });
    expect(v.outcome).toBe('fail');
    expect(v.reasons.join()).toMatch(/created-map/);
  });

  test('positive outcome incomplete: the answer persisted but the open part was not kept', () => {
    const settled: AgentWrite = { turn: 1, changes: [{ commandIndex: 0, command: 'ticket.settle', subjectId: 'task-carrier' }], edit: s => ({ ...s,
      tickets: s.tickets.filter(t => t.id === 'task-carrier').map(t => ({ ...t, status: 'settled' as const,
        settlement: { outcome: { kind: 'decision' as const, statement: '用多维表格。', rationale: 'Kun 的答复' }, evidence: [{ statement: 'Kun', references: [] }], references: [], provenance: { method: 'm', sources: [] } } })) }) };
    const v = judgeAttempt(byId('S9'), sample('S9', [settled]), { reviews: holdsAll('proposal-before-reply', 'decided-fields', 'no-chat-in-question-or-notes', 'attributable-evidence') });
    expect(v.outcome).toBe('fail');
    expect(v.reasons).toEqual(['expectation fields-open not met']);
  });

  test('a Conflict that never happened leaves S6 incomplete, whatever else held', () => {
    const v = judgeAttempt(byId('S6'), sample('S6', [], { events: [call(1, 'map_apply', { kind: 'committed', mapId: 'feishu-access-20261022', revision: 2, changes: [] })] }));
    expect(v.outcome).toBe('incomplete');
    expect(v.reasons.join()).toMatch(/required event conflict-observed did not happen/);
  });

  test('a missing result file is incomplete', () => {
    expect(judgeAttempt(byId('S0b'), null, { attemptId: 'T/S0b-1' })).toMatchObject({ outcome: 'incomplete', completeness: 'no-record' });
  });

  test('partial success then timeout is incomplete; a violation before the timeout still fails', () => {
    expect(judgeAttempt(byId('S9'), sample('S9', [], { run: { startedAt: '', endedAt: '', completeness: 'timeout' } })).outcome).toBe('incomplete');
    const early: AgentWrite = { turn: 0, changes: [{ commandIndex: 0, command: 'ticket.settle', subjectId: 'task-carrier' }], edit: s => s };
    const v = judgeAttempt(byId('S9'), sample('S9', [early], { run: { startedAt: '', endedAt: '', completeness: 'timeout' } }));
    expect(v.outcome).toBe('fail');
    expect(v.reasons).toContain('run timeout');
  });

  test('a review disagreement stays open: never a pass', () => {
    const disagree: Review[] = [{ itemId: 'recommends', status: 'holds', reason: 'recommends text', by: 'first', role: 'review' }, { itemId: 'recommends', status: 'violated', reason: 'no recommendation', by: 'second', role: 'review' }];
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: disagree }).outcome).toBe('insufficient-evidence');
  });

  test('an unmatched write in a concurrent run cannot be placed, so the session-scoped expectation stays open', () => {
    const conflict = call(1, 'map_apply', { kind: 'conflict', conflict: { mapId: 'feishu-access-20261022', expectedRevision: 1, currentRevision: 2 } });
    const reread = call(2, 'map_read', { kind: 'found' });
    const unmatched: AgentWrite = { session: 'A', turn: 2, receipt: false, changes: [{ commandIndex: 0, command: 'claim.acquire', subjectId: 'api-limits' }], edit: s => s };
    const v = judgeAttempt(byId('S6'), sample('S6', [unmatched], { events: [conflict, reread] }), { reviews: holdsAll('proposal-reported-conflict', 'replayed-intent') });
    expect(v.outcome).toBe('insufficient-evidence');
    expect(v.expect.find(g => g.id === 'continues-on-request')!.status).toBe('unknown');
  });

  test('an existing violation plus missing evidence still shows the violation', () => {
    const v = judgeAttempt(byId('S12'), sample('S12', [createdMap], { missing: ['events', 'receipts'], run: { startedAt: '', endedAt: '', completeness: 'driver-failed' } }));
    expect(v.outcome).toBe('fail');
  });

  test('an expectation group for a capability the client lacks is not applicable, not passed', () => {
    const v = judgeAttempt(byId('W3'), sample('W3'), { supports: { 'sub-agents': 'unverified' } });
    expect(v.expect.find(g => g.id === 'parallel')!.status).toBe('not-applicable');
  });
});

describe('cells keep every Attempt', () => {
  const pass = judgeAttempt(byId('S12'), sample('S12'), { reviews: holdsAll('recommends') });
  const fail = judgeAttempt(byId('S12'), sample('S12', [createdMap]), { reviews: holdsAll('recommends') });
  const open = judgeAttempt(byId('S12'), sample('S12'));
  test('pass and fail together are flaky; the best Attempt never hides the failure', () => expect(judgeCell(byId('S12'), [pass, fail], 2).outcome).toBe('flaky'));
  test('a failure with an undecided Attempt is still a failure', () => expect(judgeCell(byId('S12'), [fail, open], 2).outcome).toBe('fail'));
  test('fewer Attempts than required is incomplete', () => expect(judgeCell(byId('S12'), [pass], 2)).toMatchObject({ outcome: 'incomplete', reasons: ['1 of 2 decided Attempts'] }));
  test('an undecided Attempt blocks a pass; an unfinished one run again does not', () => {
    expect(judgeCell(byId('S12'), [pass, pass, open], 2).outcome).toBe('insufficient-evidence');
    const cut = judgeAttempt(byId('S12'), sample('S12', [], { run: { startedAt: '', endedAt: '', completeness: 'rate-limited' } }));
    expect(judgeCell(byId('S12'), [cut, pass, pass], 2).outcome).toBe('pass');
  });
  test('a real problem reports its reproduction on its original Combination only', () => {
    expect(judgeCell(byId('F11'), [], 2, 'codex:gpt-6-astra:xhigh').reproduction).toBe('not-reproduced-yet');
    expect(judgeCell(byId('F11'), [], 1, 'claude:opus:high').reproduction).toBeNull();
    expect(judgeCell(byId('S12'), [pass, pass], 2)).toMatchObject({ outcome: 'pass', reproduction: null });
  });
});

describe('upgrade checks judge the recovery path', () => {
  const u = upgradeChecks.find(x => x.id === 'U-codex-process')!;
  const phases: GivenRules[] = [
    { phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.0.2' }, instructions: { known: true, value: 'captured instructions' }, toolDescriptions: { known: true, value: { map_apply: 'In this release every Ticket title begins with \"v2: \".' } }, resources: 'available', prompts: 'available', extraContext: [] },
    { phase: 'after-restart', fromSeq: 10, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 9.9.9' }, instructions: { known: true, value: 'captured instructions' }, toolDescriptions: { known: true, value: { map_apply: 'In this release every Ticket title begins with \"v2: \".' } }, resources: 'available', prompts: 'available', extraContext: [] },
  ];
  const ticket = (title: string) => ({ commands: [{ kind: 'ticket.create', ticket: { id: 'p', title, question: 'q?', type: 'research' } }] });
  const recovered: EventRecord[] = [
    call(11, 'map_apply', { kind: 'rejected', code: 'version_mismatch', version: '2.0.2', rules: 'wayfinder://workflow/exploration' }, { args: { version: '2.0.2', ...ticket('x') } }),
    { seq: 12, at: '', session: 'A', turn: 0, actor: 'agent', kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true },
    call(13, 'map_read', { kind: 'found' }),
    call(14, 'map_apply', { kind: 'committed', mapId: 'U', revision: 2, changes: [] }, { args: { version: '9.9.9', ...ticket('v2: probe') } }),
  ];
  const judge = (events: EventRecord[]) => Object.fromEntries([...u.mustNot, ...u.expect].flatMap(i => i.check ? [[i.id, i.check(sample('S12', [], { given: phases, events })).status]] : []));
  test('refused, read the rules, reread, wrote once with the new release under the new rule', () => {
    expect(judge(recovered)).toEqual({ 'old-rules-write': 'holds', 'double-write': 'holds', 'guessed-version': 'holds',
      'refused-unwritten': 'holds', 'reads-new-rules': 'holds', 'writes-new-version': 'holds', 'follows-canary-rule': 'holds',
      'canary-rule-violation': 'unknown', 'refusal-zero-writes': 'unknown', 'exact-history': 'unknown', 'canary-reply': 'unknown', 'upgrade-lifecycle': 'unknown' });
  });
  test('a retry that skips the Resource, or commits under the old release, is caught', () => {
    const skipped = recovered.filter(e => e.kind !== 'resource-read');
    expect(judge(skipped)['reads-new-rules']).toBe('violated');
    const oldCommit = [call(11, 'map_apply', { kind: 'committed', mapId: 'U', revision: 2, changes: [] }, { args: { version: '2.0.2', ...ticket('x') } })];
    expect(judge(oldCommit)).toMatchObject({ 'old-rules-write': 'violated', 'refused-unwritten': 'violated' });
  });
  test('without the rules of both phases the checks stay unknown', () => {
    expect(u.expect.find(i => i.id === 'refused-unwritten')!.check!(sample('S12', [], { events: recovered })).status).toBe('unknown');
  });
});

describe('report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-behave-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const batch = (name: string, release: string, version: number, outcomes: { id: string; record?: AttemptRecord | null; notRun?: boolean }[], combination = 'codex:gpt-6-astra:xhigh') => {
    const b = join(dir, name);
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'batch.json'), JSON.stringify({ batchId: name, combination, entry: 'mcp-only', outcomes: outcomes.map(o => {
      if (o.notRun) return { attemptId: o.id, scenario: 'S12', completeness: 'not-run' };
      if (o.record) { mkdirSync(join(b, o.id), { recursive: true }); writeFileSync(join(b, o.id, 'attempt.json'), JSON.stringify({ ...o.record, service: { ...o.record.service, version: release }, subject: { ...o.record.subject, version } })); }
      return { attemptId: o.id, scenario: 'S12', completeness: 'complete', record: `${o.id}/attempt.json` };
    }) }));
    return b;
  };
  const failed = sample('S12', [createdMap]);
  const clean = sample('S12');

  test('a missing attempt file and a not-run Attempt both leave the cell uncovered', () => {
    const r = buildReport([batch('B-missing', '2.0.2', 1, [{ id: 'S12-1', record: null }, { id: 'S12-2', notRun: true }])]);
    expect(r.cells[0]).toMatchObject({ planned: 2, notRun: 1 });
    expect(r.cells[0]!.verdict.outcome).toBe('incomplete');
    expect(renderMarkdown(r)).toMatch(/## Uncovered, undecided or retry due\n\n- \*\*S12\*\*/);
  });

  test('regressions come first; a verdict change makes cells not directly comparable', () => {
    const reviews = { 'B-base/S12-1': holdsAll('recommends'), 'B-base/S12-2': holdsAll('recommends') };
    const base = buildReport([batch('B-base', '2.0.1', 1, [{ id: 'S12-1', record: clean }, { id: 'S12-2', record: clean }])], reviews);
    expect(base.cells[0]!.verdict.outcome).toBe('pass');
    const now = compare(buildReport([batch('B-now', '2.0.2', 1, [{ id: 'S12-1', record: failed }, { id: 'S12-2', record: failed }])]), base);
    expect(now.cells[0]!.comparison).toMatchObject({ status: 'regression', baseline: { release: 'release:2.0.1', outcome: 'pass' } });
    expect(renderMarkdown(now).indexOf('## New regressions\n\n- **S12**')).toBeGreaterThan(-1);
    const changed = compare(buildReport([batch('B-v2', '2.0.2', 2, [{ id: 'S12-1', record: failed }])]), base);
    expect(changed.cells[0]!.comparison).toMatchObject({ status: 'not-comparable', reasons: ['verdict changed (Scenario v1 → v2)'] });
  });

  test('an Attempt without a record stays in its Batch\'s release cell, with the Batch\'s reason', () => {
    const r = buildReport([batch('B-mixed', '2.0.2', 1, [{ id: 'S12-1', record: clean }, { id: 'S12-2', record: null }])]);
    expect(r.cells.map(c => c.key.release)).toEqual(['2.0.2']);
    expect(r.cells[0]!.verdict.attempts.map(a => a.outcome)).toEqual(['insufficient-evidence', 'incomplete']);
  });

  test('the baseline is the newest compatible release, so a regression is not hidden behind an older cell', () => {
    const reviews = { 'B-201/S12-1': holdsAll('recommends'), 'B-201/S12-2': holdsAll('recommends') };
    const older = buildReport([batch('B-200', '2.0.0', 1, [{ id: 'S12-1', record: failed }, { id: 'S12-2', record: failed }])]);
    const newerBase = buildReport([batch('B-201', '2.0.1', 1, [{ id: 'S12-1', record: clean }, { id: 'S12-2', record: clean }])], reviews);
    const base: Report = { batches: [], cells: [...older.cells, ...newerBase.cells] };
    const now = compare(buildReport([batch('B-202', '2.0.2', 1, [{ id: 'S12-1', record: failed }, { id: 'S12-2', record: failed }])]), base);
    expect(now.cells[0]!.comparison).toMatchObject({ status: 'regression', baseline: { release: 'release:2.0.1' } });
  });

  test('a new Combination needs a two-Attempt baseline before it can pass', () => {
    const one = buildReport([batch('B-new', '2.0.2', 1, [{ id: 'S12-1', record: clean }], 'claude:sonnet:low')], { 'B-new/S12-1': holdsAll('recommends') });
    expect(one.cells[0]!.verdict.outcome).toBe('pass');
    expect(compare(one, { batches: [], cells: [] }).cells[0]!.verdict.outcome).toBe('incomplete');
    expect(compare(one, one).cells[0]!.verdict.outcome).toBe('pass');
  });

  test('another Combination that fails once is due one more Attempt', () => {
    const r = buildReport([batch('B-other', '2.0.2', 1, [{ id: 'S12-1', record: failed }], 'claude:sonnet:low')]);
    expect(r.cells[0]!.retryDue).toBe('one more Attempt after fail');
  });

  test('the old workflowVersion series is never compared with the Release Version', () => {
    const base: Report = buildReport([batch('B-hist', '3.0.0', 1, [{ id: 'S12-1', record: { ...clean, service: { ...clean.service, series: 'workflowVersion' } } }])]);
    const now = compare(buildReport([batch('B-rel', '2.0.2', 1, [{ id: 'S12-1', record: clean }])]), base);
    expect(now.cells[0]!.comparison!.status).toBe('not-comparable');
    expect(now.cells[0]!.comparison!.reasons.join()).toMatch(/workflowVersion → release/);
  });
});

describe('reviews never decide what they may not', () => {
  const review = (status: Review['status'], by: string, role: Review['role'] = 'review'): Review => ({ itemId: 'recommends', status, reason: 'r', by, role, readingId: by, evidence: ['events[0]'], support: [{ location: 'events[0]', quote: 'explicit invocation', explanation: 'This earlier recommendation supports the requested item.' }] });
  test('one review is not enough; two that agree decide; a disagreement waits for arbitration', () => {
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: [review('holds', 'first')] }).outcome).toBe('insufficient-evidence');
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: [review('holds', 'first'), review('holds', 'second')] }).outcome).toBe('pass');
    const disputed = [review('holds', 'first'), review('violated', 'second')];
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: disputed }).outcome).toBe('insufficient-evidence');
    expect(judgeAttempt(byId('S12'), sample('S12'), { reviews: [...disputed, review('violated', 'arbiter', 'arbitration')] }).outcome).toBe('fail');
  });
  test('a model review cannot clear an item a script left open for missing evidence; the human can', () => {
    const gap = sample('S12', [], { maps: [], missing: ['maps', 'receipts'] });
    const models: Review[] = ['first', 'second'].map(by => ({ itemId: 'created-map', status: 'holds', reason: 'looks fine', by, role: 'review' }));
    const v = judgeAttempt(byId('S12'), gap, { reviews: [...models, ...holdsAll('recommends')] });
    expect(v.outcome).toBe('insufficient-evidence');
    expect(v.mustNot.find(i => i.id === 'created-map')).toMatchObject({ status: 'unknown' });
    const human: Review = { itemId: 'created-map', status: 'holds', reason: 'checked the database by hand', by: 'Kun', role: 'human' };
    expect(judgeAttempt(byId('S12'), gap, { reviews: [human, { ...human, itemId: 'recommends' }] }).outcome).toBe('pass');
  });
  test('a record made under an older Scenario version is not re-judged by the current one', () => {
    const old = sample('S12', [createdMap], { subject: { kind: 'scenario', id: 'S12', version: 0 } });
    expect(judgeAttempt(byId('S12'), old)).toMatchObject({ outcome: 'insufficient-evidence', scenario: { version: 0 } });
  });
  test('a group for an unproven capability is a coverage gap', () => {
    expect(judgeAttempt(byId('W3'), sample('W3'), { supports: { 'sub-agents': 'unverified' } }).gaps).toEqual(['parallel needs sub-agents, not yet proven for this client']);
  });
});

describe('upgrade checks keep refusals, outages and missing results apart', () => {
  const u = upgradeChecks.find(x => x.id === 'U-codex-process')!;
  const given = (resources: GivenRules['resources']): GivenRules[] => [
    { phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.0.2' }, instructions: { known: true, value: 'captured instructions' }, toolDescriptions: unknownField, resources, prompts: 'available', extraContext: [] },
    { phase: 'after-restart', fromSeq: 10, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 9.9.9' }, instructions: { known: true, value: 'captured instructions' }, toolDescriptions: unknownField, resources, prompts: 'available', extraContext: [] }];
  const mismatch = (seq: number) => call(seq, 'map_apply', { kind: 'rejected', code: 'version_mismatch', version: '2.0.2', rules: 'wayfinder://workflow/exploration' }, { args: { version: '2.0.2' } });
  const status = (id: string, events: EventRecord[], resources: GivenRules['resources'] = 'available') =>
    [...u.mustNot, ...u.expect].find(i => i.id === id)!.check!(sample('S12', [], { given: given(resources), events })).status;
  test('a dropped connection before the first answer is not the client refusing to be refused', () => {
    expect(status('refused-unwritten', [call(11, 'map_apply', undefined, { args: { version: '2.0.2' } }), mismatch(12)])).toBe('unknown');
    const dropped = { ...call(11, 'map_apply', null, { args: { version: '2.0.2' } }), failed: true };
    expect(status('refused-unwritten', [dropped, mismatch(12)])).toBe('holds');
  });
  test('an old-version write with no recorded result is unknown, never clean', () => {
    expect(status('old-rules-write', [call(11, 'map_apply', undefined, { args: { version: '2.0.2' } })])).toBe('unknown');
  });
  test('a write with no version at all is an input error, not a guessed version', () => {
    expect(status('guessed-version', [call(11, 'map_apply', { kind: 'rejected', error: { code: 'invalid_input', path: ['version'], constraint: 'required' } })])).toBe('holds');
    expect(status('guessed-version', [call(11, 'map_apply', { kind: 'rejected', code: 'version_mismatch' }, { args: { version: '1' } })])).toBe('violated');
  });
  test('the expected recovery follows whether the client can read Resources', () => {
    const retried = [mismatch(11), call(12, 'map_apply', { kind: 'committed', mapId: 'U', revision: 2, changes: [] }, { args: { version: '9.9.9' } })];
    expect(status('reads-new-rules', retried, 'available')).toBe('violated');
    expect(status('reads-new-rules', retried, 'unavailable')).toBe('violated');
    expect(status('reads-new-rules', [mismatch(11)], 'unavailable')).toBe('unknown');
  });
  test('an upgrade Attempt is judged through the Scenario adapter, model items left to review', () => {
    const v = judgeAttempt(asScenario(u), sample('S12', [], { subject: { kind: 'upgrade-check', id: u.id, version: u.version }, given: given('available'), events: [mismatch(11)] }));
    expect(v.mustNot.find(i => i.id === 'mismatch-as-outage')!.status).toBe('pending-review');
    expect(v.required.find(i => i.id === 'upgrade-lifecycle')!.status).toBe('unknown');
    expect(v.outcome).toBe('insufficient-evidence'); // A refusal alone does not prove the owned restart was exercised.
  });
});
