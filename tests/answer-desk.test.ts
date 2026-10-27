import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseId, prepareApply, prepareCreate } from '../src/index.js';
import type { Command, NonEmpty, StoredMapState } from '../src/types.js';
import type { AnswerItem, DeskQuestionInput } from '../src/desk-types.js';
import type { DeskWrite, ReopenSubmission } from '../src/desk-storage.js';
import { affectedSettlementRevisions, affectedSettledTickets, projectDesk } from '../src/desk-domain.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function id<K extends string>(kind: K, value: string) { const result = parseId(kind, value); if (result.kind !== 'ok') throw Error('bad fixture'); return result.value; }
const mapId = id('Map', 'desk'); const worker = id('Claimant', 'worker'); const other = id('Claimant', 'other');
const ticketId = (value = 'A') => id('Ticket', value);
const author = { actorId: id('Actor', 'actor'), clientId: id('Client', 'client'), occurredAt: '2026-10-27T00:00:00.000Z' };
const question: DeskQuestionInput = { questionId: 'Q.A', options: [{ label: 'One', description: 'First route' }, { label: 'Two', description: 'Second route' }],
  recommendedOption: 1, recommendedAnswer: 'Take the first route', whyKun: 'Choose the tradeoff', triage: 'needsKun', triageReason: 'A decision', gatesResearch: false };
const post = (name = 'A', patch: Partial<DeskQuestionInput> = {}): Command => ({ kind: 'deskQuestion.post', ticketId: ticketId(name), claimantId: worker, question: { ...question, questionId: `Q.${name}`, ...patch } });
const withdraw = (version = 1, name = 'A'): Command => ({ kind: 'deskQuestion.withdraw', ticketId: ticketId(name), claimantId: worker, questionId: `Q.${name}`, questionVersion: version, reason: 'answered in conversation' });
const create = (name = 'A'): Command => ({ kind: 'ticket.create', ticket: { id: ticketId(name), title: name, question: 'Which route?', type: 'grilling' } });
const claim = (name = 'A', claimantId = worker): Command => ({ kind: 'claim.acquire', ticketId: ticketId(name), claimantId });
const reopen = (name = 'A'): Command => ({ kind: 'ticket.reopen', ticketId: ticketId(name), reason: 'Human asked' });
const settle = (answer?: AnswerItem, name = 'A', claimantId = worker): Command => ({ kind: 'ticket.settle', ticketId: ticketId(name), claimantId, ticketType: 'grilling',
  settlement: { outcome: { kind: 'decision', statement: 'Two: Second route', rationale: 'Human chose option 2' }, evidence: [], references: [], provenance: { method: 'human verdict', sources: [] }, extensions: {} },
  ...(answer ? { deskAnswer: { answerId: answer.answerId, questionVersion: answer.questionVersion } } : {}) });
