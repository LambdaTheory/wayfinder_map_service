import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { createMemoryAdapter, parseId, prepareApply, prepareCreate } from '../src/index.js';
import type { ApplyRequest, Command, MapId, PreparedCommit, StateAdapter, StoredMapState } from '../src/index.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import { initializeSQLite, openSQLite } from '../src/sqlite-storage.js';
import { assertPrivate } from '../src/private-paths.js';

const directories: string[] = [];
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-sqlite-')));
  directories.push(directory);
  return join(directory, 'private', 'maps.sqlite');
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
function id(value: string) {
  const result = parseId('Map', value);
  if (result.kind !== 'ok') throw new Error('Invalid fixture');
  return result.value;
}
const author = { actorId: parseId('Actor', 'kun'), clientId: parseId('Client', 'codex') };
function creation(mapId = 'Alpha') {
  if (author.actorId.kind !== 'ok' || author.clientId.kind !== 'ok') throw new Error('Invalid fixture');
  const result = prepareCreate({ id: id(mapId), title: `${mapId} route`, destination: 'Usable core',
    author: { actorId: author.actorId.value, clientId: author.clientId.value, occurredAt: '2026-09-18T03:00:00Z' } });
  if (result.kind !== 'ok') throw new Error('Invalid fixture');
  return result.value;
}
function application(current: StoredMapState, commands: [Command, ...Command[]]) {
  const result = prepareApply(current, { mapId: current.id, expectedRevision: current.currentRevision,
    author: creation().author, commands });
  if (result.kind !== 'prepared') throw new Error(JSON.stringify(result));
  return result.change;
}
async function observe(adapter: StateAdapter) {
  return Promise.all(['Alpha', 'Other'].map(async value => ({ current: await adapter.readCurrent(id(value)),
    revisions: await Promise.all([1, 2, 3].map(revision => adapter.readRevision(id(value), revision))) })));
}

test('D01: explicit fresh initialization opens an empty durable Adapter', async () => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  try {
    expect(await storage.adapter.readCurrent(id('Alpha'))).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Alpha' });
    expect(await storage.adapter.readRevision(id('Alpha'), 1)).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Alpha' });
  } finally { storage.close(); }
});

test('D03: complete Revision 1 survives close and reopening', async () => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  const prepared = creation();
  try {
    expect(await storage.adapter.commit(prepared)).toEqual({ kind: 'committed', frontier: [], revision: {
      mapId: 'Alpha', revision: 1, priorRevision: null, kind: 'create', author: prepared.author,
      changes: [{ commandIndex: 0, command: 'map.create', subjectId: 'Alpha' }],
      state: { id: 'Alpha', title: 'Alpha route', destination: 'Usable core', notes: '',
        fog: [], scopeExclusions: [], tickets: [], extensions: {}, currentRevision: 1 },
    } });
  } finally { storage.close(); }
  const reopened = lifecycle.open(path);
  try {
    expect(await reopened.adapter.readRevision(id('Alpha'), 1)).toEqual({ kind: 'found', value: {
      mapId: 'Alpha', revision: 1, priorRevision: null, kind: 'create', author: prepared.author,
      changes: [{ commandIndex: 0, command: 'map.create', subjectId: 'Alpha' }], state: prepared.next,
    } });
    expect(await reopened.adapter.readCurrent(id('Alpha'))).toEqual({ kind: 'found', value: prepared.next });
  } finally { reopened.close(); }
});

test.each(['missing', 'empty', 'foreign', 'unsupported'] as const)('D01: normal opening refuses %s without replacing it', (kind) => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  mkdirSync(dirname(path), { mode: 0o700 });
  if (kind === 'empty') writeFileSync(path, '', { mode: 0o600 });
  if (kind === 'foreign' || kind === 'unsupported') {
    lifecycle.initialize(path);
    const db = new DatabaseSync(path);
    db.exec(kind === 'foreign' ? 'PRAGMA application_id=123' : 'PRAGMA user_version=99');
    db.close();
  }
  const before = existsSync(path) ? readFileSync(path) : null;
  expect(() => lifecycle.open(path)).toThrow();
  expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
});

