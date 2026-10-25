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
import { upgradeChecks } from './upgrade-checks.ts';
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
      instructions: unknownField, toolDescriptions: unknownField, resources: 'available', prompts: 'available', extraContext: [] }],
    run: { startedAt: '', endedAt: '', completeness: 'complete' }, controller: { clientId: 'Behaviour-Controller' }, baitClientIds: [],
    sessions: labels.map(label => ({ label, nativeId: unknownField, clientId: `agent-${label}`, mcpSessionIds: unknownField, turns: [] })),
    events: [], maps: mapId ? [{ mapId, seedHeadRevision: seed ? 1 : null, history }] : [], receipts, usage: unknownField, raw: { path: `T/${scenarioId}/raw`, files: [] }, missing: [],
    ...over,
  };
}

const call = (seq: number, tool: string, result: unknown, extra: Partial<{ session: string; turn: number; args: unknown }> = {}): EventRecord =>
  ({ seq, at: '', session: extra.session ?? 'A', turn: extra.turn ?? 0, actor: 'agent', kind: 'tool-call', callId: `e${seq}`, server: 'wayfinder', tool,
     arguments: extra.args ?? {}, result: result === undefined ? unknownField : { known: true, value: result }, failed: false, requestId: unknownField });
const holdsAll = (...ids: string[]): Review[] => ids.map(itemId => ({ itemId, status: 'holds', reason: 'sample review', by: 'reviewer' }));
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
    const disagree: Review[] = [{ itemId: 'recommends', status: 'undecided', reason: 'the two reviews disagree; arbitration pending', by: 'review' }];
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
  test('fewer Attempts than required is incomplete', () => expect(judgeCell(byId('S12'), [pass], 2)).toMatchObject({ outcome: 'incomplete', reasons: ['1 of 2 Attempts'] }));
  test('a real problem reports its reproduction apart from the outcome', () => {
    expect(judgeCell(byId('F11'), [], 2).reproduction).toBe('not-reproduced-yet');
    expect(judgeCell(byId('S12'), [pass, pass], 2)).toMatchObject({ outcome: 'pass', reproduction: null });
  });
});

describe('upgrade checks judge the recovery path', () => {
  const u = upgradeChecks.find(x => x.id === 'U-codex-process')!;
  const phases: GivenRules[] = [
    { phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 2.0.2' }, instructions: unknownField, toolDescriptions: unknownField, resources: 'available', prompts: 'available', extraContext: [] },
    { phase: 'after-restart', fromSeq: 10, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: 'version: 9.9.9' }, instructions: unknownField, toolDescriptions: unknownField, resources: 'available', prompts: 'available', extraContext: [] },
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
      'refused-unwritten': 'holds', 'reads-new-rules': 'holds', 'writes-new-version': 'holds', 'follows-canary-rule': 'holds' });
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
  const batch = (name: string, release: string, version: number, outcomes: { id: string; record?: AttemptRecord | null; notRun?: boolean }[]) => {
    const b = join(dir, name);
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'batch.json'), JSON.stringify({ batchId: name, combination: 'codex:gpt-6-astra:xhigh', entry: 'mcp-only', outcomes: outcomes.map(o => {
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
    expect(renderMarkdown(r)).toMatch(/## Uncovered or not yet decided\n\n- \*\*S12\*\*/);
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

  test('the old workflowVersion series is never compared with the Release Version', () => {
    const base: Report = buildReport([batch('B-hist', '3.0.0', 1, [{ id: 'S12-1', record: { ...clean, service: { ...clean.service, series: 'workflowVersion' } } }])]);
    const now = compare(buildReport([batch('B-rel', '2.0.2', 1, [{ id: 'S12-1', record: clean }])]), base);
    expect(now.cells[0]!.comparison!.status).toBe('not-comparable');
    expect(now.cells[0]!.comparison!.reasons.join()).toMatch(/workflowVersion → release/);
  });
});