function updated<T>(value: DeskWrite<T>): T { expect(value.kind, JSON.stringify(value)).toBe('updated'); if (value.kind !== 'updated') throw Error('fixture rejected'); return value.value; }
async function fixture(faults: Parameters<typeof sqliteLifecycleForTests>[0] = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-desk-'))); cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite');
  let now = Date.parse(author.occurredAt);
  const lifecycle = sqliteLifecycleForTests({ now: () => new Date(now).toISOString(), ...(typeof faults === 'function' ? { beforePublication: faults } : faults) });
  lifecycle.initialize(path); let storage = lifecycle.open(path); cleanups.push(() => storage.close());
  const created = prepareCreate({ id: mapId, title: 'Desk', destination: 'Decide', author }); if (created.kind !== 'ok') throw Error('fixture create');
  await storage.adapter.commit(created.value);
  const state = async (): Promise<StoredMapState> => { const r = await storage.adapter.readCurrent(mapId); if (r.kind !== 'found') throw Error('missing'); return r.value; };
  async function prepare(commands: NonEmpty<Command>, reopenRequestId?: string) {
    const current = await state();
    return prepareApply(current, { mapId, expectedRevision: current.currentRevision, author, commands, ...(reopenRequestId ? { reopenRequestId } : {}) }, storage.desk.read(mapId));
  }
  async function apply(commands: NonEmpty<Command>, request?: string) {
    const p = await prepare(commands, request); if (p.kind !== 'prepared') return p;
    return storage.adapter.commit(p.change);
  }
  async function commit(commands: NonEmpty<Command>, request?: string) { const r = await apply(commands, request); expect(r.kind, JSON.stringify(r)).toBe('committed'); if (r.kind !== 'committed') throw Error('fixture apply'); return r; }
  const answer = (name = 'A', version = 1, choice: { option: 1 | 2 | 3 } | { text: string } = { option: 2 }) => updated(storage.desk.submitAnswers(mapId, [{ questionId: `Q.${name}`, questionVersion: version, choice }]))[0]!;
  const take = (claimant = worker) => updated(storage.desk.takeEligible(mapId, claimant));
  const inspect = () => { const r = storage.desk.inspect(mapId); if (r.kind !== 'found') throw Error('missing'); return r; };
  const source = async (name = 'A', requested: ReopenSubmission['requested'] = { text: 'Reconsider' }): Promise<ReopenSubmission> => {
    const s = await state(); const t = s.tickets.find(t => t.id === name)!; if (t.status !== 'settled') throw Error('not settled');
    const affected = affectedSettlementRevisions(s, t.id);
    return { ticketId: t.id, settlementIntroducedAtRevision: t.settlement.introducedAtRevision, affectedTickets: Object.keys(affected).map(x => ticketId(x)), affectedSettlementRevisions: affected, requested };
  };
  const file = async (name = 'A', requested?: ReopenSubmission['requested']) => updated(storage.desk.fileReopenRequest(mapId, await source(name, requested)));
  return { get storage() { return storage; }, path, state, prepare, apply, commit, answer, take, inspect, source, file,
    tick(ms = 15_000) { now += ms; }, restart() { storage.close(); storage = lifecycle.open(path); } };
}
async function published(f: Awaited<ReturnType<typeof fixture>>) { await f.commit([create(), claim(), post()]); }
async function settled(f: Awaited<ReturnType<typeof fixture>>) { await published(f); const a = f.answer(); f.tick(); f.take(); await f.commit([settle(a)]); return a; }

test('post/withdraw-only batches revise; claim, version and whole-input guards leave history unchanged', async () => {
  const f = await fixture(); await f.commit([create()]);
  expect(await f.apply([post()])).toMatchObject({ kind: 'rejected', rejection: { code: 'claim_required' } });
  await f.commit([claim()]); const posted = await f.commit([post()]);
  expect(posted.revision.changes).toEqual([{ commandIndex: 0, command: 'deskQuestion.post', subjectId: 'Q.A' }]);
  expect(await f.apply([post()])).toMatchObject({ rejection: { code: 'desk_question_active' } });
  expect(await f.apply([withdraw(9)])).toMatchObject({ rejection: { code: 'desk_question_not_found' } });
  await f.commit([withdraw()]); await f.commit([post()]);
  expect((await f.state()).deskQuestions?.map(q => [q.questionVersion, q.state])).toEqual([[1, 'withdrawn'], [2, 'published']]);
  expect(await f.storage.adapter.readRevision(mapId, posted.revision.revision)).toEqual({ kind: 'found', value: posted.revision });
  expect(await f.apply([{ ...post(), unexpected: true } as unknown as Command])).toMatchObject({ rejection: { stage: 'input' } });
});

test('human writes leave Revision and history intact; bulk failure is atomic and never resets quiet time', async () => {
  const f = await fixture(); await f.commit([create(), claim(), post(), create('B'), claim('B'), post('B')]);
  const before = await f.state(); const first = f.answer(); const quiet = f.storage.desk.read(mapId).quietUntil; f.tick(1000);
  expect(f.storage.desk.submitAnswers(mapId, [{ questionId: 'Q.A', questionVersion: 1, choice: { option: 1 } }, { questionId: 'missing', questionVersion: 1, choice: { text: 'x' } }])).toMatchObject({ code: 'question_changed' });
  expect(f.storage.desk.read(mapId)).toMatchObject({ quietUntil: quiet, answers: [first] });
  expect(f.storage.desk.submitAnswers(mapId, [{ questionId: 'Q.B', questionVersion: 1, choice: { text: ' ' } }])).toMatchObject({ code: 'invalid_input' });
  expect(await f.state()).toEqual(before); expect((await f.storage.adapter.readRevision(mapId, before.currentRevision))).toMatchObject({ value: { state: before } });
  expect(f.take()).toMatchObject({ outcome: 'none_yet', quietUntil: quiet });
  f.answer('B'); f.tick(14_999); expect(f.take().items).toEqual([]); f.tick(1);
  expect(f.take().items.map(a => a.ticketId).sort()).toEqual(['A', 'B']); expect(f.take().items).toEqual([]);
  expect(await f.state()).toEqual(before);
});

