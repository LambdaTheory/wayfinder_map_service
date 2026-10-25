import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import { afterEach, expect, test } from 'vitest';
import { createMapMcpServer, mapTools, toolsOnlyMapTools, workflowContract } from '../src/mcp-tools.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import type { SQLiteStorage } from '../src/sqlite-storage.js';
import { calculateFrontier, parseId, prepareApply } from '../src/index.js';
import type { Command, NonEmpty, Revision, TicketType } from '../src/index.js';
import { rejectionSeed, rejectionCases } from './helpers/mcp-rejection-cases.js';
import { versioned } from './helpers/write-version.js';

const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function id(value: string) {
  const result = parseId('Map', value);
  if (result.kind !== 'ok') throw new Error('Invalid fixture ID');
  return result.value;
}
const configuration = { actorId: 'operator', clientId: 'codex-test' };
const ajv = new Ajv({ strict: false });
const schemas = new Map(mapTools.map(tool => [tool.name, {
  input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema!),
}]));
async function fixture(faults: Parameters<typeof sqliteLifecycleForTests>[0] = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-mcp-tools-acceptance-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite');
  const lifecycle = sqliteLifecycleForTests(faults);
  lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  cleanups.push(() => storage.close());
  const server = createMapMcpServer(storage, configuration);
  const client = new Client({ name: 'wayfinder-protocol-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let negotiatedProtocol: unknown;
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ('result' in message && 'protocolVersion' in message.result) negotiatedProtocol = message.result.protocolVersion;
    await send(message, options);
  };
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const result = await client.callTool({ name, arguments: versioned(name, args) }) as CallToolResult;
    expect(result.content).toEqual([]);
    expect(result.structuredContent).toBeDefined();
    expect(schemas.get(name)!.output(result.structuredContent), JSON.stringify(schemas.get(name)!.output.errors)).toBe(true);
    const kind = result.structuredContent!.kind;
    expect(result.isError === true).toBe(kind === 'infrastructure_error');
    return result;
  }
  const create = (mapId = 'Acceptance.Alpha', includeSnapshot?: boolean) => call('map_create', { mapId, title: 'Repeated title', destination: 'Verified tools', ...(includeSnapshot === undefined ? {} : { includeSnapshot }) });
  const apply = (commands: unknown[], expectedRevision: number, includeSnapshot = true, mapId = 'Acceptance.Alpha') =>
    call('map_apply', { mapId, expectedRevision, commands, includeSnapshot });
  const read = (revision?: number, mapId = 'Acceptance.Alpha') => call('map_read', { mapId, ...(revision === undefined ? {} : { revision }) });
  return { path, storage, client, server, call, create, apply, read, clientTransport, serverTransport, negotiatedProtocol };
}
function snapshot(result: CallToolResult): Revision { return result.structuredContent!.revision as unknown as Revision; }
const ticket = (identity: string, type: TicketType = 'task') => ({ kind: 'ticket.create', ticket: { id: identity, title: 'Ticket', question: 'Done?', type } });
const settlement = (type: TicketType = 'task') => ({ outcome: type === 'grilling' || type === 'prototype'
  ? { kind: 'decision', statement: 'Chosen', rationale: 'Evidence' } : type === 'research' ? { kind: 'finding', statement: 'Observed', limitations: '' }
    : { kind: 'completion', statement: 'Finished', resultingFacts: { arbitrary: [true, null, { value: 2 }] } },
evidence: [{ statement: 'Inspected', references: [], provenance: { method: 'Inspection', sources: [] }, extensions: {} }],
references: [], provenance: { method: 'Worked', sources: [{ locator: 'session:acceptance', label: '' }] }, extensions: { 'test.result': null } });
async function observe(storage: SQLiteStorage, head: number) {
  return Promise.all(['Acceptance.Alpha', 'Acceptance.Other', 'Missing'].map(async mapId => ({
    current: await storage.adapter.readCurrent(id(mapId)), history: await Promise.all(Array.from({ length: head + 1 }, (_, i) => storage.adapter.readRevision(id(mapId), i + 1))),
  })));
}

