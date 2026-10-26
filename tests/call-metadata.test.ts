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
import { appendPrivateMetadata, CallMetadata, credentialFingerprint, requestIdHash } from '../src/call-metadata.js';
import * as metadataModule from '../src/call-metadata.js';
import { createHttpTestClient } from './helpers/mcp-http-client.mjs';
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
  const records = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CallMetadataRecord).filter(record => record.schema === 'wayfinder-service-call/1');
  return { dir, path, log, config, service, records };
}
async function post(port: number, body: unknown, session?: string, bearer: string | null = token) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: {
    ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
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
      clientId, credentialFingerprint: credentialFingerprint(token), tool, result: classifyResult(JSON.parse(response.body).result.structuredContent) });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(f.records().map(record => record.result)).toEqual(['ok', 'read', 'committed', 'read', 'map-exists',
    'version-mismatch', 'conflict', 'not-found', 'input-error', 'command-rejected']);
  for (const args of [null, 'PRIVATE-CONTENT']) {
    await call(f.config.port, session, 100, 'map_list', args);
    expect(f.records().at(-1)!.result).toBe('transport-failure');
  }
  await call(f.config.port, session, '/private/path', 'PRIVATE-CONTENT', { mapId: token });
  expect(f.records().at(-1)).toMatchObject({ requestId: null, requestIdHash: requestIdHash('/private/path'), tool: null, mapId: null, result: 'transport-failure' });
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
  expect(calls.map(record => record.credentialFingerprint)).toEqual([credentialFingerprint(token), credentialFingerprint(other)]);
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

test.each([false, true].flatMap(toolsOnly => ['none', 'missing-store', 'throwing-store', 'classification'].map(fault => ({ toolsOnly, fault }))))(
  'B07: response bytes match without observation ($toolsOnly, $fault)', async ({ toolsOnly, fault }) => {
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
  if (fault === 'classification') vi.spyOn(metadataModule, 'classifyCallResult').mockImplementation(() => { throw new Error('Synthetic classifier failure'); });
  if (fault === 'missing-store' || fault === 'throwing-store') {
    const begin = CallMetadata.prototype.begin;
    vi.spyOn(CallMetadata.prototype, 'begin').mockImplementation(function(this: CallMetadata, ...args) {
      vi.spyOn(this.context, 'getStore').mockImplementation(() => {
        if (fault === 'throwing-store') throw new Error('Synthetic context failure');
        return undefined;
      });
      return begin.apply(this, args);
    });
  }
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
  expect(f.service.metadataStatus().missingObservations).toBe(fault === 'classification' ? 5 : fault === 'throwing-store' ? 7 : 0);
});

test('B07: real SDK GET stream probe is expected, and HTTP/session fields remain available', async () => {
  const f = await fixture();
  const { client, transport, streamProbe } = await createHttpTestClient(f.config.port, token);
  cleanups.push(() => client.close());
  expect(await streamProbe).toEqual({ status: 405 });
  await client.callTool({ name: 'map_list', arguments: {} });
  await transport.terminateSession();
  const records = f.records();
  expect(records.filter(record => record.result === 'transport-failure')).toEqual([]);
  const initialized = records.find(record => record.method === 'initialize')!;
  expect(records.find(record => record.httpMethod === 'GET')).toMatchObject({ result: 'stream-not-supported',
    httpStatus: 405, mcpSessionId: initialized.mcpSessionId, presentedMcpSessionId: initialized.mcpSessionId });
  expect(records.find(record => record.tool === 'map_list')).toMatchObject({ result: 'read', httpMethod: 'POST', httpStatus: 200 });
  expect(records.find(record => record.httpMethod === 'DELETE')).toMatchObject({ result: 'ok', httpStatus: 200 });
});