test('settlement requires the current Taken answer, exact version and claimant; option 2 can settle', async () => {
  const f = await fixture(); await published(f); const answer = f.answer();
  expect(await f.apply([settle()])).toMatchObject({ rejection: { code: 'desk_answer_required' } });
  expect(await f.apply([settle(answer)])).toMatchObject({ rejection: { code: 'desk_answer_invalid' } });
  f.tick(); f.take();
  expect(await f.apply([settle({ ...answer, questionVersion: 2 })])).toMatchObject({ rejection: { code: 'desk_answer_invalid' } });
  expect(await f.apply([settle(answer, 'A', other)])).toMatchObject({ rejection: { code: 'claim_mismatch' } });
  const committed = await f.commit([settle(answer)]);
  expect(committed.revision.state.tickets[0]).toMatchObject({ status: 'settled', settlement: { deskAnswer: { answerId: answer.answerId, questionVersion: 1 } } });
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'settled', currentAnswer: answer });
});

test('edit wins before commit despite identical head; stale prepared settlement cannot consume replacement', async () => {
  const f = await fixture(); await published(f); const a = f.answer(); f.tick(); f.take();
  const prepared = await f.prepare([settle(a)]); if (prepared.kind !== 'prepared') throw Error('not prepared');
  const replacement = f.answer('A', 1, { text: 'Need evidence' });
  expect(await f.storage.adapter.commit(prepared.change)).toMatchObject({ kind: 'rejected', rejection: { code: 'desk_answer_invalid' } });
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'answered', currentAnswer: replacement });
  f.tick(); expect(f.take().items).toEqual([replacement]);
  await f.commit([withdraw(), settle()]);
  expect(f.storage.desk.submitAnswers(mapId, [{ questionId: 'Q.A', questionVersion: 1, choice: { option: 1 } }])).toMatchObject({ code: 'question_changed' });
});

test.each(['claim.release', 'claim.clear'] as const)('%s atomically returns Taken; next claimant inherits; wrong taker cannot settle', async kind => {
  const f = await fixture(); await published(f); const a = f.answer(); f.tick(); f.take();
  await f.commit([kind === 'claim.release' ? { kind, ticketId: ticketId(), claimantId: worker } : { kind, ticketId: ticketId(), expectedClaimantId: worker, reason: 'handoff' }, claim('A', other)]);
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'answered', currentAnswer: a });
  expect(await f.apply([settle(a, 'A', other)])).toMatchObject({ rejection: { code: 'desk_answer_invalid' } });
  expect(f.take().items).toEqual([]); expect(f.take(other).items).toEqual([a]);
  await f.commit([settle(a, 'A', other)]);
});

test('withdraw/repost makes old answers inspectable but stale; current and historical projections separate desk state', async () => {
  const f = await fixture(); await published(f); const a = f.answer(); f.tick(); f.take();
  const old = await f.state(); await f.commit([withdraw(), post()]);
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'withdrawn', currentAnswer: null, answerHistory: [{ answerId: a.answerId, stale: true }] });
  expect(await f.apply([settle(a)])).toMatchObject({ rejection: { code: 'desk_answer_invalid' } });
  expect(projectDesk(old, f.storage.desk.read(mapId), true)).toEqual({ deskQuestions: old.deskQuestions });
  expect(f.take().items).toEqual([]);
});

