import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Ajv, type AnySchema } from 'ajv';
import { parseId, prepareApply, prepareCreate } from '../src/index.js';
import type { Command, NonEmpty } from '../src/types.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import { DeskDelivery, TASKS_EXTENSION } from '../src/desk-delivery.js';
import { CallAdmission } from '../src/call-admission.js';
import { createMapMcpServer, answerDeskMapTools, workflowContract } from '../src/mcp-tools.js';
import { serveLocalMcp } from '../src/mcp-http-internal.js';
import { createHttpTestClient } from './helpers/mcp-http-client.mjs';
import { chatgptDiscovery } from './helpers/chatgpt-discovery.js';
import { completedTaskContent as result } from './helpers/mcp-task-result.mjs';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.useRealTimers(); });
function id<K extends string>(kind: K, value: string) { const r = parseId(kind, value); if (r.kind !== 'ok') throw Error('fixture ID'); return r.value; }
const mapId = id('Map', 'Wait'); const claimantId = id('Claimant', 'worker'); const ticketId = id('Ticket', 'A');
const version = workflowContract.version;
const args = { mapId, claimantId, maxWaitSeconds: 600 };
const token = 'isolated-map-wait-test-credential-00000';
const author = { actorId: id('Actor', 'actor'), clientId: id('Client', 'client'), occurredAt: '2026-10-27T00:00:00.000Z' };
const question = { questionId: 'Q.A', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }], recommendedOption: 1 as const,
  recommendedAnswer: 'A', whyKun: 'Choose', triage: 'needsKun' as const, triageReason: 'Tradeoff', gatesResearch: false };
const post: Command = { kind: 'deskQuestion.post', ticketId, claimantId, question };
const settle: Command = { kind: 'ticket.settle', ticketId, ticketType: 'grilling', claimantId,
  settlement: { outcome: { kind: 'decision', statement: 'A', rationale: 'Agreed' }, evidence: [], references: [], provenance: { method: 'conversation', sources: [] }, extensions: {} } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(publish = true, faults: Parameters<typeof sqliteLifecycleForTests>[0] = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-wait-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite'); const lifecycle = sqliteLifecycleForTests(faults);
  lifecycle.initialize(path); const storage = lifecycle.open(path); cleanups.push(() => storage.close());
  const created = prepareCreate({ id: mapId, title: 'Wait', destination: 'Deliver once', author });
  if (created.kind !== 'ok') throw Error('fixture'); await storage.adapter.commit(created.value);
  async function apply(commands: NonEmpty<Command>) {
    const current = await storage.adapter.readCurrent(mapId); if (current.kind !== 'found') throw Error('fixture');
    const p = prepareApply(current.value, { mapId, expectedRevision: current.value.currentRevision, author, commands }, storage.desk.read(mapId));
    if (p.kind !== 'prepared') throw Error(JSON.stringify(p));
    const result = await storage.adapter.commit(p.change); expect(result.kind).toBe('committed'); return result;
  }
  await apply([{ kind: 'ticket.create', ticket: { id: ticketId, title: 'A', question: 'Which?', type: 'grilling' } }, { kind: 'claim.acquire', ticketId, claimantId }, ...(publish ? [post] : [])]);
  const admission = new CallAdmission();
  const delivery = new DeskDelivery(storage, (call, signal) => admission.release(call, signal));
  cleanups.push(() => delivery.stop());
  function answer(option: 1 | 2 = 1) {
    const result = storage.desk.submitAnswers(mapId, [{ questionId: 'Q.A', questionVersion: 1, choice: { option } }]);
    if (result.kind !== 'updated') throw Error('fixture answer'); return result.value[0]!;
  }
  const start = (task = true, overrides = {}) => {
    const wait = delivery.start({ ...args, ...overrides }, task, 'owner'); if ('content' in wait) throw Error(JSON.stringify(wait)); return wait;
  };
  const inspect = () => { const r = storage.desk.inspect(mapId); if (r.kind !== 'found') throw Error('fixture inspect'); return r; };
  const quiet = () => vi.setSystemTime(Date.parse(storage.desk.read(mapId).quietUntil!));
  return { storage, path, lifecycle, apply, admission, delivery, answer, start, inspect, quiet };
}
function clock() { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z')); }

test('task creation and quiet expiry take nothing; first collection takes latest answers once and preserves Revision/history', async () => {
  clock(); const f = await fixture(); const old = f.answer(); const wait = f.start();
  expect(f.delivery.handle(wait)).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 1_200_000 });
  const head = f.inspect().revision;
  vi.setSystemTime(Date.now() + 14_000); const latest = f.answer(2);
  vi.setSystemTime(Date.now() + 14_999);
  expect(await f.delivery.get(wait.taskId!, 'owner')).toMatchObject({ status: 'working' });
  vi.setSystemTime(Date.now() + 1); expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  const completed = await f.delivery.get(wait.taskId!, 'owner');
  expect(result(completed)).toEqual({ outcome: 'delivered', items: [latest], currentRevision: head.revision });
  expect(result(completed).items).not.toContainEqual(old);
  expect(await f.delivery.get(wait.taskId!, 'owner')).toEqual(completed);
  expect(f.inspect().revision).toEqual(head);
  expect(await f.storage.adapter.readRevision(mapId, head.revision)).toEqual({ kind: 'found', value: head });
  const another = f.start(true, { maxWaitSeconds: 1 }); vi.setSystemTime(Date.now() + 1000);
  expect(result(await f.delivery.get(another.taskId!, 'owner'))).toMatchObject({ outcome: 'none_yet', items: [] });
});