test('P01/P02: SDK discovers exactly four complete schemas, once-only compact/default/false and opt-in snapshots', async () => {
  const f = await fixture();
  const listed = await f.client.listTools();
  expect(listed.tools).toEqual(mapTools);
  expect(listed.tools.map(tool => tool.name)).toEqual(['map_create', 'map_list', 'map_read', 'map_apply']);
  expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
  expect(f.negotiatedProtocol).toBe('2025-11-25');
  expect(f.server.getClientVersion()).toEqual({ name: 'wayfinder-protocol-test', version: '0.1.0' });
  const before = Date.now();
  const compact = await f.create();
  expect(compact.structuredContent).toEqual({ kind: 'committed', mapId: 'Acceptance.Alpha', revision: 1,
    changes: [{ commandIndex: 0, command: 'map.create', subjectId: 'Acceptance.Alpha' }] });
  const revision = snapshot(await f.read());
  expect(revision).toMatchObject({ revision: 1, priorRevision: null, kind: 'create', author: configuration,
    state: { tickets: [], fog: [], scopeExclusions: [], notes: '', extensions: {}, currentRevision: 1 } });
  expect(Date.parse(revision.author.occurredAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(revision.author.occurredAt)).toBeLessThanOrEqual(Date.now());
  expect((await f.create('Acceptance.Other', false)).structuredContent).toMatchObject({ revision: 1, mapId: 'Acceptance.Other' });
  const full = await f.create('Acceptance.Snapshot', true);
  expect(Object.keys(full.structuredContent!).sort()).toEqual(['frontier', 'kind', 'revision']);
  expect(snapshot(full).revision).toBe(1);
  expect(full.structuredContent!.frontier).toEqual([]);
  for (const includeSnapshot of [undefined, false, true]) {
    const current = snapshot(await f.read());
    const result = await f.call('map_apply', { mapId: current.mapId, expectedRevision: current.revision,
      commands: [{ kind: 'map.update', patch: { notes: `Step ${current.revision}` } }], ...(includeSnapshot === undefined ? {} : { includeSnapshot }) });
    expect(typeof result.structuredContent!.revision).toBe(includeSnapshot ? 'object' : 'number');
  }
});

test('W02: the map_apply description names every command and field its input schema accepts', () => {
  // Some clients do not pass nested oneOf schemas to the model, so the description must stand alone.
  const tool = mapTools.find(candidate => candidate.name === 'map_apply')!;
  const commands = (tool.inputSchema.properties as { commands: { items: { oneOf: { properties: Record<string, { const?: string }> }[] } } })
    .commands.items.oneOf;
  const description = workflowContract.toolDescriptions.map_apply;
  for (const command of commands) {
    const { kind, ...fields } = command.properties;
    expect(description).toContain(kind!.const!.replace('ticket.settle', '"kind":"ticket.settle"'));
    for (const field of Object.keys(fields)) expect(description).toContain(field);
  }
});

test('U00: writes name the release whose rules they follow; a missing or other version is refused before anything is read or written', async () => {
  const f = await fixture();
  const refused = (version: string | null) => ({ kind: 'rejected', code: 'version_mismatch', version, rules: 'wayfinder://workflow/exploration' });
  const bare = { mapId: 'Acceptance.Alpha', title: 'Gate', destination: 'Gate' };
  for (const [args, echoed] of [[bare, null], [{ ...bare, version: '1.0.1' }, '1.0.1'], [{ ...bare, version: 'x'.repeat(33) }, null],
    [{ ...bare, version: 2 }, null]] as const) {
    const result = await f.client.callTool({ name: 'map_create', arguments: args }) as CallToolResult;
    expect(result.structuredContent).toEqual(refused(echoed));
    expect(schemas.get('map_create')!.output(result.structuredContent)).toBe(true);
  }
  expect((await f.call('map_list')).structuredContent).toMatchObject({ maps: [] });
  await f.create();
  // Fields a caller kept from an older schema do not hide the version answer behind an input rejection.
  expect((await f.client.callTool({ name: 'map_apply', arguments: { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [], retired: true } }))
    .structuredContent).toEqual(refused(null));
  expect((await f.read()).structuredContent).toMatchObject({ revision: { revision: 1 } });
  for (const name of ['map_create', 'map_apply']) {
    const schema = mapTools.find(tool => tool.name === name)!.inputSchema as { required: string[]; properties: Record<string, { description: string }> };
    expect(schema.required).toContain('version');
    expect(schema.properties.version!.description).not.toContain(workflowContract.version);
    // Compatibility mode differs only in the version help, which states the release.
    const compat = toolsOnlyMapTools.find(tool => tool.name === name)!;
    expect((compat.inputSchema.properties!.version as { description: string }).description).toContain(`"${workflowContract.version}"`);
    expect({ ...compat, inputSchema: { ...compat.inputSchema, properties: { ...compat.inputSchema.properties, version: null } } })
      .toEqual({ ...mapTools.find(tool => tool.name === name)!, inputSchema: { ...schema, properties: { ...schema.properties, version: null } } });
  }
  expect(() => createMapMcpServer(f.storage, { ...configuration, toolsOnly: 'yes' } as never)).toThrow('Invalid MCP author configuration');
});

test('W01/W02: initialization, generated tool guidance, Resources and side-effect-free Prompt expose the current release', async () => {
  const f = await fixture();
  expect(f.client.getInstructions()).toBe(workflowContract.instructions);
  expect(f.client.getInstructions()!.startsWith(workflowContract.safetyCore)).toBe(true);
  expect([...workflowContract.safetyCore].length).toBeLessThanOrEqual(512);
  expect(workflowContract.safetyCore).toContain('old request is void until a human sees the new Revision and issues a new request');
  expect(workflowContract.toolDescriptions.map_apply).toContain('The stale instruction cannot authorize a later write');
  expect(f.client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
  expect((await f.client.listTools()).tools).toEqual(mapTools);
  expect(Object.fromEntries(mapTools.map(tool => [tool.name, tool.description]))).toEqual(workflowContract.toolDescriptions);

  const listed = await f.client.listResources();
  expect(listed.resources.map(resource => resource.uri)).toEqual([
    'wayfinder://workflow/exploration', `wayfinder://workflow/exploration/${version}`,
  ]);
  for (const resource of listed.resources) {
    expect(resource).toMatchObject({ mimeType: 'text/markdown', _meta: { 'wayfinder/version': version } });
    expect(await f.client.readResource({ uri: resource.uri })).toEqual({ contents: [{ uri: resource.uri,
      mimeType: 'text/markdown', text: `version: ${version}\n\n${readFileSync('docs/agents/exploration-mcp.md', 'utf8')}`,
      _meta: { 'wayfinder/version': version } }] });
  }

  expect(await f.client.listPrompts()).toEqual({ prompts: [{ name: 'start_wayfinder_exploration',
    description: `Start or resume Wayfinder workflow ${version}`, arguments: [
      { name: 'mode', description: 'create or resume', required: true },
      { name: 'mapId', description: 'Optional stable Map ID', required: false },
    ], _meta: { 'wayfinder/version': version } }] });
  const before = await f.storage.listMaps({});
  for (const arguments_ of [{ mode: 'create' }, { mode: 'resume', mapId: 'Stable.Map' }]) {
    const result = await f.client.getPrompt({ name: 'start_wayfinder_exploration', arguments: arguments_ });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });
    expect((result.messages[0]!.content as { text: string }).text).toContain(`Mode: ${arguments_.mode}`);
    expect((result.messages[0]!.content as { text: string }).text).toContain(`version: ${version}.`);
  }
  expect(await f.storage.listMaps({})).toEqual(before);
  await expect(f.client.getPrompt({ name: 'start_wayfinder_exploration', arguments: { mode: 'invalid' } })).rejects.toThrow();
  await expect(f.client.readResource({ uri: 'wayfinder://workflow/missing' })).rejects.toThrow();
});