test('restart retains Taken and superseded answers without auto-return or Settlement', async () => {
  const f = await fixture(); await published(f); f.answer(); const a = f.answer('A', 1, { text: 'Choose custom' }); f.tick(); f.take();
  const before = await f.state(); f.restart(); expect(f.take().items).toEqual([]); expect(await f.state()).toEqual(before);
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'taken', currentAnswer: a, answerHistory: [{ stale: true }, { stale: false }] });
});

async function dependent(f: Awaited<ReturnType<typeof fixture>>, name = 'B', parent = 'A') {
  await f.commit([create(name), { kind: 'dependency.add', dependentId: ticketId(name), prerequisiteId: ticketId(parent) }, claim(name), settle(undefined, name)]);
}
test('affected settled descendants are transitive, distinct and exclude the target', async () => {
  const f = await fixture(); await settled(f); await dependent(f); await dependent(f, 'C'); await dependent(f, 'D', 'B');
  await f.commit([reopen('D'), { kind: 'dependency.add', dependentId: ticketId('D'), prerequisiteId: ticketId('C') }, claim('D'), settle(undefined, 'D'), create('E'), { kind: 'dependency.add', dependentId: ticketId('E'), prerequisiteId: ticketId('D') }]);
  expect(affectedSettledTickets(await f.state(), ticketId())).toEqual(['B', 'C', 'D']);
});

test.each(['target', 'dependent', 'ids'] as const)('filing binds displayed %s identities and fails without replacement or quiet reset', async change => {
  const f = await fixture(); await settled(f); await dependent(f);
  const displayed = await f.source(); const first = await f.file(); const quietUntil = f.storage.desk.read(mapId).quietUntil;
  if (change === 'target') await f.commit([reopen(), reopen('B'), claim(), settle()]);
  else if (change === 'dependent') await f.commit([reopen('B'), claim('B'), settle(undefined, 'B')]);
  else await dependent(f, 'C');
  f.tick(1000);
  expect(f.storage.desk.fileReopenRequest(mapId, displayed)).toMatchObject({ code: 'list_changed' });
  expect(f.storage.desk.read(mapId)).toMatchObject({ quietUntil, reopenRequests: [{ requestId: first.requestId, state: 'pending' }] });
});

test('option Reopen Requests bind the settled publication; conversation settlements accept text only', async () => {
  const f = await fixture(); await settled(f);
  expect((await f.file('A', { option: 1, label: 'One', questionId: 'Q.A', questionVersion: 1 })).requested).toMatchObject({ option: 1 });
  expect(f.storage.desk.fileReopenRequest(mapId, await f.source('A', { option: 1, label: 'Forged', questionId: 'Q.A', questionVersion: 1 }))).toMatchObject({ code: 'invalid_input' });
  await f.commit([create('B'), claim('B'), settle(undefined, 'B')]);
  expect(f.storage.desk.fileReopenRequest(mapId, await f.source('B', { option: 1, label: 'One', questionId: 'Q.A', questionVersion: 1 }))).toMatchObject({ code: 'invalid_input' });
  expect((await f.file('B')).requested).toEqual({ text: 'Reconsider' });
});

test('cancellation until Taken, supersession of pending and Taken, no Revision for human requests', async () => {
  const f = await fixture(); await settled(f); const before = await f.state();
  const first = await f.file(); f.tick(1000); updated(f.storage.desk.cancelReopenRequest(mapId, first.requestId));
  expect(f.storage.desk.read(mapId).quietUntil).toBe('2026-10-27T00:00:31.000Z');
  expect(f.inspect().desk.reopenRequests).toEqual([]);
  const second = await f.file(); const third = await f.file(); f.tick(); expect(f.take().items).toHaveLength(1);
  expect(f.storage.desk.cancelReopenRequest(mapId, third.requestId)).toMatchObject({ code: 'request_not_pending' });
  const fourth = await f.file(); expect(await f.state()).toEqual(before);
  expect(f.inspect().desk.reopenRequests).toEqual([expect.objectContaining({ requestId: fourth.requestId, state: 'pending' })]);
  expect(await f.apply([reopen()], second.requestId)).toMatchObject({ rejection: { code: 'reopen_request_inactive' } });
});