test('taking reads and competing tasks use one boundary; tasks recheck after waiting for a slot', async () => {
  clock(); const f = await fixture(); const a = f.answer(); f.quiet(); const wait = f.start();
  const holds = Array.from({ length: 4 }, () => deferred());
  const calls = holds.map(hold => f.admission.admit(async () => { await hold.promise; return { content: [] }; }));
  const first = f.delivery.get(wait.taskId!, 'owner'); const second = f.delivery.get(wait.taskId!, 'owner');
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  expect(f.delivery.take(mapId, claimantId)).toMatchObject({ value: { items: [a] } });
  holds[0]!.resolve();
  expect(result(await first)).toMatchObject({ outcome: 'none_yet', items: [] }); expect(await second).toEqual(await first);
  holds.forEach(h => h.resolve()); await Promise.all(calls);
});

test('queued task rechecks replacement and Quiet Window instead of taking an earlier prepared answer', async () => {
  clock(); const f = await fixture(); f.answer(); f.quiet(); const wait = f.start();
  const holds = Array.from({ length: 4 }, () => deferred());
  const calls = holds.map(h => f.admission.admit(async () => { await h.promise; return { content: [] }; }));
  const getting = f.delivery.get(wait.taskId!, 'owner'); f.answer(2); const quietUntil = f.storage.desk.read(mapId).quietUntil;
  holds[0]!.resolve(); expect(result(await getting)).toMatchObject({ outcome: 'none_yet', items: [], quietUntil });
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered'); holds.forEach(h => h.resolve()); await Promise.all(calls);
});

test('task cancellation before queued release takes nothing; cancellation after release preserves Taken', async () => {
  clock(); const f = await fixture(); f.answer(); f.quiet(); const wait = f.start();
  const holds = Array.from({ length: 4 }, () => deferred());
  const calls = holds.map(h => f.admission.admit(async () => { await h.promise; return { content: [] }; }));
  const getting = f.delivery.get(wait.taskId!, 'owner'); f.delivery.cancel(wait.taskId!, 'owner');
  expect(await getting).toMatchObject({ status: 'cancelled' }); expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  holds.forEach(h => h.resolve()); await Promise.all(calls);
  const next = f.start(); await f.delivery.get(next.taskId!, 'owner'); f.delivery.cancel(next.taskId!, 'owner');
  expect(await f.delivery.get(next.taskId!, 'owner')).toMatchObject({ status: 'completed' }); expect(f.inspect().desk.deskQuestions[0]!.state).toBe('taken');
});

