import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/server';
type CallToolResult = SdkCallToolResult & { structuredContent?: Record<string, unknown> };
import { Ajv, type AnySchema } from 'ajv';
import { afterEach, expect, test } from 'vitest';
import { createHttpTestClient } from './helpers/mcp-http-client.mjs';
import { serveLocalMcp } from '../src/mcp-http-internal.js';
import { mapTools } from '../src/mcp-tools.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import { prepareCreate } from '../src/index.js';
import type { CreateMapInput } from '../src/index.js';
import { versioned } from './helpers/write-version.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const token = 'isolated-viewer-token-not-a-live-credential';
const ajv = new Ajv({ strict: false });
const outputs = new Map(mapTools.map(tool => [tool.name, ajv.compile(tool.outputSchema! as AnySchema)]));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function service() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-viewer-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite');
  const lifecycle = sqliteLifecycleForTests();
  lifecycle.initialize(path);
  const storage = lifecycle.open(path);
  cleanups.push(() => storage.close());
  const port = await freePort();
  const running = await serveLocalMcp(storage, { databasePath: path, port, token, actorId: 'operator', clientId: 'viewer-test' });
  cleanups.push(() => running.stop());
  const { client } = await createHttpTestClient(port, token);
  cleanups.push(() => client.close());
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: versioned(name, args) }) as CallToolResult;
    expect(outputs.get(name)!(result.structuredContent), JSON.stringify(outputs.get(name)!.errors)).toBe(true);
    return result.structuredContent!;
  }
  const mapId = 'Viewer.Alpha';
  return { port, storage, call, mapId, origin: `http://127.0.0.1:${port}`,
    create: (identity = mapId, includeSnapshot = false) => call('map_create', { mapId: identity, title: 'Viewer map', destination: 'See the route', includeSnapshot }),
    apply: (commands: unknown[], expectedRevision: number) => call('map_apply', { mapId, expectedRevision, commands }),
  };
}
type Reply = { status: number; headers: IncomingHttpHeaders; body: string; json(): unknown };
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body = ''): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const length = body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {};
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { ...length, ...headers } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => text += data);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: text, json: () => JSON.parse(text) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };
const ticket = (id: string) => ({ kind: 'ticket.create', ticket: { id, title: `Ticket ${id}`, question: `${id}?`, type: 'task' } });