test.each(['empty', 'nonempty'] as const)('D01: initialization refuses an existing %s file unchanged', (kind) => {
  const path = fixture();
  mkdirSync(dirname(path), { mode: 0o700 });
  writeFileSync(path, kind === 'empty' ? '' : 'user data', { mode: 0o600 });
  const before = readFileSync(path);
  expect(() => sqliteLifecycleForTests().initialize(path)).toThrow();
  expect(readFileSync(path)).toEqual(before);
});

test('D02: new directory/database are private and production paths reject temporary/relative storage', () => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  assertPrivate(dirname(path), true);
  assertPrivate(path, false);
  expect(() => initializeSQLite('relative.sqlite')).toThrow();
  expect(() => initializeSQLite(join(process.cwd(), 'must-not-create.sqlite'))).toThrow();
  expect(existsSync(join(process.cwd(), 'must-not-create.sqlite'))).toBe(false);
  expect(() => openSQLite(path)).toThrow();
  const missing = join(dirname(path), 'must-not-create.sqlite');
  expect(() => initializeSQLite(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
});

// Windows ACL/junction/hardlink refusals live in windows-security.test.ts.
test.skipIf(process.platform === 'win32').each(['directory', 'database', 'symlink-file', 'symlink-directory'] as const)('D02: reject unsafe %s without fixing it', (kind) => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  let attempted = path;
  if (kind === 'directory') chmodSync(dirname(path), 0o755);
  if (kind === 'database') chmodSync(path, 0o644);
  if (kind === 'symlink-file') { attempted = join(dirname(path), 'alias.sqlite'); symlinkSync(path, attempted); }
  if (kind === 'symlink-directory') { const alias = join(dirname(dirname(path)), 'alias'); symlinkSync(dirname(path), alias); attempted = join(alias, 'maps.sqlite'); }
  const before = readFileSync(path);
  expect(() => lifecycle.open(attempted)).toThrow();
  expect(readFileSync(path)).toEqual(before);
  expect(lstatSync(kind === 'directory' ? dirname(path) : path).mode & 0o777).toBe(kind === 'directory' ? 0o755 : kind === 'database' ? 0o644 : 0o600);
});

test('D02: WAL sidecars are private managed state while the connection is open', () => {
  const path = fixture();
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  const observer = new DatabaseSync(path);
  try {
    expect(observer.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    for (const suffix of ['-wal', '-shm']) {
      assertPrivate(path + suffix, false);
    }
  } finally { observer.close(); storage.close(); }
});

test('D02: real Adapter connections verify WAL, FULL and 100 ms settings on initialization and open', () => {
  const path = fixture();
  const observed: unknown[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observer = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (['PRAGMA journal_mode=WAL', 'PRAGMA synchronous', 'PRAGMA busy_timeout'].includes(sql)) observed.push([sql, statement.get()]);
    return statement;
  });
  try {
    const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path);
    const storage = lifecycle.open(path); storage.close();
    const settings = [['PRAGMA journal_mode=WAL', { journal_mode: 'wal' }], ['PRAGMA synchronous', { synchronous: 2 }], ['PRAGMA busy_timeout', { timeout: 100 }]];
    expect(observed).toEqual([...settings, ...settings]);
  } finally { observer.mockRestore(); }
});

test.skipIf(process.platform === 'win32')('D02: mismatched operator identity refuses owned fixtures without changing state or history', async () => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  await storage.adapter.commit(creation()); await storage.adapter.commit(creation('Other'));
  const before = await observe(storage.adapter); storage.close();
  const bytes = readFileSync(path);
  const uid = process.getuid?.(); if (uid === undefined) throw new Error('POSIX fixture required');
  // Simulate the different process identity, without chowning any fixture or
  // touching another user's files. Filesystem checks and storage remain real.
  const identity = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
  try {
    expect(() => lifecycle.open(path)).toThrow(/ownership/);
    expect(() => lifecycle.initialize(join(dirname(path), 'refused.sqlite'))).toThrow(/ownership/);
    expect(existsSync(join(dirname(path), 'refused.sqlite'))).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
  } finally { identity.mockRestore(); }
  const reopened = lifecycle.open(path);
  try { expect(await observe(reopened.adapter)).toEqual(before); }
  finally { reopened.close(); }
});

