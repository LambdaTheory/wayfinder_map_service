import { expect, test } from 'vitest';
import { calculateFrontier, createMemoryAdapter, decodeApplyRequest, parseId, prepareApply, prepareCreate } from '../src/index.js';
import type { ApplyRequest, Command, NonEmpty, StateAdapter, StoredMapState, StoredTicket } from '../src/index.js';
import { createMemoryAdapterWithFault } from '../src/memory-adapter.js';

function id<K extends string>(kind: K, value: string) {
  const parsed = parseId(kind, value);
  if (parsed.kind !== 'ok') throw new Error('Invalid fixture ID');
  return parsed.value;
}
const mapId = id('Map', 'Alpha');
const otherId = id('Map', 'Other');
const a = id('Ticket', 'A');
const b = id('Ticket', 'B');
const session = id('Claimant', 'work:Alpha');
const nextSession = id('Claimant', 'work:Beta');
const author = { actorId: id('Actor', 'kun'), clientId: id('Client', 'codex'), occurredAt: '2026-09-18T04:00:00Z' };
const ticket = (identity: string) => ({ id: id('Ticket', identity), title: `Ticket ${identity}`, question: 'Next step?', type: 'task' as const });
function request(commands: NonEmpty<Command>, expectedRevision: number): ApplyRequest {
  return { mapId, expectedRevision, author, commands };
}
async function current(adapter: StateAdapter, identity = mapId): Promise<StoredMapState> {
  const read = await adapter.readCurrent(identity);
  if (read.kind !== 'found') throw new Error('Expected current Map');
  return read.value;
}
async function commitCommands(adapter: StateAdapter, commands: NonEmpty<Command>) {
  const state = await current(adapter);
  const decoded = decodeApplyRequest(request(commands, state.currentRevision));
  if (decoded.kind !== 'ok') throw new Error(`Expected decoding: ${JSON.stringify(decoded)}`);
  const prepared = prepareApply(state, decoded.value);
  if (prepared.kind !== 'prepared') throw new Error(`Expected preparation: ${JSON.stringify(prepared)}`);
  const committed = await adapter.commit(prepared.change);
  if (committed.kind !== 'committed') throw new Error('Expected commit');
  return committed;
}
async function setup(adapter = createMemoryAdapter()) {
  for (const identity of [mapId, otherId]) {
    const prepared = prepareCreate({ id: identity, title: 'Plan', destination: 'Arrive', author });
    if (prepared.kind !== 'ok') throw new Error('Expected creation');
    if ((await adapter.commit(prepared.value)).kind !== 'committed') throw new Error('Expected create commit');
  }
  await commitCommands(adapter, [{ kind: 'ticket.create', ticket: ticket('A') }, { kind: 'ticket.create', ticket: ticket('B') }]);
  const other = prepareApply(await current(adapter, otherId), { ...request([
    { kind: 'ticket.create', ticket: ticket('A') }, { kind: 'ticket.create', ticket: ticket('Outside') },
    { kind: 'claim.acquire', ticketId: id('Ticket', 'Outside'), claimantId: nextSession },
  ], 1), mapId: otherId });
  if (other.kind !== 'prepared' || (await adapter.commit(other.change)).kind !== 'committed') throw new Error('Expected populated unrelated Map');
  return adapter;
}
async function observe(adapter: StateAdapter, head: number) {
  return structuredClone(await Promise.all([mapId, otherId, id('Map', 'Missing')].map(async identity => ({
    current: await adapter.readCurrent(identity),
    history: await Promise.all(Array.from({ length: head + 1 }, (_, index) => adapter.readRevision(identity, index + 1))),
  }))));
}