test('pending, unknown/cross-Map, omitted-target and handled citations reject; any claimant may handle Taken', async () => {
  const f = await fixture(); await settled(f); const r = await f.file();
  expect(await f.apply([reopen()], r.requestId)).toMatchObject({ rejection: { code: 'reopen_request_pending' } });
  expect(await f.apply([reopen()], 'missing')).toMatchObject({ rejection: { code: 'reopen_request_not_found' } });
  f.tick(); f.take(other);
  expect(await f.apply([{ kind: 'map.update', patch: { notes: 'not reopening' } }], r.requestId)).toMatchObject({ rejection: { code: 'reopen_target_omitted' } });
  const committed = await f.commit([reopen()], r.requestId);
  expect(f.inspect().desk).toMatchObject({ reopenRequests: [], reopenContexts: [{ ticketId: 'A', requestId: r.requestId, handledAtRevision: committed.revision.revision }] });
  expect(await f.apply([claim()], r.requestId)).toMatchObject({ rejection: { code: 'reopen_request_handled' } });
});

test('coverage reports every unlisted or changed settlement and publishes no partial reopen', async () => {
  const f = await fixture(); await settled(f); await dependent(f); const r = await f.file(); f.tick(); f.take();
  await f.commit([reopen('B'), claim('B'), settle(undefined, 'B')]); await dependent(f, 'C');
  const before = await f.state();
  expect(await f.apply([reopen(), reopen('B'), reopen('C')], r.requestId)).toMatchObject({ rejection: {
    code: 'reopen_authorization_exceeded', uncoveredTickets: [{ ticketId: 'B', reason: 'settlement_changed' }, { ticketId: 'C', reason: 'not_listed' }],
  } });
  expect(await f.state()).toEqual(before); expect(f.inspect().desk.reopenRequests).toHaveLength(1);
});

test('shrunk affected set requires exactly current dependents, never obsolete recorded dependents', async () => {
  const f = await fixture(); await settled(f); await dependent(f); const r = await f.file(); f.tick(); f.take();
  await f.commit([reopen('B')]);
  expect(await f.apply([reopen(), reopen('B')], r.requestId)).toMatchObject({ rejection: { code: 'reopen_set_mismatch' } });
  await f.commit([reopen()], r.requestId);
  expect(f.inspect().desk.reopenRequests).toEqual([]);
});

test('stale target can be delivered but never cited; close-only batch revises with ID/reason; repeat fails', async () => {
  const f = await fixture(); await settled(f); const r = await f.file();
  expect(await f.apply([{ kind: 'reopenRequest.close', requestId: r.requestId, reason: 'not needed' }])).toMatchObject({ rejection: { code: 'reopen_close_guard' } });
  await f.commit([reopen(), claim(), settle()]); f.tick(); f.take();
  expect(f.inspect().desk.reopenRequests).toEqual([expect.objectContaining({ state: 'taken', stale: true })]);
  expect(await f.apply([reopen()], r.requestId)).toMatchObject({ rejection: { code: 'reopen_request_stale' } });
  const c = { kind: 'reopenRequest.close' as const, requestId: r.requestId, reason: 'Old settlement replaced' };
  const result = await f.commit([c]); expect(result.revision.changes).toEqual([{ commandIndex: 0, command: c.kind, subjectId: r.requestId, reason: c.reason }]);
  expect(await f.apply([c])).toMatchObject({ rejection: { code: 'reopen_request_inactive' } });
  expect(f.inspect().desk.reopenRequests).toEqual([]);
});

test('same-batch conversation reopen then closes, and dependent reopen then closes, are atomic', async () => {
  const f = await fixture(); await settled(f); await dependent(f); const a = await f.file(); const b = await f.file('B');
  await f.commit([reopen(), reopen('B'), { kind: 'reopenRequest.close', requestId: a.requestId, reason: 'Conversation agreement' }, { kind: 'reopenRequest.close', requestId: b.requestId, reason: 'Reopened as dependent' }]);
  expect(f.inspect().desk.reopenRequests).toEqual([]); expect(f.inspect().desk.reopenContexts).toEqual([]);
});