test('D04: two real connections serialize same-head and duplicate-create competition without collateral publication', async () => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path);
  const first = lifecycle.open(path); const second = lifecycle.open(path);
  try {
    const initial = creation();
    await first.adapter.commit(initial);
    await first.adapter.commit(creation('Other'));
    const candidates = [application(initial.next, [{ kind: 'map.update', patch: { notes: 'first proposal' } }]),
      application(initial.next, [{ kind: 'map.update', patch: { notes: 'second proposal' } }])];
    const results = await Promise.all([first.adapter.commit(candidates[0]!), second.adapter.commit(candidates[1]!)]);
    const successes = results.filter(result => result.kind === 'committed');
    expect(successes).toHaveLength(1);
    expect(results.filter(result => result.kind === 'conflict')).toEqual([{ kind: 'conflict', conflict: { mapId: 'Alpha', expectedRevision: 1, currentRevision: 2 } }]);
    expect(successes[0]!.revision.revision).toBe(2);
    expect(['first proposal', 'second proposal']).toContain(successes[0]!.revision.state.notes);
    expect(await first.adapter.readCurrent(id('Alpha'))).toEqual({ kind: 'found', value: successes[0]!.revision.state });
    expect(await second.adapter.readRevision(id('Alpha'), 2)).toEqual({ kind: 'found', value: successes[0]!.revision });
    const before = await observe(first.adapter);
    expect(await first.adapter.readRevision(id('Alpha'), 3)).toEqual({ kind: 'not_found', code: 'revision_not_found', mapId: 'Alpha', revision: 3 });
    const duplicate = creation('Race');
    const creates = await Promise.all([first.adapter.commit(duplicate), second.adapter.commit(duplicate)]);
    expect(creates.filter(result => result.kind === 'committed')).toHaveLength(1);
    expect(creates.filter(result => result.kind === 'rejected')).toEqual([{ kind: 'rejected', code: 'map_already_exists', mapId: 'Race' }]);
    expect(await second.adapter.readCurrent(id('Race'))).toEqual({ kind: 'found', value: duplicate.next });
    expect(await first.adapter.readRevision(id('Race'), 2)).toEqual({ kind: 'not_found', code: 'revision_not_found', mapId: 'Race', revision: 2 });
    expect(await observe(first.adapter)).toEqual(before);
    const other = creation('Other');
    const independent = await Promise.all([
      first.adapter.commit(application(successes[0]!.revision.state, [{ kind: 'map.update', patch: { notes: 'independent Alpha' } }])),
      second.adapter.commit(application(other.next, [{ kind: 'map.update', patch: { notes: 'independent Other' } }])),
    ]);
    expect(independent).toMatchObject([{ kind: 'committed', revision: { mapId: 'Alpha', revision: 3 } }, { kind: 'committed', revision: { mapId: 'Other', revision: 2 } }]);
    expect(await first.adapter.readRevision(id('Alpha'), 1)).toMatchObject({ kind: 'found', value: { state: { notes: '' } } });
  } finally { first.close(); second.close(); }
});

test.each([0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('D05: invalid read revision %s does not publish', async revision => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); const storage = lifecycle.open(path);
  try {
    await storage.adapter.commit(creation()); await storage.adapter.commit(creation('Other'));
    const before = await observe(storage.adapter);
    expect(await storage.adapter.readRevision(id('Alpha'), revision)).toMatchObject({ kind: 'rejected', error: { path: ['revision'] } });
    expect(await storage.adapter.readCurrent(' bad' as MapId)).toMatchObject({ kind: 'rejected', error: { path: ['mapId'] } });
    expect(await observe(storage.adapter)).toEqual(before);
  } finally { storage.close(); }
});