test('C01/A01/H01: acquire uses the logical session, prepares privately, and commits one exact full historical Revision', async () => {
  const adapter = await setup();
  const state = await current(adapter);
  const before = await observe(adapter, 2);
  const raw = { mapId, expectedRevision: 2, author, commands: [{ kind: 'claim.acquire', ticketId: a, claimantId: session }] };
  const original = structuredClone(raw);
  const decoded = decodeApplyRequest(raw);
  expect(decoded.kind).toBe('ok');
  if (decoded.kind !== 'ok') throw new Error('Expected Claim decoding');
  const prepared = prepareApply(state, decoded.value);
  if (prepared.kind !== 'prepared') throw new Error(`Expected Claim preparation: ${JSON.stringify(prepared)}`);
  expect(prepared.frontier).toEqual(['B']);
  expect(prepareApply(state, decoded.value)).toEqual(prepared);
  expect(await observe(adapter, 2)).toEqual(before);
  expect(raw).toEqual(original);
  const next = { ...state, currentRevision: 3, tickets: state.tickets.map(t => t.id === a ? { ...t, claim: session } : t) };
  const revision = { mapId, revision: 3, priorRevision: 2, kind: 'apply', author,
    changes: [{ commandIndex: 0, command: 'claim.acquire', subjectId: 'A' }], state: next };
  expect(await adapter.commit(prepared.change)).toEqual({ kind: 'committed', revision, frontier: ['B'] });
  expect(await adapter.readCurrent(mapId)).toEqual({ kind: 'found', value: next });
  expect(await adapter.readRevision(mapId, 3)).toEqual({ kind: 'found', value: revision });
  const after = await observe(adapter, 3);
  expect(after[0]!.history.slice(0, 2)).toEqual(before[0]!.history.slice(0, 2));
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 3)).toEqual(before[1]!.history);
  expect(after[0]!.history[3]).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
});

async function rejectCommands(adapter: StateAdapter, commands: NonEmpty<Command>, rejection: unknown, expectedRevision?: number) {
  const state = await current(adapter);
  const before = await observe(adapter, state.currentRevision);
  const original = structuredClone(state);
  const input = request(commands, expectedRevision ?? state.currentRevision);
  const originalInput = structuredClone(input);
  expect(prepareApply(state, input)).toEqual({ kind: 'rejected', rejection });
  expect(state).toEqual(original);
  expect(input).toEqual(originalInput);
  expect(await observe(adapter, state.currentRevision)).toEqual(before);
}

test.each([session, nextSession])('C01/A03: repeated acquisition by %s rejects at its submitted position without changing any Map/history', async claimantId => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  await rejectCommands(adapter, [{ kind: 'map.update', patch: { notes: 'Not published' } },
    { kind: 'claim.acquire', ticketId: a, claimantId }],
  { stage: 'command', commandIndex: 1, code: 'ticket_already_claimed', ticketIds: ['A'] });
});

test.each(['claim.acquire', 'claim.release', 'claim.clear'] as const)('C01/C03/C04: %s cannot target a Ticket present only in another Map', async kind => {
  const adapter = await setup();
  const command: Command = kind === 'claim.clear'
    ? { kind, ticketId: id('Ticket', 'Outside'), expectedClaimantId: nextSession, reason: 'Manual correction' }
    : { kind, ticketId: id('Ticket', 'Outside'), claimantId: nextSession };
  await rejectCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }, command],
    { stage: 'command', commandIndex: 1, code: 'ticket_not_found', ticketIds: ['Outside'] });
});

test.each(['claim.release', 'claim.clear'] as const)('C03/C04/A03: %s distinguishes absent from mismatched Claim and rejects the whole batch', async kind => {
  const adapter = await setup();
  const command: Command = kind === 'claim.clear'
    ? { kind, ticketId: a, expectedClaimantId: nextSession, reason: 'Manual correction' }
    : { kind, ticketId: a, claimantId: nextSession };
  await rejectCommands(adapter, [{ kind: 'map.update', patch: { notes: 'Absent' } }, command],
    { stage: 'command', commandIndex: 1, code: 'claim_not_found', ticketIds: ['A'] });
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  await rejectCommands(adapter, [{ kind: 'map.update', patch: { notes: 'Mismatch' } }, command],
    { stage: 'command', commandIndex: 1, code: 'claim_mismatch', ticketIds: ['A'] });
});