test('handled context survives interruption, N+1 withdrawal and N+2; matches exact labels/descriptions only; never inherited by dependents/later reopens', async () => {
  const f = await fixture(); await settled(f); await dependent(f);
  const r = await f.file('A', { option: 2, label: 'Two', questionId: 'Q.A', questionVersion: 1 }); f.tick(); f.take();
  await f.commit([reopen(), reopen('B')], r.requestId); f.restart();
  expect(f.inspect().desk.reopenContexts).toEqual([expect.objectContaining({ ticketId: 'A', requestId: r.requestId, requested: r.requested })]);
  expect(f.inspect().desk.deskQuestions[0]).toMatchObject({ state: 'superseded_by_reopen', currentAnswer: null, answerHistory: [{ stale: true }] });
  await f.commit([claim(), post('A', { options: [...question.options].reverse() })]);
  expect(f.inspect().desk.deskQuestions.find(q => q.questionVersion === 2)).toMatchObject({ requestedOption: 1, currentAnswer: null });
  await f.commit([withdraw(2), post('A', { options: [{ label: 'Two', description: 'Changed' }, question.options[0]!] })]);
  expect(f.inspect().desk.deskQuestions.find(q => q.questionVersion === 3)).not.toHaveProperty('requestedOption');
  await f.commit([withdraw(3), post('A', { options: [question.options[1]!, question.options[1]!] })]);
  expect(f.inspect().desk.deskQuestions.find(q => q.questionVersion === 4)).not.toHaveProperty('requestedOption');
  expect(f.inspect().desk.reopenContexts).toHaveLength(1);
  await f.commit([withdraw(4), settle()]); expect(f.inspect().desk.reopenContexts).toEqual([]);
  await f.commit([reopen()]); expect(f.inspect().desk.reopenContexts).toEqual([]);
});

test('text reopen context retained verbatim with no preselection; all reopened publications retire', async () => {
  const f = await fixture(); await settled(f);
  await f.commit([create('B'), { kind: 'dependency.add', dependentId: ticketId('B'), prerequisiteId: ticketId() }, claim('B'), post('B')]);
  const b = f.answer('B'); f.tick(); f.take(); await f.commit([settle(b, 'B')]);
  const r = await f.file('A', { text: '  Please show new evidence.\nKeep the scope.  ' }); f.tick(); f.take();
  await f.commit([reopen(), reopen('B')], r.requestId);
  expect(f.inspect().desk.deskQuestions.every(q => q.state === 'superseded_by_reopen')).toBe(true);
  await f.commit([claim(), post()]); expect(f.inspect().desk.reopenContexts?.[0]?.requested).toEqual(r.requested);
  expect(f.inspect().desk.deskQuestions.find(q => q.questionVersion === 2)).not.toHaveProperty('requestedOption');
});

test('question publication, request handling and Claim return roll back with failed Revision publication', async () => {
  let fail = false; const f = await fixture(() => { if (fail) throw Error('injected'); });
  await settled(f); const r = await f.file(); f.tick(); f.take(); const before = f.inspect(); fail = true;
  await expect(f.apply([reopen()], r.requestId)).rejects.toMatchObject({ outcome: 'not_published' }); fail = false;
  expect(f.inspect()).toEqual(before); await f.commit([reopen()], r.requestId); await f.commit([claim(), post()]);
  f.answer('A', 2); f.tick(); f.take(); const taken = f.inspect(); fail = true;
  await expect(f.apply([{ kind: 'claim.release', ticketId: ticketId(), claimantId: worker }])).rejects.toMatchObject({ outcome: 'not_published' }); fail = false;
  expect(f.inspect()).toEqual(taken);
});