test.each([{ mapId: 'Other' }, { priorRevision: 1 }, { next: { id: 'Alpha', currentRevision: 2 } }, { kind: 'import' }])('D08: malformed prepared envelope %j never publishes', async patch => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); const storage = lifecycle.open(path);
  try {
    await storage.adapter.commit(creation()); await storage.adapter.commit(creation('Other'));
    const before = await observe(storage.adapter);
    await expect(storage.adapter.commit({ ...creation(), ...patch } as unknown as PreparedCommit)).rejects.toThrow(TypeError);
    expect(await observe(storage.adapter)).toEqual(before);
  } finally { storage.close(); }
});

test('D09: catalog pages have coherent head fields and ASCII lexical boundaries, including nonexistent cursor IDs', async () => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); const storage = lifecycle.open(path);
  try {
    for (const mapId of ['alpha', 'Zed', 'Alpha']) await storage.adapter.commit(creation(mapId));
    const changed = application(creation().next, [{ kind: 'map.update', patch: { title: 'Changed', destination: 'New goal' } }]);
    await storage.adapter.commit(changed);
    const before = await observe(storage.adapter);
    expect(storage.listMaps({ limit: 2 })).toEqual({ kind: 'listed', maps: [
      { mapId: 'Alpha', title: 'Changed', destination: 'New goal', currentRevision: 2 },
      { mapId: 'Zed', title: 'Zed route', destination: 'Usable core', currentRevision: 1 },
    ], nextAfterMapId: 'Zed' });
    expect(storage.listMaps({ afterMapId: id('Beta') })).toEqual({ kind: 'listed', maps: [
      { mapId: 'Zed', title: 'Zed route', destination: 'Usable core', currentRevision: 1 },
      { mapId: 'alpha', title: 'alpha route', destination: 'Usable core', currentRevision: 1 },
    ], nextAfterMapId: null });
    expect(storage.listMaps({ afterMapId: id('zz') })).toEqual({ kind: 'listed', maps: [], nextAfterMapId: null });
    expect(await observe(storage.adapter)).toEqual(before);
  } finally { storage.close(); }
});

test('D06: failure after transaction writes but before publication rolls back both head/history and permits the next commit', async () => {
  const path = fixture(); let fail = false;
  const lifecycle = sqliteLifecycleForTests(() => { if (fail) throw new Error('Injected pre-publication failure'); });
  lifecycle.initialize(path); const storage = lifecycle.open(path);
  try {
    await storage.adapter.commit(creation()); await storage.adapter.commit(creation('Other'));
    const before = await observe(storage.adapter); const catalog = storage.listMaps();
    const changed = application(creation().next, [{ kind: 'map.update', patch: { title: 'Rolled back' } }]);
    fail = true;
    await expect(storage.adapter.commit(changed)).rejects.toMatchObject({ outcome: 'not_published', requiresRestart: false });
    expect(await observe(storage.adapter)).toEqual(before); expect(storage.listMaps()).toEqual(catalog);
    fail = false;
    expect(await storage.adapter.commit(changed)).toMatchObject({ kind: 'committed', revision: { revision: 2 } });
  } finally { storage.close(); }
});

function handle<K extends string>(kind: K, value: string) {
  const parsed = parseId(kind, value);
  if (parsed.kind !== 'ok') throw new Error('Invalid fixture ID');
  return parsed.value;
}
async function current(adapter: StateAdapter) {
  const result = await adapter.readCurrent(id('Alpha'));
  if (result.kind !== 'found') throw new Error('Expected state');
  return result.value;
}
async function advance(adapter: StateAdapter, commands: [Command, ...Command[]]) {
  const result = await adapter.commit(application(await current(adapter), commands));
  if (result.kind !== 'committed') throw new Error('Expected commit');
  return result;
}
function conformanceAdapter(kind: 'memory' | 'sqlite') {
  if (kind === 'memory') return { adapter: createMemoryAdapter(), close() {} };
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); return lifecycle.open(path);
}
const commonSettlement = {
  evidence: [{ statement: 'Checked', references: [{ locator: 'opaque:source' }], extensions: { 'demo.evidence': [null, true] } }],
  references: [{ locator: 'artifact:result', label: 'Result' }], provenance: { method: 'inspection', sources: [{ locator: 'session:work' }] },
  extensions: { 'demo.result': { nested: [3, '♥', false] } },
};
const settlementCases = [
  { ticketType: 'grilling' as const, settlement: { ...commonSettlement, outcome: { kind: 'decision' as const, statement: 'Choose', rationale: 'Reviewed' } } },
  { ticketType: 'prototype' as const, settlement: { ...commonSettlement, outcome: { kind: 'decision' as const, statement: 'Choose', rationale: 'Reviewed' } } },
  { ticketType: 'research' as const, settlement: { ...commonSettlement, outcome: { kind: 'finding' as const, statement: 'Limited result', limitations: 'Local only' } } },
  { ticketType: 'task' as const, settlement: { ...commonSettlement, outcome: { kind: 'completion' as const, statement: 'Done', resultingFacts: { nested: [null, true, '♥'] } } } },
];

