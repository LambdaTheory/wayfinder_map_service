import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test, vi } from 'vitest';
import { startLocalMcpService } from '../src/mcp-service.js';
import { serveLocalMcp } from '../src/mcp-http-internal.js';
import { initializeSQLite, openSQLite } from '../src/sqlite-storage.js';
import { createMapMcpServer, workflowContract } from '../src/mcp-tools.js';
import { appendPrivateMetadata } from '../src/call-metadata.js';
import type { CallMetadataRecord } from '../src/call-metadata.js';
import { classifyResult } from './behaviour/evidence.js';
import { freePort } from './behaviour/runner/service.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const token = 'synthetic-metadata-credential-0000000000';
const clientId = 'Codex:synthetic:high';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const version = workflowContract.version;

function directory() {
  const root = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'b07-unit-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(failStorage = false, toolsOnly = false) {
  const dir = directory(); const path = join(dir, 'maps.sqlite'); initializeSQLite(path);
  const config = { databasePath: path, port: await freePort(), token, actorId: 'synthetic', clientId, toolsOnly };
  const storage = openSQLite(path);
  const service = failStorage ? await serveLocalMcp({ ...storage, listMaps() { throw new Error('private body /private/path secret'); } }, config)
    : await serveLocalMcp(storage, config);
  cleanups.push(() => service.stop());
  const log = `${path}.calls.jsonl`;
  const records = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CallMetadataRecord);
  return { dir, path, log, config, service, records };
}
async function post(port: number, body: unknown, session?: string, bearer = token) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: {
    Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}),
  }, body: JSON.stringify(body) });
  return { status: response.status, session: response.headers.get('mcp-session-id'), body: await response.text() };
}
async function initialize(port: number, bearer = token) {
  const result = await post(port, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' },
  } }, undefined, bearer);
  expect(result.status).toBe(200); expect(result.session).toBeTruthy();
  return result as typeof result & { session: string };
}
const call = (port: number, session: string, id: number | string, name: string, args: unknown = {}, bearer = token) =>
  post(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, session, bearer);
const create = { mapId: 'B07.Map', title: 'PRIVATE-CONTENT', destination: 'PRIVATE-CONTENT', version };