test('same-scope waits supersede across task/blocking paths; other claimants cannot take the answer', async () => {
  clock(); const f = await fixture(); f.answer(); const first = f.start(); const second = f.start(false);
  expect(result(await f.delivery.get(first.taskId!, 'owner'))).toMatchObject({ outcome: 'superseded', items: [] });
  const blocked = f.delivery.block(second, new AbortController().signal, async () => {}); const third = f.start();
  expect((await blocked).structuredContent).toMatchObject({ outcome: 'superseded', items: [] });
  const stranger = f.start(true, { claimantId: id('Claimant', 'other'), maxWaitSeconds: 15 }); f.quiet();
  expect(result(await f.delivery.get(stranger.taskId!, 'owner'))).toMatchObject({ outcome: 'none_yet', items: [] });
  expect(result(await f.delivery.get(third.taskId!, 'owner'))).toMatchObject({ outcome: 'delivered' });
});

test('suspended blocking wait leaves all four slots available, queues release and emits progress', async () => {
  clock(); const f = await fixture(); const progress = vi.fn(async () => {}); let wait!: ReturnType<typeof f.start>;
  const blocked = f.admission.admit(async suspend => { wait = f.start(false); suspend(); return f.delivery.block(wait, new AbortController().signal, progress); });
  const holds = Array.from({ length: 4 }, () => deferred());
  const calls = holds.map(h => f.admission.admit(async () => { await h.promise; return { content: [] }; }));
  expect(await f.admission.admit(async () => ({ content: [] }))).toMatchObject({ structuredContent: { code: 'service_busy' } });
  const a = f.answer(); await vi.advanceTimersByTimeAsync(15_000);
  expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2); expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  holds[0]!.resolve(); expect((await blocked).structuredContent).toMatchObject({ outcome: 'delivered', items: [a] });
  holds.forEach(h => h.resolve()); await Promise.all(calls);
});

test('blocking cancellation and stop promptly abort wait/queued release without taking', async () => {
  clock(); const f = await fixture(); const controller = new AbortController(); const wait = f.start(false);
  const blocked = f.delivery.block(wait, controller.signal, async () => {}); const cancelled = expect(blocked).rejects.toThrow('Request cancelled');
  controller.abort(); await cancelled;
  const task = f.start(); const another = f.start(false, { claimantId: id('Claimant', 'other') });
  const stopping = f.delivery.block(another, new AbortController().signal, async () => {}); f.delivery.stop();
  expect((await stopping).structuredContent).toMatchObject({ outcome: 'interrupted', items: [] });
  expect(await f.delivery.get(task.taskId!, 'owner')).toMatchObject({ status: 'failed', error: { message: 'service stopping' } });
  expect(f.delivery.start(args, true, 'owner')).toMatchObject({ structuredContent: { code: 'service_stopping' } });
});

test('timeout inside quiet reports quietUntil; uncollected tasks expire without taking; task ownership is credential-bound', async () => {
  clock(); const f = await fixture(); f.answer(); const wait = f.start(true, { maxWaitSeconds: 1 });
  await expect(f.delivery.get(wait.taskId!, 'foreign')).rejects.toThrow('Unknown task');
  vi.setSystemTime(Date.now() + 1000);
  expect(result(await f.delivery.get(wait.taskId!, 'owner'))).toMatchObject({ outcome: 'none_yet', quietUntil: f.storage.desk.read(mapId).quietUntil });
  const uncollected = f.start(true, { maxWaitSeconds: 1 }); vi.setSystemTime(Date.now() + 601_000);
  await expect(f.delivery.get(uncollected.taskId!, 'owner')).rejects.toThrow('Unknown task');
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
});

test('Map-scoped stale Reopen Requests go once to any claimant and remain recoverable', async () => {
  clock(); const f = await fixture(false); await f.apply([settle]); const revision = f.inspect().revision.revision;
  const filed = f.storage.desk.fileReopenRequest(mapId, { ticketId, settlementIntroducedAtRevision: revision, affectedTickets: [], affectedSettlementRevisions: {}, requested: { text: 'Change it' } });
  expect(filed.kind).toBe('updated');
  await f.apply([{ kind: 'ticket.reopen', ticketId, reason: 'Agreed in conversation' }, { kind: 'claim.acquire', ticketId, claimantId }, settle]);
  f.quiet(); const wait = f.start(true, { claimantId: id('Claimant', 'new-session') });
  expect(result(await f.delivery.get(wait.taskId!, 'owner'))).toMatchObject({ outcome: 'delivered', items: [{ kind: 'reopen_request', settlementIntroducedAtRevision: revision }] });
  expect(f.inspect().desk.reopenRequests).toMatchObject([{ state: 'taken', stale: true }]);
  expect(f.delivery.take(mapId, claimantId)).toMatchObject({ value: { outcome: 'none_yet', items: [] } });
});