test('H01: viewer pages and data need no token while /mcp still does; only GET/HEAD from this origin or a typed address', async () => {
  const f = await service();
  await f.create();
  const page = await get(f.port, `/maps/${f.mapId}`);
  expect(page.status).toBe(200);
  expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(page.body).toContain('/viewer/viewer.js');
  expect(page.headers['content-security-policy']).toContain("default-src 'self'");
  expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
  expect((await get(f.port, '/')).status).toBe(200);
  expect((await get(f.port, '/viewer/viewer.js', sameOrigin)).headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect((await get(f.port, '/viewer/viewer.css', sameOrigin)).headers['content-type']).toBe('text/css; charset=utf-8');
  expect((await get(f.port, `/api/maps/${f.mapId}/view`, sameOrigin)).status).toBe(200);
  expect((await get(f.port, '/api/maps', { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  expect((await get(f.port, '/api/maps', { Origin: f.origin })).status).toBe(200);

  // /mcp keeps its token, Host and Origin guards; a viewer path never reaches them.
  expect((await get(f.port, '/mcp', { 'Content-Type': 'application/json' }, 'POST', '{}')).status).toBe(401);
  expect((await get(f.port, '/mcp?token=private', { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, 'POST', '{}')).status).toBe(404);
  for (const [path, headers, status] of [
    ['/', { Host: 'evil.example' }, 403], ['/api/maps', { Host: `localhost:${f.port}` }, 403],
    ['/api/maps', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }, 403],
    ['/api/maps', { 'Sec-Fetch-Site': 'same-site' }, 403], ['/api/maps', { Origin: 'https://evil.example' }, 403],
    ['/viewer/viewer.js', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' }, 403],
    ['/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' }, 403],
    [`/api/maps/${f.mapId}/view`, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }, 403],
    // A link from another app (Codex, Orca) may open a page, which holds no Map data.
    [`/maps/${f.mapId}`, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }, 200],
    ['/viewer/../package.json', {}, 404], ['/viewer/%2e%2e/package.json', {}, 404], ['/viewer/', {}, 404],
    ['/viewer/constructor', {}, 404], ['/maps/a/b', {}, 404], ['/api/maps/Viewer.Alpha', {}, 404],
  ] as const) {
    expect((await get(f.port, path, headers)).status, `${path} ${JSON.stringify(headers)}`).toBe(status);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const reply = await get(f.port, '/api/maps', { ...sameOrigin, 'Content-Type': 'application/json' }, method, '{}');
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET, HEAD');
  }
  const head = await get(f.port, `/api/maps/${f.mapId}/view`, sameOrigin, 'HEAD');
  expect(head.status).toBe(200);
  expect(head.body).toBe('');
});

test('H02: the view answers 204 until a Revision commits, then the new Revision with what it changed', async () => {
  const f = await service();
  await f.create();
  const first = await get(f.port, `/api/maps/${f.mapId}/view`, sameOrigin);
  expect(first.json()).toMatchObject({ mapId: f.mapId, title: 'Viewer map', destination: 'See the route', revision: 1, clientId: 'viewer-test',
    tickets: [], fog: [], scopeExclusions: [], routeClear: false, latest: [{ kind: 'map.create', subjectId: f.mapId }] });
  expect((await get(f.port, `/api/maps/${f.mapId}/view?known=1`, sameOrigin)).status).toBe(204);
  await f.apply([ticket('T1'), ticket('T2'), { kind: 'dependency.add', dependentId: 'T2', prerequisiteId: 'T1' },
    { kind: 'content.add', section: 'fog', item: { id: 'F1', text: 'Unclear', references: [] } }], 1);
  await f.apply([{ kind: 'claim.acquire', ticketId: 'T1', claimantId: 'session:test' }], 2);
  const followed = (await get(f.port, `/api/maps/${f.mapId}/view?known=1`, sameOrigin)).json();
  expect(followed).toMatchObject({ revision: 3, latest: [{ kind: 'claim.acquire', subjectId: 'T1', label: 'Ticket T1' }],
    fog: [{ id: 'F1', text: 'Unclear' }], tickets: [
      { id: 'T1', state: 'inProgress', claimantId: 'session:test', layer: 0, row: 0, dependents: ['T2'] },
      { id: 'T2', state: 'waiting', layer: 1, row: 0, prerequisites: ['T1'] },
    ] });
  expect((await get(f.port, `/api/maps/${f.mapId}/view?known=3`, sameOrigin)).status).toBe(204);
  expect((await get(f.port, `/api/maps/${f.mapId}/view?known=9`, sameOrigin)).json()).toMatchObject({ revision: 3 });
  await f.apply([{ kind: 'content.remove', section: 'fog', itemId: 'F1' }], 3);
  expect((await get(f.port, `/api/maps/${f.mapId}/view?known=3`, sameOrigin)).json()).toMatchObject({
    revision: 4, fog: [], latest: [{ kind: 'fog.remove', subjectId: 'F1', label: 'Unclear' }] });

  for (const [path, status, error] of [
    ['/api/maps/Missing.Map/view', 404, 'map_not_found'], ['/api/maps/bad%20id/view', 400, 'invalid_map_id'],
    ['/api/maps/%E0%A4%A/view', 400, 'invalid_map_id'], [`/api/maps/${f.mapId}/view?known=-1`, 400, 'invalid_known_revision'],
    [`/api/maps/${f.mapId}/view?known=1.5`, 400, 'invalid_known_revision'], [`/api/maps/${f.mapId}/view?known=99999999999999999`, 400, 'invalid_known_revision'],
  ] as const) {
    const reply = await get(f.port, path, sameOrigin);
    expect(reply.status, path).toBe(status);
    expect(reply.json()).toEqual({ error });
  }
});

test('H03: details read Destination and Fog history on request', async () => {
  const f = await service();
  await f.create();
  await f.apply([{ kind: 'content.add', section: 'fog', item: { id: 'F1', text: 'Unclear', references: [] } }], 1);
  await f.apply([{ kind: 'map.update', patch: { destination: 'See the whole route' } }], 2);
  const destination = (await get(f.port, `/api/maps/${f.mapId}/history?subject=destination`, sameOrigin)).json();
  expect(destination).toMatchObject({ created: { revision: 1, clientId: 'viewer-test', destination: 'See the route' },
    changes: [{ revision: 3, destination: 'See the whole route', previous: 'See the route' }] });
  expect((await get(f.port, `/api/maps/${f.mapId}/history?subject=fog:F1`, sameOrigin)).json()).toMatchObject({ appearedAt: { revision: 2 } });
  expect((await get(f.port, `/api/maps/${f.mapId}/history?subject=fog:Gone`, sameOrigin)).json()).toEqual({ appearedAt: null });
  for (const subject of ['', 'fog:', 'fog:bad id', 'ticket:T1']) {
    expect((await get(f.port, `/api/maps/${f.mapId}/history?subject=${encodeURIComponent(subject)}`, sameOrigin)).status, subject).toBe(400);
  }
  expect((await get(f.port, '/api/maps/Missing.Map/history?subject=destination', sameOrigin)).status).toBe(404);
});

test('H04: map_create and map_read return the viewer link; map_apply does not; the list covers every catalog page', async () => {
  const f = await service();
  const link = `${f.origin}/maps/${f.mapId}`;
  expect(await f.create()).toMatchObject({ kind: 'committed', revision: 1, viewerUrl: link });
  expect(await f.create('Viewer.Snapshot', true)).toMatchObject({ kind: 'committed', frontier: [], viewerUrl: `${f.origin}/maps/Viewer.Snapshot` });
  expect(await f.call('map_read', { mapId: f.mapId })).toMatchObject({ kind: 'found', viewerUrl: link });
  expect(await f.call('map_read', { mapId: f.mapId, revision: 1 })).toMatchObject({ kind: 'found', viewerUrl: link });
  expect(await f.apply([ticket('T1')], 1)).not.toHaveProperty('viewerUrl');
  expect(await f.call('map_read', { mapId: 'Missing.Map' })).toEqual({ kind: 'not_found', code: 'map_not_found', mapId: 'Missing.Map' });
  expect((await get(f.port, new URL(link).pathname, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).status).toBe(200);

  for (let i = 0; i < 100; i++) {
    const created = prepareCreate({ id: `Bulk.${String(i).padStart(3, '0')}`, title: `Bulk ${i}`, destination: 'Listed',
      author: { actorId: 'operator', clientId: 'viewer-test', occurredAt: new Date().toISOString() } } as unknown as CreateMapInput);
    if (created.kind !== 'ok') throw new Error('Invalid bulk fixture');
    await f.storage.adapter.commit(created.value);
  }
  const listed = (await get(f.port, '/api/maps', sameOrigin)).json() as { maps: { mapId: string; currentRevision: number }[] };
  expect(listed.maps).toHaveLength(102);
  expect(listed.maps.at(-1)).toMatchObject({ mapId: 'Viewer.Snapshot', currentRevision: 1 });
  expect(listed.maps.find(map => map.mapId === f.mapId)).toMatchObject({ currentRevision: 2 });
});

test('H05: a storage fault reports the viewer unavailable without diagnostics', async () => {
  const f = await service();
  await f.create();
  f.storage.close();
  const reply = await get(f.port, `/api/maps/${f.mapId}/view`, sameOrigin);
  expect(reply.status).toBe(503);
  expect(reply.json()).toEqual({ error: 'storage_unavailable' });
  expect((await get(f.port, '/api/maps', sameOrigin)).status).toBe(503);
  expect((await get(f.port, `/maps/${f.mapId}`)).status).toBe(200);
});