test.each(['grilling', 'prototype', 'research', 'task'] as const)('P01/P02/P03: real M1 %s Settlement, Claims, dependencies, content, reopen and pinned history', async type => {
  const f = await fixture();
  await f.create();
  const added = await f.apply([ticket('A', type), ticket('B'), { kind: 'dependency.add', dependentId: 'B', prerequisiteId: 'A' },
    { kind: 'content.add', section: 'fog', item: { id: 'fog', text: 'Unknown', references: [] } },
    { kind: 'content.add', section: 'scopeExclusions', item: { id: 'excluded', text: 'Out', references: [{ locator: 'opaque' }] } }], 1);
  expect(added.structuredContent!.frontier).toEqual(['A']);
  const claimed = await f.apply([{ kind: 'claim.acquire', ticketId: 'A', claimantId: 'work:A' }], 2);
  expect(claimed.structuredContent!.frontier).toEqual([]);
  const settled = await f.apply([{ kind: 'ticket.settle', ticketId: 'A', ticketType: type, claimantId: 'work:A', settlement: settlement(type) }], 3);
  expect(settled.structuredContent!.frontier).toEqual(['B']);
  expect(snapshot(settled).state.tickets[0]).toMatchObject({ claim: null, status: 'settled', settlement: { ...settlement(type), introducedAtRevision: 4 } });
  const read4 = await f.read(4);
  expect(read4.structuredContent).toEqual({ ...settled.structuredContent, kind: 'found' });
  const reopened = await f.apply([{ kind: 'ticket.reopen', ticketId: 'A', reason: ' Reconsider\n' }], 4);
  expect(reopened.structuredContent!.frontier).toEqual(['A']);
  expect(snapshot(reopened).changes[0]).toEqual({ commandIndex: 0, command: 'ticket.reopen', subjectId: 'A', reason: ' Reconsider\n' });
  expect(snapshot(await f.read(3))).toEqual(snapshot(claimed));
  expect(await f.read(4)).toEqual(read4);
  expect(snapshot(await f.read()).revision).toBe(5);
  expect((await f.read(6)).structuredContent).toEqual({ kind: 'not_found', code: 'revision_not_found', mapId: 'Acceptance.Alpha', revision: 6 });
  expect((await f.read(Number.MAX_SAFE_INTEGER)).structuredContent).toMatchObject({ kind: 'not_found', code: 'revision_not_found', revision: Number.MAX_SAFE_INTEGER });
  expect((await f.read(undefined, 'Missing')).structuredContent).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Missing' });
  expect((await f.read(1, 'Missing')).structuredContent).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Missing' });
});