test('C01/A04: acquisition checks prerequisites at its command position, not after a later repair', async () => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'dependency.add', dependentId: a, prerequisiteId: b }]);
  await rejectCommands(adapter, [{ kind: 'map.update', patch: { notes: 'Not published' } },
    { kind: 'claim.acquire', ticketId: a, claimantId: session }, { kind: 'dependency.remove', dependentId: a, prerequisiteId: b }],
  { stage: 'command', commandIndex: 1, code: 'unsettled_dependency', ticketIds: ['A'] });
  const committed = await commitCommands(adapter, [{ kind: 'dependency.remove', dependentId: a, prerequisiteId: b },
    { kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  expect(committed.frontier).toEqual(['B']);
  expect(committed.revision.state.tickets[0]).toEqual({ ...ticket('A'), extensions: {}, prerequisites: [], status: 'open', claim: session });
});

const edits: Command[] = [
  { kind: 'ticket.update', ticketId: a, patch: { title: 'Changed' } },
  { kind: 'dependency.add', dependentId: a, prerequisiteId: b },
  { kind: 'dependency.remove', dependentId: a, prerequisiteId: b },
];
test.each(edits.flatMap(command => [undefined, nextSession].map(claimantId => ({ command, claimantId }))))(
  'C02/A03: $command.kind needs matching session $claimantId even with a fresh head', async ({ command, claimantId }) => {
    const adapter = await setup();
    await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
    const accessed = { ...command, ...(claimantId === undefined ? {} : { claimantId }) } as Command;
    await rejectCommands(adapter, [{ kind: 'map.update', patch: { notes: 'Fresh head is not authority' } }, accessed],
      { stage: 'command', commandIndex: 1, code: claimantId === undefined ? 'claim_required' : 'claim_mismatch', ticketIds: ['A'] });
  });

test('C02/A06: matched dependency and Ticket edits use the live Claim, while unclaimed planning needs no Claim', async () => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const committed = await commitCommands(adapter, [
    { kind: 'dependency.add', dependentId: a, prerequisiteId: b, claimantId: session },
    { kind: 'dependency.remove', dependentId: a, prerequisiteId: b, claimantId: session },
    { kind: 'ticket.update', ticketId: a, patch: { title: 'Matched' }, claimantId: session },
    { kind: 'ticket.update', ticketId: b, patch: { question: 'Unclaimed planning' } },
  ]);
  expect(committed.revision.state.tickets).toEqual([
    { ...ticket('A'), title: 'Matched', extensions: {}, prerequisites: [], status: 'open', claim: session },
    { ...ticket('B'), question: 'Unclaimed planning', extensions: {}, prerequisites: [], status: 'open', claim: null },
  ]);
  expect(committed.frontier).toEqual(['B']);
});

test('G05: adding an open prerequisite cannot silently clear a live Claim', async () => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  await rejectCommands(adapter, [{ kind: 'dependency.add', dependentId: a, prerequisiteId: b, claimantId: session }],
    { stage: 'final_state', code: 'claimed_ticket_has_open_prerequisite', ticketIds: ['A', 'B'] });
});

test.each(['claim.release', 'claim.clear'] as const)('G05/A06: explicit %s after adding an open prerequisite permits a valid final state', async kind => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const command: Command = kind === 'claim.clear'
    ? { kind, ticketId: a, expectedClaimantId: session, reason: 'Dependency changed' }
    : { kind, ticketId: a, claimantId: session };
  const committed = await commitCommands(adapter, [{ kind: 'dependency.add', dependentId: a, prerequisiteId: b, claimantId: session }, command]);
  expect(committed.revision.revision).toBe(4);
  expect(committed.frontier).toEqual(['B']);
  expect(committed.revision.state.tickets[0]).toEqual({ ...ticket('A'), extensions: {}, prerequisites: ['B'], status: 'open', claim: null });
});

test.each(['claim.release', 'claim.clear'] as const)('C05: %s then acquire a different session is one Revision, not an intermediate unclaimed head', async kind => {
  const adapter = await setup();
  const claimed = await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const command: Command = kind === 'claim.clear'
    ? { kind, ticketId: a, expectedClaimantId: session, reason: ' New owner\n' }
    : { kind, ticketId: a, claimantId: session };
  const transferred = await commitCommands(adapter, [command, { kind: 'claim.acquire', ticketId: a, claimantId: nextSession }]);
  expect(transferred.revision.revision).toBe(4);
  expect(transferred.revision.priorRevision).toBe(3);
  expect(transferred.revision.state.tickets[0]!.claim).toBe(nextSession);
  expect(transferred.frontier).toEqual(['B']);
  expect(transferred.revision.changes).toEqual([
    { commandIndex: 0, command: kind, subjectId: 'A', ...(kind === 'claim.clear' ? { reason: ' New owner\n' } : {}) },
    { commandIndex: 1, command: 'claim.acquire', subjectId: 'A' },
  ]);
  expect(await adapter.readRevision(mapId, 3)).toEqual({ kind: 'found', value: claimed.revision });
  expect(await adapter.readRevision(mapId, 5)).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
});