test.each(['memory', 'sqlite'] as const)('D03/D08/D09 reusable %s conformance: all typed Settlements, Claims, introduction metadata, pinned history and detachment', async kind => {
  const storage = conformanceAdapter(kind); const adapter = storage.adapter;
  const claimantId = handle('Claimant', 'work:Alpha');
  try {
    await adapter.commit(creation()); await adapter.commit(creation('Other'));
    for (const fixture of settlementCases) {
      const ticketId = handle('Ticket', fixture.ticketType);
      await advance(adapter, [{ kind: 'ticket.create', ticket: { id: ticketId, title: fixture.ticketType, question: 'Ready?', type: fixture.ticketType } },
        { kind: 'claim.acquire', ticketId, claimantId }]);
      const pinned = await current(adapter); const historicalClaim = await adapter.readRevision(id('Alpha'), pinned.currentRevision);
      expect(pinned.tickets.at(-1)).toMatchObject({ claim: 'work:Alpha', status: 'open' });
      const command = { kind: 'ticket.settle', ticketId, claimantId, ...fixture } as Command;
      const settled = await advance(adapter, [command]);
      expect(settled.frontier).toEqual(settlementCases.slice(0, settlementCases.indexOf(fixture)).map(value => value.ticketType).sort());
      expect(settled.revision.state.tickets.at(-1)).toMatchObject({ status: 'settled', claim: null,
        settlement: { ...fixture.settlement, introducedAtRevision: settled.revision.revision } });
      expect(await adapter.readRevision(id('Alpha'), settled.revision.revision)).toEqual({ kind: 'found', value: settled.revision });
      const later = await advance(adapter, [{ kind: 'map.update', patch: { notes: fixture.ticketType } }]);
      expect(later.revision.state.tickets.at(-1)).toEqual(settled.revision.state.tickets.at(-1));
      expect(await adapter.readRevision(id('Alpha'), pinned.currentRevision)).toEqual(historicalClaim);
      expect(pinned.tickets.at(-1)).toMatchObject({ status: 'open', claim: 'work:Alpha' });
      expect(() => { (settled.revision.state as { notes: string }).notes = 'corrupt'; }).toThrow();
      await advance(adapter, [{ kind: 'ticket.reopen', ticketId, reason: 'Explicit reconsideration' }]);
      expect(await adapter.readRevision(id('Alpha'), settled.revision.revision)).toEqual({ kind: 'found', value: settled.revision });
    }
    const mutable = structuredClone(application(await current(adapter), [{ kind: 'map.update', patch: { notes: 'Captured' } }])) as PreparedCommit;
    const pending = adapter.commit(mutable);
    (mutable.next as { notes: string }).notes = 'Mutated after invocation';
    const receipt = await pending;
    expect(receipt).toMatchObject({ kind: 'committed', revision: { state: { notes: 'Captured' } } });
    expect(await adapter.readCurrent(id('Other'))).toEqual({ kind: 'found', value: creation('Other').next });
  } finally { storage.close(); }
});