test('P04: ASCII keyset/default/boundary pages, nonexistent cursor, duplicate titles, coherent fields and empty catalog', async () => {
  const f = await fixture();
  expect((await f.call('map_list')).structuredContent).toEqual({ kind: 'listed', maps: [], nextAfterMapId: null });
  const ids = ['z', 'a', 'Z', 'A', '0', ...Array.from({ length: 21 }, (_, i) => `M${String(i).padStart(2, '0')}`)];
  for (const mapId of ids) await f.create(mapId);
  const ordered = [...ids].sort();
  const first = (await f.call('map_list')).structuredContent!;
  expect((first.maps as { mapId: string }[]).map(map => map.mapId)).toEqual(ordered.slice(0, 20));
  expect(first.nextAfterMapId).toBe(ordered[19]);
  const tail = (await f.call('map_list', { afterMapId: first.nextAfterMapId })).structuredContent!;
  expect((tail.maps as { mapId: string }[]).map(map => map.mapId)).toEqual(ordered.slice(20));
  expect(tail.nextAfterMapId).toBeNull();
  const one = (await f.call('map_list', { limit: 1 })).structuredContent!;
  expect(one.maps).toEqual([{ mapId: '0', title: 'Repeated title', destination: 'Verified tools', currentRevision: 1 }]);
  expect(one.nextAfterMapId).toBe('0');
  expect(((await f.call('map_list', { limit: 100 })).structuredContent!.maps as unknown[]).length).toBe(ids.length);
  expect((await f.call('map_list', { afterMapId: 'M09a', limit: 1 })).structuredContent).toMatchObject({ maps: [{ mapId: 'M10' }], nextAfterMapId: 'M10' });
  await f.apply([{ kind: 'map.update', patch: { title: 'Updated', destination: 'Current' } }], 1, false, 'A');
  expect((await f.call('map_list', { afterMapId: '0', limit: 1 })).structuredContent).toMatchObject({ maps: [{ mapId: 'A', title: 'Updated', destination: 'Current', currentRevision: 2 }] });
  expect((await f.call('map_list', { afterMapId: 'zz' })).structuredContent).toEqual({ kind: 'listed', maps: [], nextAfterMapId: null });
});

test('P01/P02: remaining real M1 commands execute in order in one Revision, exact reason and content/Claim semantics', async () => {
  const f = await fixture(); await f.create();
  const commands = [ticket('A'), ticket('B'), { kind: 'ticket.update', ticketId: 'A', patch: { title: 'Changed' } },
    { kind: 'dependency.add', dependentId: 'B', prerequisiteId: 'A' }, { kind: 'dependency.remove', dependentId: 'B', prerequisiteId: 'A' },
    { kind: 'claim.acquire', ticketId: 'A', claimantId: 'work' }, { kind: 'claim.release', ticketId: 'A', claimantId: 'work' },
    { kind: 'claim.acquire', ticketId: 'A', claimantId: 'work' }, { kind: 'claim.clear', ticketId: 'A', expectedClaimantId: 'work', reason: ' Deliberate clear\n' },
    { kind: 'content.add', section: 'fog', item: { id: 'F', text: 'First', references: [] } },
    { kind: 'content.update', section: 'fog', item: { id: 'F', text: 'Updated', references: [{ locator: 'opaque', label: '' }] } },
    { kind: 'content.add', section: 'scopeExclusions', item: { id: 'S', text: 'Excluded', references: [] } },
    { kind: 'content.remove', section: 'scopeExclusions', itemId: 'S' },
    { kind: 'map.update', patch: { title: ' New title\n', destination: ' New destination ', notes: '', extensions: { 'test.json': [1, null] } } }];
  const original = structuredClone(commands);
  const written = await f.apply(commands, 1);
  const revision = snapshot(written);
  expect(commands).toEqual(original);
  expect(revision.revision).toBe(2); expect(revision.priorRevision).toBe(1);
  expect(revision.changes).toHaveLength(commands.length);
  expect(revision.changes.map(change => change.commandIndex)).toEqual(commands.map((_, index) => index));
  expect(revision.changes[8]).toEqual({ commandIndex: 8, command: 'claim.clear', subjectId: 'A', reason: ' Deliberate clear\n' });
  expect(revision.state).toMatchObject({ title: ' New title\n', destination: ' New destination ', notes: '', extensions: { 'test.json': [1, null] },
    fog: [{ id: 'F', text: 'Updated', references: [{ locator: 'opaque', label: '' }] }], scopeExclusions: [],
    tickets: [{ id: 'A', title: 'Changed', status: 'open', claim: null, prerequisites: [] }, { id: 'B', prerequisites: [], claim: null }] });
  expect(written.structuredContent!.frontier).toEqual(['A', 'B']);
  expect((await f.read(3)).structuredContent).toMatchObject({ code: 'revision_not_found' });
  // Detached protocol output cannot alter accepted history.
  (written.structuredContent!.revision as unknown as { state: { title: string } }).state.title = 'Client mutation';
  expect(snapshot(await f.read(2)).state.title).toBe(' New title\n');
});