test('C03: a release may record its exact reason; omitting it records none', async () => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const released = await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: session, reason: ' Research unfinished\n' }]);
  expect(released.revision.state.tickets[0]!.claim).toBeNull();
  expect(released.revision.changes).toEqual([{ commandIndex: 0, command: 'claim.release', subjectId: 'A', reason: ' Research unfinished\n' }]);
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const plain = await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: session }]);
  expect(plain.revision.changes).toEqual([{ commandIndex: 0, command: 'claim.release', subjectId: 'A' }]);
});

test('C05/A07: cancelling Claim batches and changed author/reason alone are not business changes', async () => {
  const adapter = await setup();
  await rejectCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session },
    { kind: 'claim.release', ticketId: a, claimantId: session }], { stage: 'final_state', code: 'no_changes' });
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  for (const first of [
    { kind: 'claim.release', ticketId: a, claimantId: session },
    { kind: 'claim.clear', ticketId: a, expectedClaimantId: session, reason: 'Reason is metadata, not a net change' },
  ] as const) {
    await rejectCommands(adapter, [first, { kind: 'claim.acquire', ticketId: a, claimantId: session }],
      { stage: 'final_state', code: 'no_changes' });
  }
  const before = await observe(adapter, 3);
  expect(prepareApply(await current(adapter), { ...request([
    { kind: 'claim.release', ticketId: a, claimantId: session }, { kind: 'claim.acquire', ticketId: a, claimantId: session },
  ], 3), author: { ...author, actorId: id('Actor', 'other-actor'), occurredAt: '2020-01-01T00:00:00Z' } }))
    .toEqual({ kind: 'rejected', rejection: { stage: 'final_state', code: 'no_changes' } });
  expect(await observe(adapter, 3)).toEqual(before);
});

test('C06: one logical work session may reserve multiple eligible Tickets with no quota or actor equality', async () => {
  const adapter = await setup();
  const committed = await commitCommands(adapter, [
    { kind: 'claim.acquire', ticketId: a, claimantId: session }, { kind: 'claim.acquire', ticketId: b, claimantId: session },
  ]);
  expect(committed.frontier).toEqual([]);
  expect(committed.revision.state.tickets).toEqual(['A', 'B'].map(identity => ({
    ...ticket(identity), extensions: {}, prerequisites: [], status: 'open', claim: session,
  })));
  expect(committed.revision.author).toEqual(author);
  expect(await adapter.readRevision(mapId, 3)).toEqual({ kind: 'found', value: committed.revision });
});

function settledTicket(identity: string): StoredTicket {
  return { ...ticket(identity), extensions: {}, prerequisites: [], status: 'settled', claim: null, settlement: {
    outcome: { kind: 'completion', statement: 'Done' }, evidence: [], references: [],
    provenance: { method: 'fixture only', sources: [] }, extensions: {}, introducedAtRevision: 1,
  } };
}
test.each(['claim.acquire', 'claim.release', 'claim.clear'] as const)('C01/C03/C04: %s rejects settled targets before Claim gates using a coherent pure fixture', async kind => {
  const adapter = await setup();
  const state = await current(adapter);
  const fixture = { ...state, tickets: [settledTicket('A'), state.tickets[1]!] };
  const original = structuredClone(fixture);
  const before = await observe(adapter, 2);
  const command: Command = kind === 'claim.clear'
    ? { kind, ticketId: a, expectedClaimantId: session, reason: 'Not an implicit reopen' }
    : { kind, ticketId: a, claimantId: session };
  expect(prepareApply(fixture, request([command], 2))).toEqual({ kind: 'rejected', rejection: {
    stage: 'command', commandIndex: 0, code: 'ticket_not_open', ticketIds: ['A'],
  } });
  expect(fixture).toEqual(original);
  expect(await observe(adapter, 2)).toEqual(before);
});

test('C01/G01: acquisition requires all prerequisites settled; coherent stored-result fixtures do not add an import/settlement command', async () => {
  const adapter = await setup();
  const state = await current(adapter);
  const before = await observe(adapter, 2);
  const dependent = { ...ticket('A'), extensions: {}, prerequisites: [b, id('Ticket', 'C')], status: 'open' as const, claim: null };
  const blocked = { ...state, tickets: [dependent, settledTicket('B'),
    { ...ticket('C'), extensions: {}, prerequisites: [], status: 'open' as const, claim: null }] };
  const eligible = { ...state, tickets: [dependent, settledTicket('B'), settledTicket('C')] };
  const input = request([{ kind: 'claim.acquire', ticketId: a, claimantId: session }], 2);
  const originals = structuredClone([blocked, eligible, input]);
  expect(prepareApply(blocked, input)).toEqual({ kind: 'rejected', rejection: {
    stage: 'command', commandIndex: 0, code: 'unsettled_dependency', ticketIds: ['A'],
  } });
  const prepared = prepareApply(eligible, input);
  if (prepared.kind !== 'prepared') throw new Error('Expected satisfied AND prerequisites');
  expect(prepared.frontier).toEqual([]);
  expect(prepared.change.next.tickets).toEqual([{ ...dependent, claim: session }, settledTicket('B'), settledTicket('C')]);
  expect([blocked, eligible, input]).toEqual(originals);
  expect(await observe(adapter, 2)).toEqual(before);
});