test('queue counts shared descendants once; respects other prerequisites, claims, research gating and triage', async () => {
  const f = await fixture();
  await f.commit([create(), claim(), post(), create('B'), claim('B'), post('B'), create('C'), create('D'), create('E'),
    { kind: 'dependency.add', dependentId: ticketId('C'), prerequisiteId: ticketId() },
    { kind: 'dependency.add', dependentId: ticketId('D'), prerequisiteId: ticketId() },
    { kind: 'dependency.add', dependentId: ticketId('C'), prerequisiteId: ticketId('B') },
    { kind: 'dependency.add', dependentId: ticketId('E'), prerequisiteId: ticketId('C') },
    { kind: 'dependency.add', dependentId: ticketId('E'), prerequisiteId: ticketId('D') },
    create('G'), claim('G'), post('G', { gatesResearch: true }),
  ]);
  expect(f.inspect().desk.deskQuestions.map(q => [q.ticketId, 'immediateUnlocks' in q ? q.immediateUnlocks : -1, 'downstreamUnsettled' in q ? q.downstreamUnsettled : -1]))
    .toEqual([['A', 1, 3], ['G', 0, 0], ['B', 0, 2]]);
  await f.commit([withdraw(1, 'B'), settle(undefined, 'B')]);
  expect(f.inspect().desk.deskQuestions.find(q => q.ticketId === 'A')).toMatchObject({ immediateUnlocks: 2, downstreamUnsettled: 3 });
});

test('changing question meaning requires withdrawal; old publication retains its exact question text', async () => {
  const f = await fixture(); await published(f);
  expect(await f.apply([{ kind: 'ticket.update', ticketId: ticketId(), claimantId: worker, patch: { question: 'Different?' } }])).toMatchObject({ rejection: { code: 'desk_question_active' } });
  await f.commit([withdraw(), { kind: 'ticket.update', ticketId: ticketId(), claimantId: worker, patch: { question: 'Different?' } }, post()]);
  expect((await f.state()).deskQuestions?.map(q => q.question)).toEqual(['Which route?', 'Different?']);
});

test('request supersession between prepare and commit invalidates the old authorization without a head change', async () => {
  const f = await fixture(); await settled(f); const r = await f.file(); f.tick(); f.take();
  const p = await f.prepare([reopen()], r.requestId); if (p.kind !== 'prepared') throw Error('prepare');
  const replacement = await f.file();
  expect(await f.storage.adapter.commit(p.change)).toMatchObject({ rejection: { code: 'reopen_request_inactive' } });
  expect(f.inspect().desk.reopenRequests).toEqual([expect.objectContaining({ requestId: replacement.requestId, state: 'pending' })]);
});

test('independent connections cannot take twice; submitted answer edits after Settlement fail', async () => {
  const f = await fixture(); await published(f); const a = f.answer(); f.tick();
  const second = sqliteLifecycleForTests({ now: () => '2026-10-27T00:01:00.000Z' }).open(f.path);
  try {
    expect(f.take().items).toEqual([a]); expect(updated(second.desk.takeEligible(mapId, worker)).items).toEqual([]);
    await f.commit([settle(a)]);
    expect(second.desk.submitAnswers(mapId, [{ questionId: 'Q.A', questionVersion: 1, choice: { option: 1 } }])).toMatchObject({ code: 'question_changed' });
  } finally { second.close(); }
});

test('cross-Map request citation and source Question IDs cannot borrow another Map authorization', async () => {
  const f = await fixture(); await settled(f); const r = await f.file(); f.tick(); f.take();
  const otherMap = id('Map', 'second'); const c = prepareCreate({ id: otherMap, title: 'Second', destination: 'Separate', author });
  if (c.kind !== 'ok') throw Error('create'); await f.storage.adapter.commit(c.value);
  expect(prepareApply(c.value.next, { mapId: otherMap, expectedRevision: 1, author, commands: [create()], reopenRequestId: r.requestId }, f.storage.desk.read(otherMap)))
    .toMatchObject({ rejection: { code: 'reopen_request_not_found' } });
});

test('failed human submission and failed standalone publication preserve desk state, quiet time and history', async () => {
  let fail = false; const f = await fixture(() => { if (fail) throw Error('injected'); });
  await f.commit([create(), claim()]); const before = f.inspect(); fail = true;
  await expect(f.apply([post()])).rejects.toMatchObject({ outcome: 'not_published' }); fail = false;
  expect(f.inspect()).toEqual(before); await f.commit([post()]); const publishedState = f.inspect(); fail = true;
  expect(() => f.answer()).toThrow(); fail = false;
  expect(f.inspect()).toEqual(publishedState); expect(f.storage.desk.read(mapId).quietUntil).toBeUndefined();
});