test('unknown receipt after release and service restart preserves Taken; task handles do not survive', async () => {
  clock(); let armed = false; const f = await fixture(true, { afterPublication() { if (armed) { armed = false; throw Error('private diagnostic'); } } });
  const a = f.answer(); f.quiet(); const task = f.start(); armed = true;
  const received = result(await f.delivery.get(task.taskId!, 'owner')); expect(received).toMatchObject({ kind: 'infrastructure_error', outcome: 'unknown' });
  expect(JSON.stringify(received)).not.toContain('private'); f.storage.close(); const storage = f.lifecycle.open(f.path); cleanups.push(() => storage.close());
  const restarted = new DeskDelivery(storage); await expect(restarted.get(task.taskId!, 'owner')).rejects.toThrow('Unknown task');
  expect(storage.desk.inspect(mapId)).toMatchObject({ desk: { deskQuestions: [{ state: 'taken', currentAnswer: a }] } });
  expect(restarted.take(mapId, claimantId)).toMatchObject({ value: { items: [] } });
});

async function memory(f: Awaited<ReturnType<typeof fixture>>, toolsOnly = false) {
  const server = createMapMcpServer(f.storage, { actorId: 'actor', clientId: 'client', answerDeskEnabled: true, toolsOnly }, call => f.admission.admit(call), f.delivery);
  const client = new Client({ name: 'synthetic', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); cleanups.push(() => client.close()); cleanups.push(() => server.close());
  await client.listTools(); return client;
}

test('taking map_read is bounded, version-guarded, schema-valid and inspection/history never takes', async () => {
  clock(); const f = await fixture(); const client = await memory(f, true); const a = f.answer();
  const read = (params: object) => client.callTool({ name: 'map_read', arguments: { mapId, ...params } });
  for (const invalid of [{ claimantId }, { version }, { claimantId, version, revision: 1 }]) expect((await read(invalid)).structuredContent).toMatchObject({ kind: 'rejected', rejection: { error: { code: 'invalid_input' } } });
  expect((await read({ claimantId, version: '0.0.1' })).structuredContent).toEqual({ kind: 'rejected', code: 'version_mismatch', version: '0.0.1', rules: 'wayfinder://workflow/exploration' });
  expect((await read({ claimantId, version })).structuredContent).toMatchObject({ delivery: { outcome: 'none_yet', quietUntil: f.storage.desk.read(mapId).quietUntil } });
  f.quiet(); expect((await read({})).structuredContent).not.toHaveProperty('delivery');
  expect((await read({ revision: 2 })).structuredContent).not.toHaveProperty('delivery');
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  expect((await read({ claimantId, version })).structuredContent).toMatchObject({ delivery: { outcome: 'delivered', items: [a] } });
  expect((await read({ claimantId, version })).structuredContent).toMatchObject({ delivery: { outcome: 'none_yet', items: [] } });
});

test('blocking map_wait validates ranges, defaults and version before waiting or reading Map state', async () => {
  const f = await fixture(); const client = await memory(f);
  for (const maxWaitSeconds of [0, -1, 1.5, 1501, 28800, '1']) {
    expect((await client.callTool({ name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds } })).structuredContent)
      .toMatchObject({ kind: 'rejected', rejection: { error: { path: ['maxWaitSeconds'] } } });
  }
  expect((await client.callTool({ name: 'map_wait', arguments: { mapId: 'Missing', claimantId, version: 'old' } })).structuredContent).toMatchObject({ code: 'version_mismatch' });
  expect((await client.callTool({ name: 'map_wait', arguments: { mapId: 'Missing', claimantId, version } })).structuredContent).toMatchObject({ code: 'map_not_found' });
});