test('C04/A05: a stale clear cannot override a newly transferred Claim, even if its former claimant matches the old snapshot', async () => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const old = await current(adapter);
  const clear = request([{ kind: 'claim.clear', ticketId: a, expectedClaimantId: session, reason: 'Former session' }], 3);
  const proposal = prepareApply(old, clear);
  if (proposal.kind !== 'prepared') throw new Error('Expected old-head proposal');
  await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: session },
    { kind: 'claim.acquire', ticketId: a, claimantId: nextSession }]);
  const before = await observe(adapter, 4);
  const conflict = { kind: 'conflict', conflict: { mapId, expectedRevision: 3, currentRevision: 4 } };
  expect(prepareApply(await current(adapter), clear)).toEqual(conflict);
  expect(await adapter.commit(proposal.change)).toEqual(conflict);
  expect(await observe(adapter, 4)).toEqual(before);
  await rejectCommands(adapter, clear.commands, { stage: 'command', commandIndex: 0, code: 'claim_mismatch', ticketIds: ['A'] });
});

const claimKinds = ['claim.acquire', 'claim.release', 'claim.clear'] as const;
type ClaimKind = typeof claimKinds[number];
function rawClaim(kind: ClaimKind): Record<string, unknown> {
  return kind === 'claim.clear' ? { kind, ticketId: 'A', expectedClaimantId: 'work:Alpha', reason: ' Manual override\n' }
    : { kind, ticketId: 'A', claimantId: 'work:Alpha' };
}
const invalidIds: unknown[] = [undefined, null, 12, {}, '', '-bad', '_bad', '.bad', ':bad', 'bad id', ' bad', 'bad\n', '♥', 'a'.repeat(129)];
const invalidClaims = claimKinds.flatMap(kind => ['ticketId', kind === 'claim.clear' ? 'expectedClaimantId' : 'claimantId']
  .flatMap(key => invalidIds.map((value, index) => ({ label: `${kind} ${key} invalid value ${index}`, command: { ...rawClaim(kind), [key]: value }, path: [key] }))));
invalidClaims.push(...claimKinds.flatMap(kind => [
  ...(['claimId', 'sessionId', 'actorId', 'clientId', 'occurredAt', 'lease', 'expiresAt', 'quota', 'claim', 'status', 'admin', 'introducedAtRevision'] as const)
    .map(key => ({ label: `${kind} unsupported ${key}`, command: { ...rawClaim(kind), [key]: 'not a core field' }, path: [key] })),
  { label: `${kind} wrong access key`, command: { ...rawClaim(kind), [kind === 'claim.clear' ? 'claimantId' : 'expectedClaimantId']: 'work:Alpha' },
    path: [kind === 'claim.clear' ? 'claimantId' : 'expectedClaimantId'] },
]));
invalidClaims.push(...[undefined, null, 10, '', ' \n\t'].map((reason, index) => ({
  label: `clear invalid reason ${index}`, command: { ...rawClaim('claim.clear'), reason }, path: ['reason'],
})));
invalidClaims.push(...[undefined, null, 10, '', ' \n\t'].map((reason, index) => ({
  label: `release present but invalid reason ${index}`, command: { ...rawClaim('claim.release'), reason }, path: ['reason'],
})));
invalidClaims.push({ label: 'claim.acquire reason', command: { ...rawClaim('claim.acquire'), reason: 'Not accepted on acquire' }, path: ['reason'] });
test.each(invalidClaims)('V03/V04/A02: $label rejects the complete raw/typed request before earlier execution and stale comparison', async ({ command, path }) => {
  const adapter = await setup();
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const state = await current(adapter);
  const before = await observe(adapter, 3);
  const raw = { mapId, expectedRevision: 99, author, commands: [
    { kind: 'claim.clear', ticketId: a, expectedClaimantId: session, reason: 'Must not publish' }, command,
  ] };
  const original = structuredClone(raw);
  const expectedPath = ['commands', 1, ...path];
  expect(decodeApplyRequest(raw)).toMatchObject({ kind: 'error', error: { code: 'invalid_input', path: expectedPath } });
  expect(prepareApply(state, raw as unknown as ApplyRequest)).toMatchObject({ kind: 'rejected', rejection: {
    stage: 'input', error: { code: 'invalid_input', path: expectedPath },
  } });
  expect(raw).toEqual(original);
  expect(await observe(adapter, 3)).toEqual(before);
});