function mutateLeaf(value: unknown, path: readonly (string | number)[]) {
  let object = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) object = object[key] as Record<string | number, unknown>;
  object[path.at(-1)!] = 'Caller mutation';
}
test.each(['memory', 'sqlite'] as const)('D08 reusable %s: nested input/current/prepared/read/receipt aliases cannot change accepted history', async kind => {
  const storage = conformanceAdapter(kind); const adapter = storage.adapter;
  try {
    const input = { id: id('Alpha'), title: 'Alpha', destination: 'Alias isolation', author: creation().author,
      extensions: { 'test.nested': { items: [{ text: 'Original' }] } } };
    const created = prepareCreate(input); if (created.kind !== 'ok') throw new Error('Invalid fixture');
    mutateLeaf(input, ['extensions', 'test.nested', 'items', 0, 'text']);
    await adapter.commit(created.value); await adapter.commit(creation('Other'));
    expect((await current(adapter)).extensions).toEqual({ 'test.nested': { items: [{ text: 'Original' }] } });
    await advance(adapter, [{ kind: 'ticket.create', ticket: { id: handle('Ticket', 'Task'), title: 'Task', question: 'Done?', type: 'task', extensions: { 'test.ticket': { value: 'Original' } } } },
      { kind: 'claim.acquire', ticketId: handle('Ticket', 'Task'), claimantId: handle('Claimant', 'work') },
      { kind: 'content.add', section: 'fog', item: { id: handle('Content', 'F'), text: 'Fog', references: [{ locator: 'fixture:original' }] } }]);
    const before = await observe(adapter);
    const suppliedCurrent = structuredClone(await current(adapter));
    const request = structuredClone({ mapId: id('Alpha'), expectedRevision: 2, author: creation().author,
      commands: [{ kind: 'ticket.settle', ticketId: handle('Ticket', 'Task'), claimantId: handle('Claimant', 'work'), ...settlementCases[3] }] }) as ApplyRequest;
    const prepared = prepareApply(suppliedCurrent, request); if (prepared.kind !== 'prepared') throw new Error('Invalid fixture');
    const expectedNext = structuredClone(prepared.change.next);
    const descriptivePaths = [['extensions', 'test.nested', 'items', 0, 'text'], ['fog', 0, 'references', 0, 'locator'], ['tickets', 0, 'extensions', 'test.ticket', 'value']] as const;
    const settlementPaths = [['outcome', 'resultingFacts', 'nested', 0], ['references', 0, 'locator'], ['references', 0, 'label'],
      ['evidence', 0, 'references', 0, 'locator'], ['evidence', 0, 'extensions', 'demo.evidence', 0],
      ['provenance', 'sources', 0, 'locator'], ['extensions', 'demo.result', 'nested', 0]] as const;
    const statePaths = [...descriptivePaths, ...settlementPaths.map(path => ['tickets', 0, 'settlement', ...path])];
    for (const path of descriptivePaths) mutateLeaf(suppliedCurrent, path);
    for (const path of settlementPaths) mutateLeaf(request, ['commands', 0, 'settlement', ...path]);
    expect(await observe(adapter)).toEqual(before);
    for (const path of statePaths) expect(() => mutateLeaf(prepared.change.next, path)).toThrow();
    const mutablePrepared = structuredClone(prepared.change) as PreparedCommit;
    const pending = adapter.commit(mutablePrepared);
    for (const path of statePaths) mutateLeaf(mutablePrepared.next, path);
    mutateLeaf(mutablePrepared, ['author', 'occurredAt']); mutateLeaf(mutablePrepared, ['changes', 0, 'command']);
    const receipt = await pending; if (receipt.kind !== 'committed') throw new Error('Fixture not committed');
    expect(receipt.revision.state).toEqual(expectedNext);
    expect(receipt.revision.author).toEqual(creation().author);
    const accepted = await observe(adapter);
    const exposed = await current(adapter);
    const historical = await adapter.readRevision(id('Alpha'), 3); if (historical.kind !== 'found') throw new Error('Fixture missing');
    for (const value of [receipt.revision.state, exposed, historical.value.state]) {
      for (const path of statePaths) expect(() => mutateLeaf(value, path)).toThrow();
    }
    expect(await observe(adapter)).toEqual(accepted);
    expect(accepted[0]!.revisions.slice(0, 2)).toEqual(before[0]!.revisions.slice(0, 2));
    expect(accepted[1]).toEqual(before[1]);
    expect(await adapter.readRevision(id('Alpha'), 4)).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
  } finally { storage.close(); }
});