test('B07: every tool outcome persists with B01 request/session correlation, even when nothing was written', async () => {
  const f = await fixture(); const session = (await initialize(f.config.port)).session;
  const cases: [string, unknown][] = [
    ['map_list', {}], ['map_create', create], ['map_read', { mapId: create.mapId }],
    ['map_create', create], ['map_create', { ...create, version: 'old' }],
    ['map_apply', { mapId: create.mapId, version, expectedRevision: 2, commands: [{ kind: 'map.update', patch: { notes: 'PRIVATE-CONTENT' } }] }],
    ['map_read', { mapId: 'Absent' }], ['map_read', { mapId: '/private/path' }],
    ['map_apply', { mapId: create.mapId, version, expectedRevision: 1, commands: [{ kind: 'claim.acquire', ticketId: 'Absent', claimantId: 'A' }] }],
  ];
  for (const [index, [tool, args]] of cases.entries()) {
    const response = await call(f.config.port, session, index + 1, tool, args);
    const record = f.records().at(-1)!;
    expect(record).toMatchObject({ schema: 'wayfinder-service-call/1', mcpSessionId: session, requestId: String(index + 1),
      clientId, credentialFingerprint: sha(token), tool, result: classifyResult(JSON.parse(response.body).result.structuredContent) });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(f.records().map(record => record.result)).toEqual(['ok', 'read', 'committed', 'read', 'map-exists',
    'version-mismatch', 'conflict', 'not-found', 'input-error', 'command-rejected']);
  for (const args of [null, 'PRIVATE-CONTENT']) {
    await call(f.config.port, session, 100, 'map_list', args);
    expect(f.records().at(-1)!.result).toBe('transport-failure');
  }
  await call(f.config.port, session, '/private/path', 'PRIVATE-CONTENT', { mapId: token });
  expect(f.records().at(-1)).toMatchObject({ requestId: null, tool: null, mapId: null, result: 'transport-failure' });
  const text = readFileSync(f.log, 'utf8');
  for (const secret of [token, 'PRIVATE-CONTENT', '/private/path', f.path]) expect(text).not.toContain(secret);
  await call(f.config.port, session, -42, 'map_list');
  expect(f.records().at(-1)).toMatchObject({ requestId: '-42', result: 'read' });
  expect(statSync(f.log).mode & 0o777).toBe(0o600);
  expect(f.service.metadataStatus()).toEqual({ observations: f.records().length, missingObservations: 0 });
});

test('B07: storage failures leave safe metadata without changing the infrastructure receipt', async () => {
  const f = await fixture(true); const session = (await initialize(f.config.port)).session;
  const response = await call(f.config.port, session, 'read-failed', 'map_list');
  expect(JSON.parse(response.body).result).toEqual({ content: [], structuredContent: {
    kind: 'infrastructure_error', code: 'storage_failure', outcome: 'unknown', requiresRestart: true,
  }, isError: true });
  expect(f.records().at(-1)).toMatchObject({ requestId: 'read-failed', result: 'service-failure' });
  expect(readFileSync(f.log, 'utf8')).not.toContain('private');
});

test('B07: same Combination, different credentials/sessions, and restart all retain correlation', async () => {
  const f = await fixture(); await f.service.stop();
  const other = 'synthetic-metadata-credential-1111111111';
  const credentialsPath = join(f.dir, 'credentials.json');
  writeFileSync(credentialsPath, JSON.stringify({ credentials: [{ clientId, tokenSha256: sha(other) }] }), { mode: 0o600 });
  const service = await startLocalMcpService({ ...f.config, credentialsPath }); cleanups.push(() => service.stop());
  const a = await initialize(f.config.port); const b = await initialize(f.config.port, other);
  await call(f.config.port, a.session, 1, 'map_list');
  await call(f.config.port, b.session, 1, 'map_list', {}, other);
  const calls = f.records().filter(record => record.tool === 'map_list');
  expect(calls.map(record => record.clientId)).toEqual([clientId, clientId]);
  expect(calls.map(record => record.mcpSessionId)).toEqual([a.session, b.session]);
  expect(a.session).not.toBe(b.session);
  expect(calls.map(record => record.credentialFingerprint)).toEqual([sha(token), sha(other)]);
  writeFileSync(credentialsPath, JSON.stringify({ credentials: [{ clientId: 'Changed', tokenSha256: sha(other) }] }));
  const write = await call(f.config.port, b.session, 2, 'map_create', { ...create, includeSnapshot: true }, other);
  expect(JSON.parse(write.body).result.structuredContent.revision.author.clientId).toBe(clientId);
  expect(f.records().at(-1)!.clientId).toBe(clientId);
  await service.stop();
  const restarted = await startLocalMcpService(f.config); cleanups.push(() => restarted.stop());
  const c = await initialize(f.config.port); await call(f.config.port, c.session, 1, 'map_list');
  expect(f.records().filter(record => record.tool === 'map_list')).toHaveLength(3);
});

test('B07: failed metadata appends expose gaps, recover, and leave exact response bytes unchanged', async () => {
  const f = await fixture(); const session = (await initialize(f.config.port)).session;
  const before = await call(f.config.port, session, 1, 'map_list');
  rmSync(f.log); mkdirSync(f.log);
  const failed = await call(f.config.port, session, 1, 'map_list');
  expect(failed.body).toBe(before.body);
  const committed = await call(f.config.port, session, 2, 'map_create', create);
  expect(JSON.parse(committed.body).result.structuredContent.kind).toBe('committed');
  expect(f.service.metadataStatus()).toEqual({ observations: 4, missingObservations: 2 });
  rmSync(f.log, { recursive: true });
  await call(f.config.port, session, 3, 'map_read', { mapId: create.mapId });
  expect(f.records()).toMatchObject([{ sequence: 5, missingObservations: 2, result: 'read' }]);
});

test.each([false, true])('B07: observed HTTP results match the uninstrumented tool server byte for byte (toolsOnly=%s)', async toolsOnly => {
  const f = await fixture(false, toolsOnly);
  const baselinePath = join(directory(), 'baseline.sqlite'); initializeSQLite(baselinePath); const storage = openSQLite(baselinePath);
  cleanups.push(() => storage.close());
  const server = createMapMcpServer(storage, { actorId: 'synthetic', clientId, toolsOnly, viewerOrigin: `http://127.0.0.1:${f.config.port}` });
  const client = new Client({ name: 'synthetic', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: string[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => { if ('result' in message) messages.push(JSON.stringify(message.result)); await send(message, options); };
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const initialized = await initialize(f.config.port);
  expect(JSON.stringify(JSON.parse(initialized.body).result)).toBe(messages.at(-1));
  await client.listTools();
  const listed = await post(f.config.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, initialized.session);
  expect(JSON.stringify(JSON.parse(listed.body).result)).toBe(messages.at(-1));
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-26T00:00:00.000Z');
  for (const [name, args] of [['map_create', create], ['map_list', {}], ['map_read', { mapId: create.mapId }],
    ['map_apply', { version, mapId: create.mapId, expectedRevision: 9, commands: [{ kind: 'map.update', patch: { notes: 'changed' } }] }],
    ['map_create', { ...create, version: 'old' }]] as const) {
    await client.callTool({ name, arguments: args });
    const observed = await call(f.config.port, initialized.session, 2, name, args);
    expect(JSON.stringify(JSON.parse(observed.body).result)).toBe(messages.at(-1));
  }
});

test('B07: metadata refuses symlinks and public files without modifying them', () => {
  const dir = directory(); const target = join(dir, 'target'); const link = join(dir, 'link');
  writeFileSync(target, 'private', { mode: 0o600 }); symlinkSync(target, link);
  expect(() => appendPrivateMetadata(link, {})).toThrow();
  chmodSync(target, 0o644); expect(() => appendPrivateMetadata(target, {})).toThrow();
  expect(readFileSync(target, 'utf8')).toBe('private');
});

test('B07: real launcher entry records use existing credentials, without a model or private state', () => {
  const dir = directory();
  const result = execFileSync('python3', ['tests/helpers/launcher-metadata.py'], { encoding: 'utf8', env: {
    PATH: process.env.PATH!, HOME: dir, WAYFINDER_AGENT_STATE_ROOT: join(dir, 'state'),
    WAYFINDER_AGENT_SERVICE_DIR: join(dir, 'service'), WAYFINDER_AGENT_OUTPUTS: join(dir, 'outputs'),
  } });
  expect(result.trim()).toBe('launcher metadata verified');
});