test.each(claimKinds)('V04/A02: %s rejects accessor metadata without evaluating getters', async kind => {
  const adapter = await setup();
  const before = await observe(adapter, 2);
  const key = kind === 'claim.clear' ? 'expectedClaimantId' : 'claimantId';
  const command = Object.defineProperty(rawClaim(kind), key, { enumerable: true, get() { throw new Error('Getter must not execute'); } });
  const raw = { mapId, expectedRevision: 2, author, commands: [command] };
  expect(decodeApplyRequest(raw)).toMatchObject({ kind: 'error', error: { path: ['commands', 0, key] } });
  expect(prepareApply(await current(adapter), raw as unknown as ApplyRequest)).toMatchObject({ kind: 'rejected', rejection: {
    stage: 'input', error: { path: ['commands', 0, key] },
  } });
  expect(await observe(adapter, 2)).toEqual(before);
});

test.each(['x', 'a'.repeat(128), 'Aa-._:9', 'constructor', 'toString', 'Work', 'work'])('V03/C04: opaque session %s retains exact spelling through acquire, release and clear', async identity => {
  const adapter = await setup();
  const claimantId = id('Claimant', identity);
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId }]);
  const released = await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId }]);
  expect(released.frontier).toEqual(['A', 'B']);
  const claimed = await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId }]);
  expect(claimed.revision.state.tickets[0]!.claim).toBe(identity);
  const cleared = await commitCommands(adapter, [{ kind: 'claim.clear', ticketId: a, expectedClaimantId: claimantId, reason: ' Exact reason\n' }]);
  expect(cleared.frontier).toEqual(['A', 'B']);
  expect(cleared.revision.changes).toEqual([{ commandIndex: 0, command: 'claim.clear', subjectId: 'A', reason: ' Exact reason\n' }]);
  expect(await adapter.readRevision(mapId, 5)).toEqual({ kind: 'found', value: claimed.revision });
});

test('S04/C01/C02: two same-head Claim writers produce one exact commit and one Conflict; rereading does not permit takeover', async () => {
  const adapter = await setup();
  const state = await current(adapter);
  const before = await observe(adapter, 2);
  const proposals = [session, nextSession].map(claimantId => {
    const prepared = prepareApply(state, request([{ kind: 'claim.acquire', ticketId: a, claimantId }], 2));
    if (prepared.kind !== 'prepared') throw new Error('Expected competing preparation');
    return prepared.change;
  });
  expect(await observe(adapter, 2)).toEqual(before);
  const results = await Promise.all(proposals.map(proposal => adapter.commit(proposal)));
  expect(results.filter(result => result.kind === 'committed')).toHaveLength(1);
  expect(results.filter(result => result.kind === 'conflict')).toEqual([
    { kind: 'conflict', conflict: { mapId, expectedRevision: 2, currentRevision: 3 } },
  ]);
  const winner = results.find(result => result.kind === 'committed');
  if (!winner || winner.kind !== 'committed') throw new Error('Expected winner');
  const stored = await current(adapter);
  expect(stored).toEqual(winner.revision.state);
  expect(winner.frontier).toEqual(['B']);
  const wonSession = stored.tickets[0]!.claim;
  expect([session, nextSession]).toContain(wonSession);
  const lostSession = wonSession === session ? nextSession : session;
  const after = await observe(adapter, 3);
  expect(after[0]!.history.slice(0, 2)).toEqual(before[0]!.history.slice(0, 2));
  expect(after[0]!.history[2]).toEqual({ kind: 'found', value: winner.revision });
  expect(after[0]!.history[3]).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 3)).toEqual(before[1]!.history);
  for (const proposal of proposals) {
    expect(await adapter.commit(proposal)).toEqual({ kind: 'conflict', conflict: { mapId, expectedRevision: 2, currentRevision: 3 } });
    expect(await observe(adapter, 3)).toEqual(after);
  }
  await rejectCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: lostSession }],
    { stage: 'command', commandIndex: 0, code: 'ticket_already_claimed', ticketIds: ['A'] });
  await rejectCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: lostSession }],
    { stage: 'command', commandIndex: 0, code: 'claim_mismatch', ticketIds: ['A'] });
  await rejectCommands(adapter, [{ kind: 'claim.clear', ticketId: a, expectedClaimantId: lostSession, reason: 'Fresh head is insufficient' }],
    { stage: 'command', commandIndex: 0, code: 'claim_mismatch', ticketIds: ['A'] });
  await rejectCommands(adapter, [{ kind: 'ticket.update', ticketId: a, claimantId: lostSession, patch: { title: 'Takeover' } }],
    { stage: 'command', commandIndex: 0, code: 'claim_mismatch', ticketIds: ['A'] });
});