const negativeCommands: { label: string; commands: [Command, ...Command[]]; expected: object }[] = [
  { label: 'no-op', commands: [{ kind: 'map.update', patch: { notes: '' } }], expected: { stage: 'final_state', code: 'no_changes' } },
  { label: 'malformed', commands: [{ kind: 'map.update', patch: {} }], expected: { stage: 'input', error: { code: 'invalid_input' } } },
  { label: 'missing ticket', commands: [{ kind: 'ticket.update', ticketId: handle('Ticket', 'Missing'), patch: { title: 'X' } }], expected: { stage: 'command', commandIndex: 0, code: 'ticket_not_found' } },
  { label: 'claim mismatch', commands: [{ kind: 'claim.release', ticketId: handle('Ticket', 'A'), claimantId: handle('Claimant', 'Wrong') }], expected: { stage: 'command', commandIndex: 0, code: 'claim_mismatch' } },
  { label: 'lifecycle', commands: [{ kind: 'ticket.reopen', ticketId: handle('Ticket', 'B'), reason: 'Already open' }], expected: { stage: 'command', commandIndex: 0, code: 'ticket_not_settled' } },
  { label: 'self dependency', commands: [{ kind: 'dependency.add', dependentId: handle('Ticket', 'B'), prerequisiteId: handle('Ticket', 'B') }], expected: { stage: 'command', commandIndex: 0, code: 'self_dependency' } },
  { label: 'final claimed invariant', commands: [{ kind: 'dependency.add', dependentId: handle('Ticket', 'A'), prerequisiteId: handle('Ticket', 'B'), claimantId: handle('Claimant', 'work') }], expected: { stage: 'final_state', code: 'claimed_ticket_has_open_prerequisite' } },
  { label: 'cycle', commands: [{ kind: 'dependency.add', dependentId: handle('Ticket', 'B'), prerequisiteId: handle('Ticket', 'C') }, { kind: 'dependency.add', dependentId: handle('Ticket', 'C'), prerequisiteId: handle('Ticket', 'B') }], expected: { stage: 'final_state', code: 'dependency_cycle' } },
];
test.each(['memory', 'sqlite'] as const)('D05 reusable %s conformance: whole-shape, Claim, lifecycle, dependency, invariant and no-op rejections publish nothing', async kind => {
  const storage = conformanceAdapter(kind); const adapter = storage.adapter;
  try {
    await adapter.commit(creation()); await adapter.commit(creation('Other'));
    await advance(adapter, [
      { kind: 'ticket.create', ticket: { id: handle('Ticket', 'A'), title: 'A', question: 'Ready?', type: 'task' } },
      ...['B', 'C'].map(value => ({ kind: 'ticket.create' as const, ticket: { id: handle('Ticket', value), title: value, question: 'Ready?', type: 'task' as const } })),
      { kind: 'claim.acquire', ticketId: handle('Ticket', 'A'), claimantId: handle('Claimant', 'work') },
    ]);
    const before = await observe(adapter); const state = await current(adapter);
    for (const scenario of negativeCommands) {
      expect(prepareApply(state, { mapId: state.id, expectedRevision: state.currentRevision, author: creation().author, commands: scenario.commands }), scenario.label)
        .toMatchObject({ kind: 'rejected', rejection: scenario.expected });
      expect(await observe(adapter), scenario.label).toEqual(before);
    }
    const missing = application({ ...state, id: id('Missing') }, [{ kind: 'map.update', patch: { notes: 'No Map' } }]);
    expect(await adapter.commit(missing)).toEqual({ kind: 'rejected', code: 'map_not_found', mapId: 'Missing' });
    expect(await adapter.readCurrent(id('Missing'))).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Missing' });
    expect(await observe(adapter)).toEqual(before);
  } finally { storage.close(); }
});