async function http(f: Awaited<ReturnType<typeof fixture>>, toolsOnly = false) {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('fixture port');
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const service = await serveLocalMcp(f.storage, { databasePath: f.path, port, token, actorId: 'actor', clientId: 'client', answerDeskEnabled: true, toolsOnly });
  cleanups.push(() => service.stop()); return { port, service };
}
async function rpcResponse(port: number, method: string, params: Record<string, unknown>, tasks: boolean | Record<string, unknown> = true) {
  return fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    ...(['tools/call', 'tasks/get', 'tasks/cancel', 'tasks/update'].includes(method) ? { 'Mcp-Name': String(params.name ?? params.taskId) } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': typeof tasks === 'object' ? tasks : tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
  } } }) });
}
async function rpc(port: number, method: string, params: Record<string, unknown>, tasks: boolean | Record<string, unknown> = true) {
  return (await rpcResponse(port, method, params, tasks)).json() as Promise<{ result: Record<string, unknown>; error?: object }>;
}

test('modern Tasks extension discovery, per-request collection, range/TTL, cancel/update errors and no subscriptions', async () => {
  const f = await fixture(); const h = await http(f);
  expect((await rpc(h.port, 'server/discover', {})).result).toMatchObject({ capabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
  const invoke = (arguments_: object) => rpc(h.port, 'tools/call', { name: 'map_wait', arguments: { mapId, claimantId, version, ...arguments_ } });
  for (const maxWaitSeconds of [0, 28801, 1.5]) expect((await invoke({ maxWaitSeconds })).result).toMatchObject({ structuredContent: { rejection: { error: { path: ['maxWaitSeconds'] } } } });
  const task = (await invoke({})).result;
  expect(task).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 29_400_000 });
  expect((await rpc(h.port, 'tasks/get', { taskId: task.taskId })).result).toMatchObject({ status: 'working' });
  expect(await rpc(h.port, 'tasks/get', { taskId: task.taskId }, false)).toHaveProperty('error');
  expect(await rpc(h.port, 'tasks/update', { taskId: task.taskId })).toHaveProperty('error');
  expect(await rpc(h.port, 'subscriptions/listen', {})).toHaveProperty('error');
  expect((await rpc(h.port, 'tasks/cancel', { taskId: task.taskId })).result).toMatchObject({ resultType: 'complete' });
  expect((await rpc(h.port, 'tasks/get', { taskId: task.taskId })).result).toMatchObject({ status: 'cancelled' });
  expect(await rpc(h.port, 'tasks/get', { taskId: 'unknown' })).toHaveProperty('error');
});