test('S09: failure before publishing a Claim transfer preserves all current/history records; explicit retry can then commit', async () => {
  let fail = false;
  const adapter = await setup(createMemoryAdapterWithFault(() => { if (fail) throw new Error('Claim publication failed'); }));
  await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const prepared = prepareApply(await current(adapter), request([
    { kind: 'claim.clear', ticketId: a, expectedClaimantId: session, reason: 'Transfer' },
    { kind: 'claim.acquire', ticketId: a, claimantId: nextSession },
  ], 3));
  if (prepared.kind !== 'prepared') throw new Error('Expected transfer');
  const before = await observe(adapter, 3);
  fail = true;
  await expect(adapter.commit(prepared.change)).rejects.toThrow('Claim publication failed');
  expect(await observe(adapter, 3)).toEqual(before);
  fail = false;
  const committed = await adapter.commit(prepared.change);
  expect(committed).toMatchObject({ kind: 'committed', revision: { revision: 4, state: { tickets: [{ id: 'A', claim: nextSession }, { id: 'B', claim: null }] } } });
  const after = await observe(adapter, 4);
  expect(after[0]!.history.slice(0, 3)).toEqual(before[0]!.history.slice(0, 3));
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 4)).toEqual(before[1]!.history);
});

function attemptMutation(change: () => void) {
  try { change(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
}
test.each(['typed', 'decoded'] as const)('S10/H03: Claim state, reason and author through %s inputs/preparations/reads/commits cannot alias stored history', async boundary => {
  const adapter = await setup();
  const claimed = await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const raw = { mapId, expectedRevision: 3, author: { ...author }, commands: [
    { kind: 'claim.clear' as const, ticketId: a, expectedClaimantId: session, reason: ' Original reason\n' },
    { kind: 'claim.acquire' as const, ticketId: a, claimantId: nextSession },
  ] };
  const typed = raw as unknown as ApplyRequest;
  const decoded = decodeApplyRequest(raw);
  if (decoded.kind !== 'ok') throw new Error('Expected decoded transfer');
  const input = boundary === 'typed' ? typed : decoded.value;
  const state = structuredClone(await current(adapter));
  const prepared = prepareApply(state, input);
  if (prepared.kind !== 'prepared') throw new Error('Expected detached transfer');
  (raw.commands[0] as { reason: string }).reason = 'Changed original reason';
  (raw.commands[1] as { claimantId: unknown }).claimantId = session;
  raw.author.occurredAt = '2020-01-01T00:00:00Z';
  attemptMutation(() => { (state.tickets[0] as { claim: unknown }).claim = null; });
  attemptMutation(() => { (prepared.change.next.tickets[0] as { claim: unknown }).claim = session; });
  attemptMutation(() => { (prepared.change.changes[0] as { reason: string }).reason = 'Changed prepared reason'; });
  attemptMutation(() => { (prepared.change.author as { occurredAt: string }).occurredAt = '2020-01-01T00:00:00Z'; });
  attemptMutation(() => { (input.commands[0] as { expectedClaimantId: unknown }).expectedClaimantId = nextSession; });
  const committed = await adapter.commit(prepared.change);
  if (committed.kind !== 'committed') throw new Error('Expected isolated commit');
  expect(committed.revision.state.tickets[0]!.claim).toBe(nextSession);
  expect(committed.revision.changes[0]!.reason).toBe(' Original reason\n');
  expect(committed.revision.author).toEqual(author);
  const before = await observe(adapter, 4);
  const read = await adapter.readRevision(mapId, 4);
  if (read.kind !== 'found') throw new Error('Expected history');
  for (const revision of [claimed.revision, committed.revision, read.value]) {
    attemptMutation(() => { (revision.state.tickets[0] as { claim: unknown }).claim = null; });
    attemptMutation(() => { (revision.changes[0] as { reason: string }).reason = 'Changed exposed reason'; });
    attemptMutation(() => { (revision.author as { actorId: unknown }).actorId = session; });
  }
  const latest = await current(adapter);
  attemptMutation(() => { (latest.tickets[0] as { claim: unknown }).claim = null; });
  expect(await observe(adapter, 4)).toEqual(before);
  const released = await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: nextSession }]);
  expect(released.frontier).toEqual(['A', 'B']);
  expect(await adapter.readRevision(mapId, 4)).toEqual(before[0]!.history[3]);
  expect(committed.frontier).toEqual(['B']);
  expect(committed.revision.revision).toBe(4);
  const after = await observe(adapter, 5);
  expect(await adapter.readRevision(mapId, 3)).toEqual(before[0]!.history[2]);
  expect(await observe(adapter, 5)).toEqual(after);
});