test.each([0, 101, 1.5, NaN, null])('D09: invalid catalog limit %s is rejected without changes', async limit => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); const storage = lifecycle.open(path);
  try {
    await storage.adapter.commit(creation()); await storage.adapter.commit(creation('Other')); const before = await observe(storage.adapter);
    expect(storage.listMaps({ limit: limit as number })).toMatchObject({ kind: 'rejected', error: { path: ['limit'] } });
    expect(await observe(storage.adapter)).toEqual(before);
  } finally { storage.close(); }
});

test.skipIf(process.platform === 'win32').each(['unsafe', 'dangling-symlink'] as const)('D02: reject %s managed sidecar before opening or modifying the database', kind => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path);
  if (kind === 'unsafe') writeFileSync(path + '-wal', '', { mode: 0o644 });
  else symlinkSync(join(dirname(path), 'absent'), path + '-wal');
  const before = readFileSync(path);
  expect(() => lifecycle.open(path)).toThrow();
  expect(readFileSync(path)).toEqual(before);
});

test('D01: unsupported schema is refused as format recognition, without scanning stored history', () => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path);
  const injector = new DatabaseSync(path); injector.exec('DROP TABLE revisions'); injector.close();
  const before = readFileSync(path);
  expect(() => lifecycle.open(path)).toThrow();
  expect(readFileSync(path)).toEqual(before);
});

test('D03/D09: reopening preserves logical Claims and full Settlement history; malformed JSON fails only when read, without proactive audit', async () => {
  const path = fixture(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(path); const storage = lifecycle.open(path);
  const ticketId = handle('Ticket', 'Research'); const claimantId = handle('Claimant', 'continued:work');
  let claimed;
  try {
    await storage.adapter.commit(creation());
    claimed = await advance(storage.adapter, [{ kind: 'ticket.create', ticket: { id: ticketId, title: 'Research', question: 'What is known?', type: 'research' } },
      { kind: 'claim.acquire', ticketId, claimantId }]);
    await advance(storage.adapter, [{ kind: 'ticket.settle', ticketId, ticketType: 'research', claimantId,
      settlement: { ...commonSettlement, outcome: { kind: 'finding', statement: 'Known', limitations: 'This slice' } } }]);
  } finally { storage.close(); }
  const reopened = lifecycle.open(path);
  try {
    expect(await reopened.adapter.readRevision(id('Alpha'), 2)).toEqual({ kind: 'found', value: claimed.revision });
    expect(await reopened.adapter.readCurrent(id('Alpha'))).toMatchObject({ kind: 'found', value: { currentRevision: 3,
      tickets: [{ status: 'settled', claim: null, settlement: { introducedAtRevision: 3, outcome: { kind: 'finding', limitations: 'This slice' } } }] } });
  } finally { reopened.close(); }
  // Fault injection at the real SQL boundary, not assertions about private business rows.
  const injector = new DatabaseSync(path); injector.prepare('UPDATE revisions SET record=? WHERE map_id=? AND revision=?').run('{broken', 'Alpha', 1); injector.close();
  const noAudit = lifecycle.open(path);
  try {
    expect(await noAudit.adapter.readCurrent(id('Alpha'))).toMatchObject({ kind: 'found', value: { currentRevision: 3 } });
    await expect(noAudit.adapter.readRevision(id('Alpha'), 1)).rejects.toThrow(SyntaxError);
  } finally { noAudit.close(); }
});

test.skipIf(process.platform === 'win32').each(['initialize', 'open'] as const)('D02: %s rejects unsafe writable ancestors even when the immediate private directory is safe or missing', action => {
  const original = fixture(); const unsafe = join(dirname(dirname(original)), 'unsafe');
  mkdirSync(unsafe, { mode: 0o700 }); const path = join(unsafe, 'private', 'maps.sqlite');
  const lifecycle = sqliteLifecycleForTests();
  if (action === 'open') lifecycle.initialize(path);
  chmodSync(unsafe, 0o777);
  const before = existsSync(path) ? readFileSync(path) : null;
  expect(() => lifecycle[action](path)).toThrow();
  expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
  expect(lstatSync(unsafe).mode & 0o777).toBe(0o777);
});