test.each(['2025-11-25', '2026-07-28'] as const)('%s enabled lists exactly five tools, taking read and blocking SSE progress work without Tasks capability', async protocol => {
  // Submission time is controlled independently of the HTTP client's real clock.
  let now = Date.now(); const f = await fixture(true, { now: () => new Date(now).toISOString() }); const h = await http(f);
  const { client } = await createHttpTestClient(h.port, token, protocol); cleanups.push(() => client.close());
  const listed = await client.listTools(); expect(listed.tools.map(t => t.name)).toEqual(['map_create', 'map_list', 'map_read', 'map_apply', 'map_wait']);
  const progress = deferred(); const values: number[] = [];
  const waiting = client.callTool({ name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds: 5 } },
    { onprogress: value => { values.push(value.progress); progress.resolve(); } });
  await progress.promise;
  // A past timestamp makes the Quiet Window eligible at the next controlled poll.
  now = Date.now() - 15_000; const a = f.answer(); now = Date.now();
  const delivered = await waiting;
  expect(values.length).toBeGreaterThan(0); expect(delivered.structuredContent).toMatchObject({ outcome: 'delivered', items: [a] });
  const ajv = new Ajv({ strict: false }); const validate = ajv.compile(answerDeskMapTools.find(t => t.name === 'map_wait')!.outputSchema! as AnySchema);
  expect(validate(delivered.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  const read = await client.callTool({ name: 'map_read', arguments: { mapId, claimantId, version } });
  expect(read.structuredContent).toMatchObject({ delivery: { outcome: 'none_yet', items: [] }, deskQuestions: [{ state: 'taken' }] });
});

test.each((['2025-11-25', '2026-07-28'] as const).flatMap(protocol => [false, true].map(progress => ({ protocol, progress }))))(
  '$protocol cancellation ends a blocking wait promptly (progress=$progress) and shutdown drains it', async ({ protocol, progress: withProgress }) => {
  const f = await fixture(); const h = await http(f); const { client } = await createHttpTestClient(h.port, token, protocol);
  cleanups.push(() => client.close()); const progress = deferred(); const abort = new AbortController();
  const inspect = f.storage.desk.inspect.bind(f.storage.desk);
  const spy = vi.spyOn(f.storage.desk, 'inspect').mockImplementation(map => { const value = inspect(map); if (!withProgress) progress.resolve(); return value; });
  cleanups.push(() => spy.mockRestore());
  const waiting = client.callTool({ name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds: 600 } },
    { signal: abort.signal, ...(withProgress ? { onprogress: () => progress.resolve() } : {}) });
  const rejected = expect(waiting).rejects.toThrow(); await progress.promise; abort.abort(); await rejected;
  // Observe completion before stop(), so shutdown cannot conceal a stuck wait.
  await vi.waitFor(() => {
    const records = readFileSync(`${f.path}.calls.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(record => record.tool === 'map_wait')).toMatchObject([{ result: 'transport-failure' }]);
  });
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('pending');
  await h.service.stop();
});

test('recorded ChatGPT capabilities have no Tasks extension: map_wait uses blocking result and toolsOnly taking read states the release', async () => {
  const f = await fixture(); const h = await http(f, true);
  const capabilities = chatgptDiscovery.params._meta['io.modelcontextprotocol/clientCapabilities'];
  const discovered = await rpc(h.port, 'server/discover', {}, capabilities);
  expect(discovered.result).toHaveProperty('capabilities');
  const listed = (await rpc(h.port, 'tools/list', {}, capabilities)).result.tools as { name: string; inputSchema: object }[];
  expect(JSON.stringify(listed.find(t => t.name === 'map_read')!.inputSchema)).toContain(version);
  const waited = await rpc(h.port, 'tools/call', { name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds: 1 } }, capabilities);
  expect(waited.result).toMatchObject({ resultType: 'complete', content: [], structuredContent: { outcome: 'none_yet', items: [] } });
  expect(waited.result).not.toHaveProperty('taskId');
});

test.each(['2025-11-25', '2026-07-28'] as const)('%s shutdown interrupts a connected blocking wait without waiting for its deadline', async protocol => {
  const f = await fixture(); const h = await http(f); const { client } = await createHttpTestClient(h.port, token, protocol);
  cleanups.push(() => client.close()); const progress = deferred();
  const waiting = client.callTool({ name: 'map_wait', arguments: { mapId, claimantId, version } }, { onprogress: () => progress.resolve() });
  await progress.promise; const stopped = h.service.stop();
  expect((await waiting).structuredContent).toMatchObject({ outcome: 'interrupted', items: [] }); await stopped;
});

test('a lost modern task response is recoverable through codec-valid retry and current read', async () => {
  let now = Date.now(); const f = await fixture(true, { now: () => new Date(now).toISOString() }); const h = await http(f);
  const task = (await rpc(h.port, 'tools/call', { name: 'map_wait', arguments: { mapId, claimantId, version } })).result;
  now = Date.now() - 15_000; const a = f.answer(); now = Date.now();
  expect(f.inspect().desk.deskQuestions[0]!.state).toBe('answered');
  // Drop the first response without decoding it: receipt is unknown after commit.
  const lost = await rpcResponse(h.port, 'tasks/get', { taskId: task.taskId });
  expect(lost.ok).toBe(true); await lost.body!.cancel();
  expect(f.inspect().desk.deskQuestions[0]!).toMatchObject({ state: 'taken', currentAnswer: a });
  const completed = (await rpc(h.port, 'tasks/get', { taskId: task.taskId })).result;
  expect(result(completed)).toMatchObject({ outcome: 'delivered', items: [a] });
  expect((await rpc(h.port, 'tasks/get', { taskId: task.taskId })).result).toEqual(completed);
  const read = await rpc(h.port, 'tools/call', { name: 'map_read', arguments: { mapId } }, false);
  expect(read.result.structuredContent).toMatchObject({ deskQuestions: [{ state: 'taken', currentAnswer: a }] });
});

test.each((['2025-11-25', '2026-07-28'] as const).flatMap(protocol => [false, true].map(progress => ({ protocol, progress }))))(
  '$protocol HTTP disconnect cancels a blocking wait before a later answer (progress=$progress)', async ({ protocol, progress }) => {
  let now = Date.now(); const f = await fixture(true, { now: () => new Date(now).toISOString() }); const h = await http(f);
  const { client, transport } = await createHttpTestClient(h.port, token, protocol); cleanups.push(() => client.close());
  const started = deferred(); const block = DeskDelivery.prototype.block;
  const spy = vi.spyOn(DeskDelivery.prototype, 'block').mockImplementation(function (this: DeskDelivery, ...args) {
    const waiting = block.apply(this, args); started.resolve(); return waiting;
  });
  cleanups.push(() => spy.mockRestore());
  const abort = new AbortController();
  const waiting = fetch(`http://127.0.0.1:${h.port}/mcp`, { method: 'POST', signal: abort.signal, headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    'MCP-Protocol-Version': protocol, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'map_wait',
    ...(transport.sessionId ? { 'Mcp-Session-Id': transport.sessionId } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: {
    name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds: 600 }, _meta: {
      ...(progress ? { progressToken: 'disconnect-probe' } : {}),
      ...(protocol === '2026-07-28' ? { 'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } : {}),
    },
  } }) }).then(response => response.text());
  const rejected = expect(waiting).rejects.toThrow(); await started.promise;
  // Raw fetch abort: no MCP notifications/cancelled is sent.
  abort.abort(); await rejected;
  await vi.waitFor(() => {
    const records = readFileSync(`${f.path}.calls.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(record => record.tool === 'map_wait')).toMatchObject([{ result: 'transport-failure' }]);
  });
  // Submit only after the abandoned call has ended, with an expired Quiet Window.
  now = Date.now() - 15_000; const a = f.answer(); now = Date.now();
  expect(f.inspect().desk.deskQuestions[0]!).toMatchObject({ state: 'answered', currentAnswer: a });
  const next = await client.callTool({ name: 'map_wait', arguments: { mapId, claimantId, version, maxWaitSeconds: 1 } });
  expect(next.structuredContent).toMatchObject({ outcome: 'delivered', items: [a] });
});


test('W114: a turn-start taking read can settle and post its newly unlocked question in one write', async () => {
  clock(); const f = await fixture(); const client = await memory(f, true);
  const next = id('Ticket', 'Next');
  await f.apply([{ kind: 'ticket.create', ticket: { id: next, title: 'Next', question: 'Next choice?', type: 'grilling' } },
    { kind: 'dependency.add', dependentId: next, prerequisiteId: ticketId }]);
  const a = f.answer(2); f.quiet();
  const read = (await client.callTool({ name: 'map_read', arguments: { mapId, claimantId, version } })).structuredContent as Record<string, unknown>;
  expect(read).toMatchObject({ delivery: { outcome: 'delivered', items: [a] } });
  const head = (read.revision as { revision: number }).revision;
  const written = await client.callTool({ name: 'map_apply', arguments: { mapId, version, expectedRevision: head, commands: [
    { ...settle, deskAnswer: { answerId: a.answerId, questionVersion: a.questionVersion },
      settlement: { ...settle.settlement, outcome: { kind: 'decision', statement: 'B — Second', rationale: 'Kun selected option 2' } } },
    { kind: 'claim.acquire', ticketId: next, claimantId },
    { kind: 'deskQuestion.post', ticketId: next, claimantId, question: { ...question, questionId: 'Q.Next' } },
  ] } });
  expect(written.structuredContent).toMatchObject({ kind: 'committed', revision: head + 1 });
  expect(f.inspect().desk.deskQuestions).toEqual(expect.arrayContaining([
    expect.objectContaining({ ticketId, state: 'settled' }), expect.objectContaining({ ticketId: next, state: 'pending' }),
  ]));
});