test('P01/P05/D05: public shape/ID/Revision/unknown/system paths agree with schemas, no storage effects', async () => {
  const f = await fixture();
  await f.create(); await f.create('Acceptance.Other');
  const cases: [string, Record<string, unknown>, (string | number)[]][] = [
    ...['', ' bad', 'A\n', '♥', 'A'.repeat(129)].map(value => ['map_create', { mapId: value, title: 'Title', destination: 'Dest' }, ['mapId']] as [string, Record<string, unknown>, string[]]),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(revision => ['map_read', { mapId: 'Acceptance.Alpha', revision }, ['revision']] as [string, Record<string, unknown>, string[]]),
    ...[0, 101, 1.2, '20', null].map(limit => ['map_list', { limit }, ['limit']] as [string, Record<string, unknown>, string[]]),
    ['map_list', { afterMapId: 'bad cursor' }, ['afterMapId']],
    ['map_create', { mapId: 'X', title: ' ', destination: 'Dest' }, ['title']],
    ['map_create', { mapId: 'X', title: 'Title', destination: '\n' }, ['destination']],
    ['map_create', { mapId: 'X', title: 'Title', destination: 'Dest', notes: null }, ['notes']],
    ['map_create', { mapId: 'X', title: 'Title', destination: 'Dest', extensions: { unnamespaced: 1 } }, ['extensions', 'unnamespaced']],
    ['map_create', { mapId: 'X', title: 'Title', destination: 'Dest', includeSnapshot: 1 }, ['includeSnapshot']],
    ['map_read', {}, ['mapId']],
    ['map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [] }, ['commands']],
    ['map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [{ kind: 'map.update', patch: {} }] }, ['commands', 0, 'patch']],
    ['map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [{ kind: 'ticket.create', ticket: { id: 'T', title: 'T', question: 'Q', type: 'task', status: 'open' } }] }, ['commands', 0, 'ticket', 'status']],
    ['map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [{ kind: 'ticket.settle', ticketId: 'T', ticketType: 'task', claimantId: 'work', settlement: { ...settlement(), introducedAtRevision: 2 } }] }, ['commands', 0, 'settlement', 'introducedAtRevision']],
    ['map_apply', { mapId: 'Missing', expectedRevision: 2, commands: [ticket('T'), { kind: 'bogus' }] }, ['commands', 1, 'kind']],
  ];
  for (const name of ['map_create', 'map_apply', 'map_read', 'map_list']) {
    const base = name === 'map_create' ? { mapId: 'X', title: 'T', destination: 'D' } : name === 'map_apply'
      ? { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [ticket('T')] } : name === 'map_read' ? { mapId: 'Acceptance.Alpha' } : {};
    for (const field of ['author', 'currentRevision', 'introducedAtRevision', 'sql', 'path', 'preparedCommit', 'owner']) cases.push([name, { ...base, [field]: 'forged' }, [field]]);
  }
  const before = await observe(f.storage, 1);
  for (const [name, args, path] of cases) {
    expect(schemas.get(name)!.input(args), JSON.stringify(args)).toBe(false);
    expect((await f.call(name, args)).structuredContent).toMatchObject({ kind: 'rejected', rejection: { stage: 'input', error: { code: 'invalid_input', path } } });
    expect(await observe(f.storage, 1)).toEqual(before);
  }
});

test('P01: every M1 command schema validates nested shape and the real whole-shape decoder rejects malformed later input before semantics', async () => {
  const f = await fixture(); await f.create(); await f.create('Acceptance.Other');
  const before = await observe(f.storage, 1);
  const valid = [ticket('A'), { kind: 'ticket.update', ticketId: 'A', patch: { title: 'Updated', type: 'task', extensions: {} } },
    { kind: 'dependency.add', dependentId: 'A', prerequisiteId: 'B', claimantId: 'work' }, { kind: 'dependency.remove', dependentId: 'A', prerequisiteId: 'B' },
    { kind: 'claim.acquire', ticketId: 'A', claimantId: 'work' }, { kind: 'claim.release', ticketId: 'A', claimantId: 'work' },
    { kind: 'claim.clear', ticketId: 'A', expectedClaimantId: 'work', reason: 'Clear' }, { kind: 'ticket.reopen', ticketId: 'A', reason: 'Reopen' },
    { kind: 'content.add', section: 'fog', item: { id: 'F', text: 'Fog', references: [] } },
    { kind: 'content.update', section: 'scopeExclusions', item: { id: 'F', text: 'Scope', references: [{ locator: 'ref', label: '' }] } },
    { kind: 'content.remove', section: 'fog', itemId: 'F' }, { kind: 'map.update', patch: { notes: '', extensions: { 'test.json': [null, 2, { nested: true }] } } },
    ...(['grilling', 'prototype', 'research', 'task'] as const).map(type => ({ kind: 'ticket.settle', ticketId: 'A', ticketType: type, claimantId: 'work', settlement: settlement(type) }))];
  for (const command of valid) {
    expect(schemas.get('map_apply')!.input(versioned('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [command] }))).toBe(true);
    const malformed = { ...command, system: 'forged' };
    expect(schemas.get('map_apply')!.input(versioned('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [malformed] }))).toBe(false);
    expect((await f.apply([{ kind: 'claim.acquire', ticketId: 'Missing', claimantId: 'work' }, malformed], 1)).structuredContent).toMatchObject({
      rejection: { stage: 'input', error: { path: ['commands', 1, 'system'] } },
    });
    expect(await observe(f.storage, 1)).toEqual(before);
  }
  const badSettlements = [
    { ...settlement('task'), outcome: { kind: 'finding', statement: 'Mismatch' } },
    { ...settlement('task'), evidence: [{ statement: 'No attribution', references: [], extensions: {} }] },
    { ...settlement('research'), evidence: [], references: [] },
    { ...settlement('task'), provenance: { method: ' ', sources: [] } },
    { ...settlement('task'), references: [{ locator: ' ' }] },
    { ...settlement('task'), extensions: { 'test.key\n': 1 } },
  ];
  for (const [index, value] of badSettlements.entries()) {
    const command = { kind: 'ticket.settle', ticketId: 'A', ticketType: index === 2 ? 'research' : 'task', claimantId: 'work', settlement: value };
    expect(schemas.get('map_apply')!.input(versioned('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 1, commands: [command] }))).toBe(false);
    expect((await f.apply([command], 1)).structuredContent).toMatchObject({ rejection: { stage: 'input', error: { code: 'invalid_input' } } });
    expect(await observe(f.storage, 1)).toEqual(before);
  }
});

test('D05/P05: complete command-error and reachable final-invariant matrix through real M1/SQLite tools publishes nothing', async () => {
  const f = await fixture(); await f.create(); await f.create('Acceptance.Other');
  expect((await f.apply(rejectionSeed, 1)).structuredContent!.kind).toBe('committed');
  const before = await observe(f.storage, 2);
  for (const scenario of rejectionCases) {
    expect((await f.apply(scenario.commands, 2)).structuredContent, scenario.label).toEqual({ kind: 'rejected', rejection: scenario.rejection });
    expect(await observe(f.storage, 2), scenario.label).toEqual(before);
  }
});

test('P05/D05: ordinary structured lifecycle/Claim/dependency/invariant/no-op/conflict outcomes preserve full history, unrelated Map and proposed-next absence', async () => {
  const f = await fixture(); await f.create(); await f.create('Acceptance.Other');
  await f.apply([ticket('A'), ticket('B'), { kind: 'dependency.add', dependentId: 'B', prerequisiteId: 'A' }, { kind: 'claim.acquire', ticketId: 'A', claimantId: 'work' }], 1);
  const cases: [unknown[], Record<string, unknown>][] = [
    [[ticket('A')], { stage: 'command', commandIndex: 0, code: 'ticket_already_exists', ticketIds: ['A'] }],
    [[{ kind: 'ticket.update', ticketId: 'A', patch: { title: 'New' } }], { stage: 'command', code: 'claim_required', commandIndex: 0, ticketIds: ['A'] }],
    [[{ kind: 'claim.release', ticketId: 'A', claimantId: 'other' }], { stage: 'command', code: 'claim_mismatch', commandIndex: 0, ticketIds: ['A'] }],
    [[{ kind: 'claim.acquire', ticketId: 'B', claimantId: 'work' }], { stage: 'command', code: 'unsettled_dependency', commandIndex: 0, ticketIds: ['B'] }],
    [[{ kind: 'ticket.reopen', ticketId: 'A', reason: 'Not settled' }], { stage: 'command', code: 'ticket_not_settled', commandIndex: 0, ticketIds: ['A'] }],
    [[{ kind: 'dependency.add', dependentId: 'A', prerequisiteId: 'Missing', claimantId: 'work' }], { stage: 'command', code: 'ticket_not_found', commandIndex: 0, ticketIds: ['Missing'] }],
    [[{ kind: 'claim.release', ticketId: 'A', claimantId: 'work' }, { kind: 'dependency.add', dependentId: 'A', prerequisiteId: 'B' }], { stage: 'final_state', code: 'dependency_cycle', ticketIds: ['A', 'B'] }],
    [[{ kind: 'map.update', patch: { notes: '' } }], { stage: 'final_state', code: 'no_changes' }],
    [[{ kind: 'map.update', patch: { notes: 'Must not persist' } }, { kind: 'claim.acquire', ticketId: 'Missing', claimantId: 'work' }], { stage: 'command', commandIndex: 1, code: 'ticket_not_found', ticketIds: ['Missing'] }],
  ];
  const before = await observe(f.storage, 2);
  for (const [commands, rejection] of cases) {
    expect((await f.apply(commands, 2)).structuredContent).toEqual({ kind: 'rejected', rejection });
    expect(await observe(f.storage, 2)).toEqual(before);
  }
  expect((await f.create()).structuredContent).toEqual({ kind: 'rejected', code: 'map_already_exists', mapId: 'Acceptance.Alpha' });
  expect((await f.apply([ticket('C')], 1)).structuredContent).toEqual({ kind: 'conflict', conflict: { mapId: 'Acceptance.Alpha', expectedRevision: 1, currentRevision: 2 } });
  expect((await f.apply([ticket('C')], 1, false, 'Missing')).structuredContent).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Missing' });
  expect(await observe(f.storage, 2)).toEqual(before);
});

test('P02/P03/D09: current reads pin observed N and writes return exact committed N even when another operation advances head before response', async () => {
  const f = await fixture(); await f.create();
  const adapter = f.storage.adapter;
  const originalCommit = adapter.commit.bind(adapter);
  const originalCurrent = adapter.readCurrent.bind(adapter);
  async function advance() {
    const state = await originalCurrent(id('Acceptance.Alpha'));
    if (state.kind !== 'found') throw new Error('Fixture missing');
    const prepared = prepareApply(state.value, { mapId: id('Acceptance.Alpha'), expectedRevision: state.value.currentRevision,
      author: { ...configuration, occurredAt: '2026-09-18T00:00:00Z' } as Revision['author'], commands: [ticket(`T${state.value.currentRevision}`)] as unknown as NonEmpty<Command> });
    if (prepared.kind !== 'prepared') throw new Error('Fixture preparation');
    await originalCommit(prepared.change);
  }
  adapter.commit = async prepared => { const committed = await originalCommit(prepared); await advance(); return committed; };
  const written = await f.apply([ticket('A')], 1);
  expect(snapshot(written).revision).toBe(2);
  expect(written.structuredContent!.frontier).toEqual(['A']);
  expect((await originalCurrent(id('Acceptance.Alpha')))).toMatchObject({ value: { currentRevision: 3 } });
  adapter.commit = originalCommit;
  adapter.readCurrent = async mapId => { const observed = await originalCurrent(mapId); await advance(); return observed; };
  const read = await f.read();
  expect(snapshot(read).revision).toBe(3);
  expect(read.structuredContent!.frontier).toEqual(calculateFrontier(snapshot(read).state));
  expect(read.structuredContent!.frontier).toEqual(['A', 'T2']);
  adapter.readCurrent = originalCurrent;
  expect(snapshot(await f.read()).revision).toBe(4);
  expect(snapshot(await f.read(2))).toEqual(snapshot(written));
  adapter.commit = async prepared => { const committed = await originalCommit(prepared); await advance(); return committed; };
  const compact = await f.apply([{ kind: 'map.update', patch: { notes: 'Exact' } }], 4, false);
  expect(compact.structuredContent).toMatchObject({ revision: 5 });
  expect((await originalCurrent(id('Acceptance.Alpha')))).toMatchObject({ value: { currentRevision: 6 } });
});

test('P05: unknown tool and malformed tools/call are protocol errors, never fabricated domain errors', async () => {
  const f = await fixture();
  await expect(f.client.callTool({ name: 'unknown', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  expect((await f.call('map_list')).structuredContent).toMatchObject({ maps: [] });
  const responses: unknown[] = [];
  f.clientTransport.onmessage = message => { responses.push(message); };
  await f.clientTransport.send({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 42 } });
  await f.clientTransport.send({ jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'map_read', arguments: 'bad' } });
  await f.clientTransport.send({ jsonrpc: '2.0', id: 902, method: 'tools/call', params: { name: 'map_create', task: {},
    arguments: { mapId: 'TaskUnsupported', title: 'T', destination: 'D' } } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(responses).toHaveLength(3);
  // The pinned SDK's request-schema parse reports InternalError; it is still
  // a JSON-RPC error, not a successful tools/call or a business rejection.
  for (const response of responses) expect(response).toMatchObject({ error: { code: ErrorCode.InternalError } });
  expect(f.storage.listMaps()).toMatchObject({ maps: [] });
});

test('P05/D05: authoritative second head comparison rejects losing prepared writer and publishes once', async () => {
  const f = await fixture(); await f.create(); await f.create('Acceptance.Other');
  const before = await observe(f.storage, 1);
  const results = await Promise.all([f.apply([ticket('A')], 1), f.apply([ticket('B')], 1)]);
  expect(results.filter(result => result.structuredContent!.kind === 'committed')).toHaveLength(1);
  const conflict = results.find(result => result.structuredContent!.kind === 'conflict');
  expect(conflict?.isError).toBeUndefined();
  expect(conflict?.structuredContent).toEqual({ kind: 'conflict', conflict: { mapId: 'Acceptance.Alpha', expectedRevision: 1, currentRevision: 2 } });
  const after = await observe(f.storage, 2);
  expect(after[0]!.history[0]).toEqual(before[0]!.history[0]);
  expect(after[0]!.history[2]).toMatchObject({ kind: 'not_found', code: 'revision_not_found' });
  expect(after[1]!.current).toEqual(before[1]!.current);
  expect(after[1]!.history.slice(0, 2)).toEqual(before[1]!.history);
});

test('P01: 100-command boundary succeeds once, excess refused without added pure M1 limit', async () => {
  const f = await fixture(); await f.create();
  const commands = Array.from({ length: 100 }, (_, i) => ticket(`T${i}`));
  expect(snapshot(await f.apply(commands, 1)).revision).toBe(2);
  const before = await observe(f.storage, 2);
  expect((await f.apply([...commands, ticket('Extra')], 2)).structuredContent).toMatchObject({ rejection: { stage: 'input', error: { path: ['commands'] } } });
  expect(await observe(f.storage, 2)).toEqual(before);
  const state = snapshot(await f.read()).state;
  const large = Array.from({ length: 101 }, (_, i) => ticket(`Pure${i}`)) as unknown as NonEmpty<Command>;
  expect(prepareApply(state, { mapId: state.id, expectedRevision: 2, commands: large, author: snapshot(await f.read()).author }).kind).toBe('prepared');
});

test('P05: actual busy/prepublication/unknown/closed storage errors are safe and distinct, no automatic replay/fallback', async () => {
  let inject = false;
  const f = await fixture({ beforePublication: () => { if (inject) throw new Error('secret SQL private path body'); } });
  await f.create(); await f.create('Acceptance.Other');
  const before = await observe(f.storage, 1);
  const lock = new DatabaseSync(f.path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    expect((await f.apply([ticket('A')], 1)).structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_busy', outcome: 'not_published', requiresRestart: false });
    lock.exec('ROLLBACK');
  } finally { lock.close(); }
  expect(await observe(f.storage, 1)).toEqual(before);
  inject = true;
  expect((await f.apply([ticket('A')], 1)).structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_failure', outcome: 'not_published', requiresRestart: false });
  expect(await observe(f.storage, 1)).toEqual(before);
  inject = false;
  expect(snapshot(await f.apply([ticket('A')], 1)).revision).toBe(2);
  f.storage.close();
  const failure = await f.call('map_read', { mapId: 'Acceptance.Alpha' });
  expect(failure.structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_failure', outcome: 'unknown', requiresRestart: true });
  expect(JSON.stringify(failure)).not.toContain(f.path);
});

test('P05: post-publication error reports unknown; authoritative reread resolves stored result without replay', async () => {
  let once = true;
  const f = await fixture({ afterPublication: () => { if (once) { once = false; throw new Error('secret path credential SQL'); } } });
  const result = await f.create();
  expect(result.structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_failure', outcome: 'unknown', requiresRestart: true });
  expect((await f.read()).structuredContent).toMatchObject({ kind: 'infrastructure_error', requiresRestart: true });
  const restarted = sqliteLifecycleForTests().open(f.path);
  try {
    expect(await restarted.adapter.readRevision(id('Acceptance.Alpha'), 1)).toMatchObject({ kind: 'found', value: { revision: 1 } });
    expect(await restarted.adapter.readRevision(id('Acceptance.Alpha'), 2)).toMatchObject({ code: 'revision_not_found' });
  } finally { restarted.close(); }
});

test('P01: author configuration rejected before serving, captured against later mutation and no forged request fields', async () => {
  const f = await fixture();
  for (const config of [{ actorId: '', clientId: 'ok' }, { actorId: 'ok', clientId: ' bad' }, { actorId: 'ok', clientId: 'ok', occurredAt: 'forged' }]) {
    expect(() => createMapMcpServer(f.storage, config)).toThrow('Invalid MCP author configuration');
  }
  const config = { ...configuration };
  const server = createMapMcpServer(f.storage, config);
  config.actorId = 'changed';
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'author-test', version: '0.1.0' });
  await server.connect(st); await client.connect(ct);
  try {
    await client.callTool({ name: 'map_create', arguments: versioned('map_create', { mapId: 'Captured', title: 'T', destination: 'D' }) });
    const read = await client.request({ method: 'tools/call', params: { name: 'map_read', arguments: { mapId: 'Captured' } } }, CallToolResultSchema);
    expect(snapshot(read).author).toMatchObject(configuration);
  } finally { await client.close(); await server.close(); }
});

test('V10: a configured local viewer origin adds viewerUrl to map_create and map_read only; other origins are refused', async () => {
  const f = await fixture();
  for (const viewerOrigin of ['http://localhost:8768', 'https://127.0.0.1:8768', 'http://127.0.0.1:8768/', 'http://127.0.0.1', 'http://127.0.0.1:0', 7]) {
    expect(() => createMapMcpServer(f.storage, { ...configuration, viewerOrigin } as never)).toThrow('Invalid MCP author configuration');
  }
  const server = createMapMcpServer(f.storage, { ...configuration, viewerOrigin: 'http://127.0.0.1:8768' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'viewer-link-test', version: '0.1.0' });
  await server.connect(st); await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: versioned(name, args) }) as CallToolResult;
    expect(schemas.get(name)!.output(result.structuredContent), JSON.stringify(schemas.get(name)!.output.errors)).toBe(true);
    return result.structuredContent!;
  };
  try {
    const link = 'http://127.0.0.1:8768/maps/Acceptance.Alpha';
    expect(await call('map_create', { mapId: 'Acceptance.Alpha', title: 'T', destination: 'D' })).toEqual({ kind: 'committed', mapId: 'Acceptance.Alpha',
      revision: 1, changes: [{ commandIndex: 0, command: 'map.create', subjectId: 'Acceptance.Alpha' }], viewerUrl: link });
    expect(await call('map_create', { mapId: 'Acceptance.Other', title: 'T', destination: 'D', includeSnapshot: true }))
      .toMatchObject({ kind: 'committed', viewerUrl: 'http://127.0.0.1:8768/maps/Acceptance.Other' });
    expect(await call('map_read', { mapId: 'Acceptance.Alpha' })).toMatchObject({ kind: 'found', viewerUrl: link });
    for (const includeSnapshot of [false, true]) {
      const current = await call('map_read', { mapId: 'Acceptance.Alpha' }) as { revision: Revision };
      expect(await call('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: current.revision.revision, includeSnapshot,
        commands: [{ kind: 'map.update', patch: { notes: `Step ${includeSnapshot}` } }] })).not.toHaveProperty('viewerUrl');
    }
    expect(await call('map_read', { mapId: 'Missing' })).not.toHaveProperty('viewerUrl');
    const compact = { kind: 'committed', mapId: 'Acceptance.Alpha', revision: 2, changes: [{ commandIndex: 0, command: 'map.update', subjectId: 'Acceptance.Alpha' }] };
    expect(schemas.get('map_create')!.output({ ...compact, viewerUrl: link })).toBe(true);
    expect(schemas.get('map_apply')!.output({ ...compact, viewerUrl: link })).toBe(false);
  } finally { await client.close(); await server.close(); }
});