test('C03/H03: release only the matched Claim; historical reads do not restore it or move the head', async () => {
  const adapter = await setup();
  const claimed = await commitCommands(adapter, [
    { kind: 'claim.acquire', ticketId: a, claimantId: session },
    { kind: 'claim.acquire', ticketId: b, claimantId: nextSession },
  ]);
  const before = await observe(adapter, 3);
  const released = await commitCommands(adapter, [{ kind: 'claim.release', ticketId: a, claimantId: session }]);
  expect(released).toEqual({ kind: 'committed', frontier: ['A'], revision: {
    mapId, revision: 4, priorRevision: 3, kind: 'apply', author,
    changes: [{ commandIndex: 0, command: 'claim.release', subjectId: 'A' }],
    state: { ...claimed.revision.state, currentRevision: 4,
      tickets: claimed.revision.state.tickets.map(t => t.id === a ? { ...t, claim: null } : t) },
  } });
  const after = await observe(adapter, 4);
  expect(after[0]!.history.slice(0, 3)).toEqual(before[0]!.history.slice(0, 3));
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 4)).toEqual(before[1]!.history);
  expect(await adapter.readRevision(mapId, 3)).toEqual({ kind: 'found', value: claimed.revision });
  expect(await observe(adapter, 4)).toEqual(after);
  expect(calculateFrontier(await current(adapter))).toEqual(['A']);
});

test('C04/C05/A06/H02/H04: deliberate clear and different-session acquire transfer once with exact ordered reason', async () => {
  const adapter = await setup();
  const claimed = await commitCommands(adapter, [{ kind: 'claim.acquire', ticketId: a, claimantId: session }]);
  const before = await observe(adapter, 3);
  const reason = '  Session abandoned; take over\n';
  const transferred = await commitCommands(adapter, [
    { kind: 'map.update', patch: { notes: 'Transfer recorded' } },
    { kind: 'claim.clear', ticketId: a, expectedClaimantId: session, reason },
    { kind: 'claim.acquire', ticketId: a, claimantId: nextSession },
  ]);
  expect(transferred).toEqual({ kind: 'committed', frontier: ['B'], revision: {
    mapId, revision: 4, priorRevision: 3, kind: 'apply', author,
    changes: [{ commandIndex: 0, command: 'map.update', subjectId: 'Alpha' },
      { commandIndex: 1, command: 'claim.clear', subjectId: 'A', reason },
      { commandIndex: 2, command: 'claim.acquire', subjectId: 'A' }],
    state: { ...claimed.revision.state, notes: 'Transfer recorded', currentRevision: 4,
      tickets: claimed.revision.state.tickets.map(t => t.id === a ? { ...t, claim: nextSession } : t) },
  } });
  const after = await observe(adapter, 4);
  expect(after[0]!.history.slice(0, 3)).toEqual(before[0]!.history.slice(0, 3));
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 4)).toEqual(before[1]!.history);
  expect(after[0]!.history[3]).toEqual({ kind: 'found', value: transferred.revision });
  expect(after[0]!.history[4]).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
  expect(await adapter.readRevision(mapId, 3)).toEqual({ kind: 'found', value: claimed.revision });
  expect(await observe(adapter, 4)).toEqual(after);
});