test('B07: stale sessions and non-ID request strings retain safe correlation across restart', async () => {
  const f = await fixture(); const a = await initialize(f.config.port); await f.service.stop();
  const service = await startLocalMcpService(f.config); cleanups.push(() => service.stop());
  for (const bearer of [null, 'synthetic-rejected-bearer-credential-0000']) {
    for (const presentedSession of ['Kun-private-plan-name', 'synthetic-other-credential-0000000000']) {
      const denied = await post(f.config.port, { jsonrpc: '2.0', id: 'Private-request-content', method: 'tools/call',
        params: { name: 'map_read', arguments: { mapId: 'Private-map-content' } } }, presentedSession, bearer);
      expect(denied.status).toBe(401);
      expect(denied.body).toBe(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Local token required' }, id: null }));
      expect(f.records().at(-1)).toMatchObject({ httpMethod: 'POST', httpStatus: 401, result: 'transport-failure',
        mcpSessionId: null, presentedMcpSessionId: null, clientId: null, credentialFingerprint: null,
        requestId: null, requestIdType: null, requestIdHash: null, method: null, tool: null, mapId: null });
      const logged = readFileSync(f.log, 'utf8');
      for (const content of [presentedSession, bearer, 'Private-request-content', 'Private-map-content'].filter(value => value !== null)) {
        expect(logged).not.toContain(content);
      }
    }
  }
  const rawId = '/private/synthetic request';
  const response = await call(f.config.port, a.session, rawId, 'map_list');
  expect(response.status).toBe(404);
  expect(f.records().at(-1)).toMatchObject({ mcpSessionId: null, presentedMcpSessionId: a.session,
    requestId: null, requestIdType: 'string', requestIdHash: requestIdHash(rawId), httpStatus: 404, result: 'transport-failure' });
  const b = await initialize(f.config.port);
  await call(f.config.port, b.session, 1, 'map_list'); await call(f.config.port, b.session, '1', 'map_list');
  expect(f.records().slice(-2).map(record => [record.requestId, record.requestIdType])).toEqual([['1', 'number'], ['1', 'string']]);
  expect(readFileSync(f.log, 'utf8')).not.toContain(rawId);
});

test.each([false, true])('B07: the last failed observation stays durable across stop and restart (log stays blocked=%s)', async staysBlocked => {
  const f = await fixture(); const session = (await initialize(f.config.port)).session;
  rmSync(f.log); mkdirSync(f.log);
  await call(f.config.port, session, 1, 'map_list');
  const gaps = `${f.path}.calls.gaps.jsonl`;
  expect(JSON.parse(readFileSync(gaps, 'utf8').trim())).toMatchObject({ schema: 'wayfinder-service-call-gap/1', observations: 2, missingObservations: 1 });
  if (!staysBlocked) rmSync(f.log, { recursive: true });
  await f.service.stop();
  const summaryFile = staysBlocked ? gaps : f.log;
  expect(JSON.parse(readFileSync(summaryFile, 'utf8').trim().split('\n').at(-1)!))
    .toMatchObject({ schema: 'wayfinder-service-call-summary/1', observations: 2, missingObservations: 1 });
  if (staysBlocked) rmSync(f.log, { recursive: true });
  const persistedGaps = readFileSync(gaps, 'utf8');
  const restarted = await startLocalMcpService(f.config); cleanups.push(() => restarted.stop());
  await initialize(f.config.port); await restarted.stop();
  expect(readFileSync(gaps, 'utf8')).toBe(persistedGaps);
  expect(statSync(gaps).mode & 0o777).toBe(0o600);
});

test('B07: observations hold no raw credentials and fingerprints are separated from authentication verifiers', () => {
  const metadata = new CallMetadata('/synthetic', token);
  const observation = metadata.begin('POST');
  metadata.identify(observation, clientId, token, token);
  metadata.capture(observation, { id: token, method: 'tools/call', params: { name: 'map_read', arguments: { mapId: token } } });
  expect(JSON.stringify(observation)).not.toContain(token);
  expect(observation!.fields).toMatchObject({ presentedMcpSessionId: null, mapId: null, requestId: null, requestIdHash: requestIdHash(token) });
  expect(credentialFingerprint(token)).not.toBe(sha(token));
});

test('B07: context plumbing never replays business work, including synchronous failure', async () => {
  const metadata = new CallMetadata('/synthetic', token);
  const failure = new Error('Business failure');
  let calls = 0;
  await expect(metadata.run(undefined, () => { calls++; throw failure; })).rejects.toBe(failure);
  expect(calls).toBe(1);
  vi.spyOn(metadata.context, 'run').mockImplementation((_store, callback) => { callback(); throw new Error('Context cleanup failure'); });
  expect(await metadata.run(undefined, async () => { calls++; return 42; })).toBe(42);
  expect(calls).toBe(2);
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
