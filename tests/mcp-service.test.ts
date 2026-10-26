import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { execFileSync, fork } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHttpTestClient } from './helpers/mcp-http-client.mjs';
import { versioned } from './helpers/write-version.js';
import { canaryVersion, replyRule, ticketRule, writeCanaryCheckout } from './helpers/canary-release.mjs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { MAX_REQUEST_BYTES, captureConfiguration, serveLocalMcp } from '../src/mcp-http-internal.js';
import type { LocalServiceConfiguration } from '../src/mcp-service.js';
import { startLocalMcpService } from '../src/mcp-service.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import type { SQLiteStorage } from '../src/sqlite-storage.js';
import { mapTools, workflowContract } from '../src/mcp-tools.js';
import type { Revision } from '../src/index.js';
import { rejectionSeed, rejectionCases } from './helpers/mcp-rejection-cases.js';

const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(() => { execFileSync('npm', ['run', 'build'], { stdio: 'pipe' }); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const token = 'isolated-test-token-not-a-live-credential';
const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const author = { actorId: 'operator', clientId: 'http-acceptance' };
const ajv = new Ajv({ strict: false });
const outputs = new Map(mapTools.map(tool => [tool.name, ajv.compile(tool.outputSchema!)]));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function listen(server: HttpServer) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return address.port;
}
async function freePort() {
  const server = createServer(); const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function storageFixture(faults: Parameters<typeof sqliteLifecycleForTests>[0] = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-http-acceptance-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite');
  const lifecycle = sqliteLifecycleForTests(faults); lifecycle.initialize(path);
  const storage = lifecycle.open(path); cleanups.push(() => storage.close());
  return { path, storage };
}
function configuration(databasePath: string, port: number): LocalServiceConfiguration {
  return { databasePath, port, token, ...author, allowedOrigins: ['http://localhost:4321'] };
}
async function fixture(override?: { storage: SQLiteStorage; path: string }) {
  const f = override ?? storageFixture();
  const port = await freePort(); const config = configuration(f.path, port);
  const service = await serveLocalMcp(f.storage, config); cleanups.push(() => service.stop());
  return { ...f, port, config, service };
}
async function connect(port: number, bearer = token) {
  const { client, transport, negotiatedProtocol } = await createHttpTestClient(port, bearer);
  cleanups.push(() => client.close());
  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const result = await client.callTool({ name, arguments: versioned(name, args) }) as CallToolResult;
    expect(result.content).toEqual([]);
    expect(outputs.get(name)!(result.structuredContent)).toBe(true);
    return result;
  }
  return { client, transport, call, negotiatedProtocol,
    create: (mapId = 'Acceptance.Alpha') => call('map_create', { mapId, title: 'Isolated acceptance', destination: 'HTTP proof' }),
    apply: (commands: unknown[], expectedRevision: number) => call('map_apply', { mapId: 'Acceptance.Alpha', commands, expectedRevision, includeSnapshot: true }),
    read: (revision?: number, mapId = 'Acceptance.Alpha') => call('map_read', { mapId, ...(revision === undefined ? {} : { revision }) }),
  };
}
// Native HTTP helper deliberately does not retry failed POSTs.
function raw(port: number, body: string | Buffer = '', headers: Record<string, string> = {}, method = 'POST', path = '/mcp') {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers,
    } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', data => text += data);
      response.on('end', () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
const message = (name = 'map_list', args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name, arguments: versioned(name, args) } });
const sessionHeaders = (sessionId: string) => ({ 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25' });
const update = [{ kind: 'map.update', patch: { notes: 'HTTP advanced' } }];
type Connection = Awaited<ReturnType<typeof connect>>;
async function seed(c: Connection) {
  await c.create(); await c.create('Acceptance.Other');
  await c.apply([
    { kind: 'ticket.create', ticket: { id: 'Retained', title: 'Claim retained', question: 'Continue?', type: 'task' } },
    { kind: 'ticket.create', ticket: { id: 'Settled', title: 'Accepted result', question: 'Done?', type: 'task' } },
    { kind: 'claim.acquire', ticketId: 'Retained', claimantId: 'work:continued' },
    { kind: 'claim.acquire', ticketId: 'Settled', claimantId: 'work:continued' },
  ], 1);
  await c.apply([{ kind: 'ticket.settle', ticketId: 'Settled', ticketType: 'task', claimantId: 'work:continued', settlement: {
    outcome: { kind: 'completion', statement: 'Accepted HTTP result', resultingFacts: { durable: true } },
    evidence: [], references: [], provenance: { method: 'HTTP test', sources: [] }, extensions: {},
  } }], 2);
}
// The viewer link names the serving port, which a restart may change; Map state never does.
function mapState(result: CallToolResult) {
  const { viewerUrl: _link, ...structuredContent } = result.structuredContent ?? {};
  return { ...result, structuredContent };
}
async function observe(c: Connection) {
  return { catalog: await c.call('map_list'), maps: await Promise.all(['Acceptance.Alpha', 'Acceptance.Other'].map(async mapId => ({
    current: mapState(await c.read(undefined, mapId)), history: await Promise.all([1, 2, 3, 4, 5].map(async n => mapState(await c.read(n, mapId)))),
  }))) };
}

test.each(['grilling', 'prototype', 'research', 'task'] as const)('A01/D03–D05/P01–P05: complete HTTP %s workflow, independent catalog continuation, conflict and history', async type => {
  const f = await fixture(); const a = await connect(f.port);
  const revision = (result: CallToolResult) => result.structuredContent!.revision as unknown as Revision;
  expect((await a.create()).structuredContent).toMatchObject({ kind: 'committed', revision: 1 });
  await a.create('Acceptance.Other');
  const planned = await a.apply([
    { kind: 'ticket.create', ticket: { id: 'A', title: 'Prerequisite', question: 'Ready?', type } },
    { kind: 'ticket.create', ticket: { id: 'B', title: 'Dependent', question: 'Done?', type: 'task' } },
    { kind: 'dependency.add', dependentId: 'B', prerequisiteId: 'A' },
    { kind: 'content.add', section: 'fog', item: { id: 'F', text: 'Uncertainty', references: [] } },
    { kind: 'content.add', section: 'scopeExclusions', item: { id: 'S', text: 'Excluded', references: [] } },
  ], 1);
  expect(planned.structuredContent!.frontier).toEqual(['A']);
  const claimed = await a.apply([{ kind: 'claim.acquire', ticketId: 'A', claimantId: 'session:A' }], 2);
  const settlement = (outcome: Record<string, unknown>) => ({ outcome, evidence: [],
    references: [{ locator: 'fixture:observed', label: 'Isolated acceptance fixture' }],
    provenance: { method: 'Automated HTTP fixture', sources: [] }, extensions: {} });
  const outcome = type === 'grilling' || type === 'prototype' ? { kind: 'decision', statement: 'Accepted fixture', rationale: 'Fixture verdict' }
    : type === 'research' ? { kind: 'finding', statement: 'Observed fixture', limitations: '' }
      : { kind: 'completion', statement: 'Finished fixture', resultingFacts: { verified: true } };
  const accepted = await a.apply([{ kind: 'ticket.settle', ticketId: 'A', ticketType: type, claimantId: 'session:A', settlement: settlement(outcome) }], 3);
  expect(accepted.structuredContent!.frontier).toEqual(['B']);
  expect(revision(accepted).state.tickets[0]).toMatchObject({ status: 'settled', claim: null, settlement: { outcome, introducedAtRevision: 4 } });
  await a.apply([{ kind: 'claim.acquire', ticketId: 'B', claimantId: 'session:A' }], 4);
  await a.apply([{ kind: 'ticket.settle', ticketId: 'B', ticketType: 'task', claimantId: 'session:A',
    settlement: settlement({ kind: 'completion', statement: 'Dependent finished' }) }], 5);
  const settled = await a.read();
  const unchanged = await observe(a);
  const beforeReopenHistory = await Promise.all(Array.from({ length: 6 }, (_, i) => a.read(i + 1)));
  expect((await a.apply([{ kind: 'ticket.reopen', ticketId: 'A', reason: 'Incomplete reopen' }], 6)).isError).toBeUndefined();
  expect(await observe(a)).toEqual(unchanged);
  expect(await Promise.all(Array.from({ length: 6 }, (_, i) => a.read(i + 1)))).toEqual(beforeReopenHistory);
  expect((await a.read(7)).structuredContent).toMatchObject({ code: 'revision_not_found' });
  const reopened = await a.apply([{ kind: 'ticket.reopen', ticketId: 'A', reason: 'Revisit prerequisite' },
    { kind: 'ticket.reopen', ticketId: 'B', reason: 'Revisit dependent' }], 6);
  expect(reopened.structuredContent!.frontier).toEqual(['A']);
  expect(revision(reopened).state.tickets).toMatchObject([{ status: 'open', claim: null }, { status: 'open', claim: null, prerequisites: ['A'] }]);
  for (const ticket of revision(reopened).state.tickets) expect(ticket).not.toHaveProperty('settlement');
  await a.apply([{ kind: 'claim.acquire', ticketId: 'A', claimantId: 'session:A' }], 7);
  const b = await connect(f.port);
  expect((await b.call('map_list')).structuredContent).toMatchObject({ maps: [{ mapId: 'Acceptance.Alpha', currentRevision: 8 }, { mapId: 'Acceptance.Other', currentRevision: 1 }] });
  expect(revision(await b.read()).revision).toBe(8);
  await b.apply([{ kind: 'ticket.create', ticket: { id: 'C', title: 'Independent continuation', question: 'Done?', type: 'task' } },
    { kind: 'claim.acquire', ticketId: 'C', claimantId: 'session:B' }], 8);
  const beforeConflict = await observe(b);
  const knownHistory = await Promise.all(Array.from({ length: 9 }, (_, i) => b.read(i + 1)));
  const conflict = await a.apply(update, 8);
  expect(conflict.isError).toBeUndefined();
  expect(conflict.structuredContent).toEqual({ kind: 'conflict', conflict: { mapId: 'Acceptance.Alpha', expectedRevision: 8, currentRevision: 9 } });
  expect(await observe(b)).toEqual(beforeConflict);
  expect(await Promise.all(Array.from({ length: 9 }, (_, i) => b.read(i + 1)))).toEqual(knownHistory);
  expect((await b.read(10)).structuredContent).toMatchObject({ code: 'revision_not_found' });
  expect(revision(await a.read()).revision).toBe(9);
  await a.client.close(); await b.client.close();
  const reconnected = await connect(f.port);
  expect(revision(await reconnected.read()).state.tickets).toMatchObject([{ claim: 'session:A' }, { claim: null }, { claim: 'session:B' }]);
  expect(revision(await reconnected.read(3))).toEqual(revision(claimed));
  expect(revision(await reconnected.read(4))).toEqual(revision(accepted));
  expect(await reconnected.read(6)).toEqual(settled);
});

test('D05/P05: complete command-error and reachable final-invariant matrix over real HTTP preserves known fixture history', async () => {
  const f = await fixture(); const c = await connect(f.port);
  await c.create(); await c.create('Acceptance.Other');
  expect((await c.apply(rejectionSeed, 1)).structuredContent!.kind).toBe('committed');
  const before = await observe(c);
  for (const scenario of rejectionCases) {
    expect((await c.apply(scenario.commands, 2)).structuredContent, scenario.label).toEqual({ kind: 'rejected', rejection: scenario.rejection });
    expect(await observe(c), scenario.label).toEqual(before);
  }
});

test('P07/P09: token, exact Host and explicit local Origin guard every method; config is captured and author is server-only', async () => {
  const f = await fixture(); const c = await connect(f.port); await seed(c); const before = await observe(c);
  const headers = sessionHeaders(c.transport.sessionId!);
  for (const method of ['POST', 'GET', 'DELETE']) {
    for (const [extra, status] of [
      [{ Authorization: '' }, 401], [{ Authorization: 'Bearer incorrect-private-secret' }, 401],
      [{ Host: 'evil.example' }, 403], [{ Host: `localhost:${f.port}` }, 403],
      [{ Origin: 'https://evil.example' }, 403], [{ Origin: 'null' }, 403],
      [{ Origin: 'http://127.0.0.1:4321' }, 403],
    ] as const) {
      const reply = await raw(f.port, method === 'POST' ? message() : '', { ...headers, ...extra }, method);
      expect(reply.status).toBe(status); expect(reply.body).not.toContain(token); expect(reply.body).not.toContain('incorrect-private-secret');
    }
  }
  expect((await raw(f.port, message(), headers)).status).toBe(200); // Authenticated absent Origin.
  expect((await raw(f.port, message(), { ...headers, Origin: 'http://localhost:4321' })).status).toBe(200);
  expect((await raw(f.port, message(), { ...headers, Origin: 'http://localhost:4321/' })).status).toBe(403);
  expect((await raw(f.port, '', headers, 'GET')).status).toBe(405);
  expect((await raw(f.port, message(), headers, 'POST', '/mcp?token=private')).status).toBe(404);
  for (const fields of [{ author: { ...author, occurredAt: 'forged' } }, { occurredAt: 'forged' }, { currentRevision: 999 }, { databasePath: f.path }]) {
    expect((await c.call('map_create', { mapId: 'Forged', title: 'Never', destination: 'Never', ...fields })).isError).toBeUndefined();
  }
  (f.config as { token: string }).token = 'mutated-secret';
  (f.config.allowedOrigins as string[]).push('http://localhost:9999');
  expect((await raw(f.port, message(), headers)).status).toBe(200);
  expect((await raw(f.port, message(), { ...headers, Origin: 'http://localhost:9999' })).status).toBe(403);
  expect(await observe(c)).toEqual(before);
  expect(c.client.getServerVersion()).toEqual({ name: 'wayfinder-map', version });
  expect(c.negotiatedProtocol).toBe('2025-11-25');
  expect((await c.read()).structuredContent).toMatchObject({ revision: { author } });
});

test('P07: an operator credentials file admits further tokens, each authoring as its own Client ID; sessions stay bound and edits apply per request', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-credentials-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const credentialsPath = join(directory, 'credentials.json');
  const agentToken = 'agent-credential-token-not-a-live-secret-01';
  const otherToken = 'other-credential-token-not-a-live-secret-02';
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const write = (content: unknown) => writeFileSync(credentialsPath, typeof content === 'string' ? content : JSON.stringify(content));
  write({ credentials: [{ clientId: 'Codex:gpt-6-astra:xhigh', tokenSha256: sha(agentToken) }] });
  const f = storageFixture(); const port = await freePort();
  const service = await serveLocalMcp(f.storage, { ...configuration(f.path, port), credentialsPath }); cleanups.push(() => service.stop());
  const agent = await connect(port, agentToken); await agent.create();
  expect((await agent.read()).structuredContent).toMatchObject({ revision: { author: { actorId: 'operator', clientId: 'Codex:gpt-6-astra:xhigh' } } });
  const operator = await connect(port); await operator.apply(update, 1);
  expect((await operator.read()).structuredContent).toMatchObject({ revision: { revision: 2, author } });
  const agentSession = sessionHeaders(agent.transport.sessionId!);
  expect((await raw(port, message(), { ...agentSession, Authorization: `Bearer ${token}` })).status).toBe(403);
  expect((await raw(port, message(), { ...agentSession, Authorization: `Bearer ${otherToken}` })).status).toBe(401);
  expect((await raw(port, message(), { ...agentSession, Authorization: `Bearer ${agentToken}` })).status).toBe(200);
  write({ credentials: [] });
  expect((await raw(port, message(), { ...agentSession, Authorization: `Bearer ${agentToken}` })).status).toBe(401);
  for (const content of ['not json', { credentials: [{ clientId: 'Bad Id', tokenSha256: sha(agentToken) }] },
    { credentials: [{ clientId: 'Codex', tokenSha256: sha(agentToken), extra: true }] }, { credentials: {} }]) {
    write(content);
    expect((await raw(port, message(), { Authorization: `Bearer ${agentToken}` })).status).toBe(401);
  }
  rmSync(credentialsPath);
  expect((await raw(port, message(), { Authorization: `Bearer ${agentToken}` })).status).toBe(401);
  expect((await raw(port, message(), sessionHeaders(operator.transport.sessionId!))).status).toBe(200);
  expect(() => captureConfiguration({ ...configuration(f.path, port), credentialsPath: 'relative.json' })).toThrow();
});

test('U02: a credential marked toolsOnly gets write tools that state the release; others keep taking it from their instructions', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-tools-only-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const credentialsPath = join(directory, 'credentials.json');
  const chatgptToken = 'chatgpt-credential-token-not-a-live-secret';
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  writeFileSync(credentialsPath, JSON.stringify({ credentials: [{ clientId: 'ChatGPT', tokenSha256: sha(chatgptToken), toolsOnly: true }] }));
  const f = storageFixture(); const port = await freePort();
  const service = await serveLocalMcp(f.storage, { ...configuration(f.path, port), credentialsPath }); cleanups.push(() => service.stop());
  const versionHelp = async (c: Awaited<ReturnType<typeof connect>>) => Object.fromEntries((await c.client.listTools()).tools
    .filter(tool => tool.name === 'map_create' || tool.name === 'map_apply')
    .map(tool => [tool.name, (tool.inputSchema.properties!.version as { description: string }).description]));
  const chatgpt = await connect(port, chatgptToken);
  for (const help of Object.values(await versionHelp(chatgpt))) expect(help).toContain(`set it to "${version}"`);
  const operator = await connect(port);
  for (const help of Object.values(await versionHelp(operator))) expect(help).not.toContain(version);
  // The gate is the same for both: a stated release is still checked against the running one.
  expect((await chatgpt.client.callTool({ name: 'map_create', arguments: { version: '1', mapId: 'Compat', title: 'T', destination: 'D' } }))
    .structuredContent).toMatchObject({ kind: 'rejected', code: 'version_mismatch', version: '1' });
  expect((await chatgpt.client.callTool({ name: 'map_create', arguments: { version, mapId: 'Compat', title: 'T', destination: 'D' } }))
    .structuredContent).toMatchObject({ kind: 'committed', revision: 1 });
  writeFileSync(credentialsPath, JSON.stringify({ credentials: [{ clientId: 'ChatGPT', tokenSha256: sha(chatgptToken), toolsOnly: 'yes' }] }));
  expect((await raw(port, message(), { Authorization: `Bearer ${chatgptToken}` })).status).toBe(401);
  expect(() => captureConfiguration({ ...configuration(f.path, port), toolsOnly: 'yes' as never })).toThrow();
});

test('P06: whole UTF-8 request 1 MiB inclusive, Content-Length and chunked excess refused with no publication', async () => {
  const f = await fixture(); const c = await connect(f.port); await seed(c); const before = await observe(c);
  const headers = sessionHeaders(c.transport.sessionId!);
  const source = message('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 3, commands: update });
  for (const chunked of [false, true]) {
    const excess = source + ' '.repeat(MAX_REQUEST_BYTES + 1 - Buffer.byteLength(source));
    const reply = await raw(f.port, excess, { ...headers, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(Buffer.byteLength(excess)) }) }).catch(error => { throw new Error(`Excess request chunked=${chunked}`, { cause: error }); });
    expect(reply.status).toBe(413); expect(reply.body).toContain('Request too large'); expect(await observe(c)).toEqual(before);
  }
  const utf8 = message('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 3, commands: [{ kind: 'map.update', patch: { notes: '边界' } }] });
  const listing = message(); const padded = listing + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(listing));
  expect((await raw(f.port, padded, { ...headers, 'Content-Length': String(MAX_REQUEST_BYTES) })).status).toBe(200);
  expect(await observe(c)).toEqual(before);
  const boundary = utf8 + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(utf8));
  expect(Buffer.byteLength(boundary)).toBe(MAX_REQUEST_BYTES);
  const accepted = await raw(f.port, boundary, { ...headers, 'Transfer-Encoding': 'chunked' });
  expect(accepted.status).toBe(200); expect(JSON.parse(accepted.body).result.structuredContent).toMatchObject({ kind: 'committed', revision: 4 });
  expect((await c.read()).structuredContent).toMatchObject({ revision: { revision: 4, state: { notes: '边界' } } });
  expect((await c.read(5)).structuredContent).toMatchObject({ code: 'revision_not_found' });
  expect((await raw(f.port, ' '.repeat(MAX_REQUEST_BYTES + 1), { ...headers, 'Transfer-Encoding': 'chunked' }, 'DELETE')).status).toBe(413);
  expect((await c.client.listTools()).tools).toEqual(mapTools); // Refused DELETE did not tear down session.
});

test('W03: real Streamable HTTP initialization carries immutable workflow instructions, Resources and Prompt', async () => {
  const f = await fixture(); const c = await connect(f.port);
  expect(c.client.getInstructions()).toBe(workflowContract.instructions);
  expect(c.client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
  expect((await c.client.listResources()).resources.map(resource => resource.uri)).toEqual([
    'wayfinder://workflow/exploration', `wayfinder://workflow/exploration/${version}`,
  ]);
  expect((await c.client.readResource({ uri: 'wayfinder://workflow/exploration' })).contents[0]).toMatchObject({
    text: `version: ${version}\n\n${workflowContract.markdown}`, _meta: { 'wayfinder/version': version },
  });
  expect((await c.client.getPrompt({ name: 'start_wayfinder_exploration', arguments: { mode: 'resume', mapId: 'Stable.Map' } }))
    .messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: expect.stringContaining(`version: ${version}.`) } });
  expect((await c.call('map_list')).structuredContent).toEqual({ kind: 'listed', maps: [], nextAfterMapId: null });
});

test('P06: HTTP apply 100 inclusive/excess 101, no split/no replay; pure M1 remains covered unrestricted', async () => {
  const f = await fixture(); const c = await connect(f.port); await seed(c); const before = await observe(c);
  const commands = Array.from({ length: 101 }, (_, i) => ({ kind: 'ticket.create', ticket: { id: `Boundary.${i}`, title: 'Ticket', question: 'Done?', type: 'task' } }));
  expect((await c.apply(commands, 3)).structuredContent).toMatchObject({ kind: 'rejected', rejection: { stage: 'input', error: { path: ['commands'] } } });
  expect(await observe(c)).toEqual(before);
  expect((await c.apply(commands.slice(0, 100), 3)).structuredContent).toMatchObject({ kind: 'committed', revision: { revision: 4, changes: expect.any(Array) } });
  expect((await c.read()).structuredContent).toMatchObject({ revision: { revision: 4, state: { tickets: expect.any(Array) } } });
  expect(((await c.read()).structuredContent!.revision as { state: { tickets: unknown[] } }).state.tickets).toHaveLength(102);
  expect((await c.read(5)).structuredContent).toMatchObject({ code: 'revision_not_found' });
});

test('P06/P08: four global active calls, fifth explicitly refused; graceful stop drains real work without releasing disconnected work', async () => {
  const f = storageFixture(); const entered = deferred(); const release = deferred(); let held = 0; let closed = false;
  const storage: SQLiteStorage = { ...f.storage, adapter: { ...f.storage.adapter,
    async commit(change) { if (++held === 4) entered.resolve(); await release.promise; return f.storage.adapter.commit(change); },
  }, close() { closed = true; f.storage.close(); } };
  const host = await fixture({ storage, path: f.path }); const a = await connect(host.port); const b = await connect(host.port);
  const calls = [a, b, a, b].map((connection, i) => connection.create(`Concurrent.${i}`));
  const outcomes = Promise.allSettled(calls); // Attach before intentionally closing a client.
  await entered.promise;
  const refusal = await b.create('Refused');
  expect(refusal.isError).toBe(true); expect(refusal.structuredContent).toEqual({ kind: 'infrastructure_error', code: 'service_busy', outcome: 'not_published', requiresRestart: false });
  expect(held).toBe(4); expect(closed).toBe(false);
  // Closing a conversation must not cancel its admitted mutations or release slots.
  await a.client.close();
  expect((await b.call('map_list')).structuredContent).toMatchObject({ code: 'service_busy' });
  let stopped = false; const stopping = host.service.stop().then(() => { stopped = true; });
  expect((await raw(host.port, message(), sessionHeaders(b.transport.sessionId!))).status).toBe(503);
  expect(stopped).toBe(false); expect(closed).toBe(false); expect(held).toBe(4);
  release.resolve();
  await outcomes; await stopping;
  expect(closed).toBe(true); expect(stopped).toBe(true);
  const observations = readFileSync(`${f.path}.calls.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(observations.filter(record => record.tool === 'map_create').map(record => record.result).sort())
    .toEqual(['committed', 'committed', 'committed', 'committed', 'service-failure']);
  expect(host.service.metadataStatus().missingObservations).toBe(0);
  const reopened = sqliteLifecycleForTests().open(f.path); cleanups.push(() => reopened.close());
  expect(reopened.listMaps()).toMatchObject({ maps: [0, 1, 2, 3].map(i => ({ mapId: `Concurrent.${i}`, currentRevision: 1 })) });
  expect(reopened.listMaps()).toMatchObject({ nextAfterMapId: null });
});

test('P08/P09: invalid configuration and unavailable storage visibly fail safely; fixed occupied port is not substituted', async () => {
  const f = storageFixture(); const port = await freePort(); const good = configuration(f.path, port);
  for (const patch of [
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '4321' }, { token: '' }, { token: 'short' }, { token: 'a'.repeat(32) + '\n' },
    { actorId: '' }, { actorId: ' actor ' }, { clientId: '' }, { databasePath: undefined },
    { allowedOrigins: ['https://evil.example'] }, { allowedOrigins: ['http://localhost:4321/path'] }, { allowedOrigins: ['null'] },
    { allowedOrigins: ['http://user:pass@localhost:4321'] }, { allowedOrigins: 'http://localhost:4321' }, { owner: 'forged' },
  ]) {
    await expect(startLocalMcpService({ ...good, ...patch } as LocalServiceConfiguration)).rejects.toMatchObject({ code: 'invalid_configuration' });
  }
  const absent = join(f.path, 'missing.sqlite');
  await expect(startLocalMcpService({ ...good, databasePath: absent })).rejects.toMatchObject({ code: 'storage_not_ready', message: 'Local MCP storage_not_ready' });
  expect(existsSync(absent)).toBe(false);
  const occupied = createServer(); const occupiedPort = await listen(occupied);
  cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  await expect(serveLocalMcp(f.storage, configuration(f.path, occupiedPort))).rejects.toMatchObject({ code: 'port_unavailable' });
  expect(occupied.address()).toMatchObject({ address: '127.0.0.1', port: occupiedPort });
  expect(f.storage.listMaps()).toMatchObject({ maps: [] });
  expect(captureConfiguration({ ...good, allowedOrigins: ['http://127.0.0.1:4321', 'https://localhost'] }).port).toBe(port);
});

test('P08/D10: real HTTP session DELETE/close leaves service and Claims alive; graceful stop/restart retains exact catalog/head/history', async () => {
  const f = await fixture(); const a = await connect(f.port); await seed(a); const before = await observe(a);
  expect(a.client.getInstructions()).toBe(workflowContract.instructions);
  expect(await a.client.listTools()).toEqual({ tools: mapTools });
  const sessionId = a.transport.sessionId!;
  await a.transport.terminateSession(); await a.client.close();
  expect((await raw(f.port, message(), sessionHeaders(sessionId))).status).toBe(404);
  const b = await connect(f.port); expect(b.client.getInstructions()).toBe(workflowContract.instructions); expect(await observe(b)).toEqual(before);
  await b.client.close(); await f.service.stop();
  const storage = sqliteLifecycleForTests().open(f.path); cleanups.push(() => storage.close());
  const service = await serveLocalMcp(storage, configuration(f.path, f.port)); cleanups.push(() => service.stop());
  const next = await connect(f.port); expect(next.client.getInstructions()).toBe(workflowContract.instructions); expect(await observe(next)).toEqual(before);
  expect((await next.read(2)).structuredContent).toMatchObject({ revision: { state: { tickets: expect.arrayContaining([expect.objectContaining({ id: 'Retained', claim: 'work:continued' })]) } } });
  expect((await next.read(3)).structuredContent).toMatchObject({ revision: { state: { tickets: expect.arrayContaining([expect.objectContaining({ id: 'Settled', settlement: expect.objectContaining({ introducedAtRevision: 3 }) })]) } } });
});

test('P09/D07/D12: HTTP busy is non-publication, failed cleanup stops all storage calls until restart, no fallback/leaks', async () => {
  let failing = false;
  const f = storageFixture({ beforePublication() { if (failing) throw new Error(`${token} private/SQL/decision/evidence`); },
    beforeRollback() { if (failing) throw new Error(`${token} cleanup`); } });
  const host = await fixture(f); const c = await connect(host.port); await seed(c); const before = await observe(c);
  const lock = new DatabaseSync(f.path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    expect((await c.apply(update, 3)).structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_busy', outcome: 'not_published', requiresRestart: false });
    lock.exec('ROLLBACK');
  } finally { lock.close(); }
  expect(await observe(c)).toEqual(before);
  failing = true;
  const failed = await c.apply(update, 3);
  expect(failed.structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_failure', outcome: 'not_published', requiresRestart: true });
  expect(JSON.stringify(failed)).not.toContain(token); expect(JSON.stringify(failed)).not.toContain('private/SQL/decision/evidence');
  for (const [name, args] of [['map_read', { mapId: 'Acceptance.Alpha' }], ['map_list', {}], ['map_create', { mapId: 'NoFallback', title: 'Never', destination: 'Never' }], ['map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 3, commands: update }]] as const) {
    expect((await c.call(name, args)).structuredContent).toEqual({ kind: 'infrastructure_error', code: 'storage_failure', outcome: 'unknown', requiresRestart: true });
  }
  await c.client.close(); await host.service.stop();
  const storage = sqliteLifecycleForTests().open(f.path); cleanups.push(() => storage.close());
  const resumed = await fixture({ storage, path: f.path }); const next = await connect(resumed.port);
  expect(await observe(next)).toEqual(before); // All earlier history, absent proposed next, unrelated Map and catalog.
  expect((await next.apply(update, 3)).structuredContent).toMatchObject({ kind: 'committed', revision: { revision: 4 } });
});

test('P09: malformed protocol/unknown tools expose no SDK diagnostic contents; no mutation or substitute authority', async () => {
  const f = await fixture(); const c = await connect(f.port); await seed(c); const before = await observe(c);
  const headers = sessionHeaders(c.transport.sessionId!);
  for (const body of ['not-json-private-decision', '[]', 'null', message('private-unknown-tool'), JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: { private: token } } })]) {
    const reply = await raw(f.port, body, headers);
    const result = JSON.parse(reply.body);
    expect(result.error).toBeDefined(); expect(result.result).toBeUndefined();
    expect(reply.body).not.toContain(token); expect(reply.body).not.toContain('private-unknown-tool'); expect(reply.body).not.toContain('not-json-private-decision');
    expect(await observe(c)).toEqual(before);
  }
  const invalidUtf8 = await raw(f.port, Buffer.from([0x7b, 0xff, 0x7d]), headers);
  expect(invalidUtf8.status).toBe(400); expect(JSON.parse(invalidUtf8.body).error.code).toBe(-32700);
  const unsupported = await raw(f.port, message(), { ...headers, 'mcp-protocol-version': 'private-protocol-fixture' });
  expect(unsupported.status).toBe(400); expect(unsupported.body).not.toContain('private-protocol-fixture');
  expect(await observe(c)).toEqual(before);
  await c.client.close(); await f.service.stop();
  await expect(raw(f.port, message(), headers)).rejects.toThrow();
});

test('D11: HTTP receipt lost after durable COMMIT with service still alive; explicit reread, no automatic replay', async () => {
  const f = storageFixture(); let armed = false; const committed = deferred(); const release = deferred(); const completed = deferred();
  const wrapped: SQLiteStorage = { ...f.storage, adapter: { ...f.storage.adapter,
    async commit(change) {
      const result = await f.storage.adapter.commit(change);
      if (armed) { committed.resolve(); await release.promise; completed.resolve(); }
      return result;
    },
  } };
  const host = await fixture({ storage: wrapped, path: f.path }); const c = await connect(host.port); await seed(c); const before = await observe(c);
  const observationStart = host.service.metadataStatus().observations;
  armed = true;
  const abort = new AbortController();
  const lost = fetch(`http://127.0.0.1:${host.port}/mcp`, { method: 'POST', signal: abort.signal, headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...sessionHeaders(c.transport.sessionId!),
  }, body: message('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 3, commands: update }) }).then(() => 'unexpected receipt', () => 'unknown');
  await committed.promise; abort.abort(); expect(await lost).toBe('unknown'); release.resolve(); await completed.promise;
  const recovered = await observe(c);
  const observations = readFileSync(`${f.path}.calls.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(observations.filter(record => record.sequence > observationStart && record.tool === 'map_apply'))
    .toMatchObject([{ result: 'committed', mcpSessionId: c.transport.sessionId, mapId: 'Acceptance.Alpha' }]);
  expect(recovered.maps[1]).toEqual(before.maps[1]);
  expect(recovered.maps[0]!.history.slice(0, 3)).toEqual(before.maps[0]!.history.slice(0, 3));
  expect(recovered.maps[0]!.history[4]).toEqual(before.maps[0]!.history[4]);
  expect(recovered.maps[0]!.current.structuredContent).toMatchObject({ revision: { revision: 4, priorRevision: 3, state: { notes: 'HTTP advanced' } } });
  expect(recovered.maps[0]!.history[3]!.structuredContent).toEqual(recovered.maps[0]!.current.structuredContent);
  expect((await c.client.listTools()).tools).toEqual(mapTools); // Same service, still available.
  armed = false;
  expect((await c.apply(update, 3)).structuredContent).toMatchObject({ kind: 'conflict', conflict: { expectedRevision: 3, currentRevision: 4 } });
  expect(await observe(c)).toEqual(recovered);
});

test('P08: session DELETE drains multiple admitted requests without reopening admission after first completion', async () => {
  const f = storageFixture(); const entered = deferred(); const releases = [deferred(), deferred()]; let armed = false; let held = 0;
  const wrapped: SQLiteStorage = { ...f.storage, adapter: { ...f.storage.adapter,
    async commit(change) {
      if (armed) {
        const release = releases[change.next.id === 'Delete.First' ? 0 : 1]!;
        if (++held === 2) entered.resolve();
        await release.promise;
      }
      return f.storage.adapter.commit(change);
    },
  } };
  const host = await fixture({ storage: wrapped, path: f.path }); const c = await connect(host.port); await seed(c);
  armed = true;
  const first = c.create('Delete.First'); const second = c.create('Delete.Second'); await entered.promise;
  let deleted = false;
  const deleting = raw(host.port, '', sessionHeaders(c.transport.sessionId!), 'DELETE').then(result => { deleted = true; return result; });
  // Observe the actual server barrier, not a sleep or assumed socket ordering.
  let closing: Awaited<ReturnType<typeof raw>> | undefined;
  for (let i = 0; i < 100; i++) {
    const probe = await raw(host.port, message(), sessionHeaders(c.transport.sessionId!));
    if (probe.status === 404) { closing = probe; break; }
    expect(probe.status).toBe(200);
  }
  expect(closing?.body).toContain('Session closing');
  // A separate session remains usable while DELETE drains the original session.
  const other = await connect(host.port); expect((await other.call('map_list')).structuredContent!.kind).toBe('listed');
  expect(deleted).toBe(false); releases[0]!.resolve();
  expect((await first).structuredContent).toMatchObject({ kind: 'committed', mapId: 'Delete.First', revision: 1 });
  expect((await raw(host.port, message(), sessionHeaders(c.transport.sessionId!))).status).toBe(404);
  expect(deleted).toBe(false); expect(held).toBe(2); releases[1]!.resolve();
  expect((await second).structuredContent).toMatchObject({ kind: 'committed', mapId: 'Delete.Second', revision: 1 });
  expect((await deleting).status).toBe(200);
  expect((await other.read()).structuredContent).toMatchObject({ revision: { revision: 3, state: { tickets: expect.arrayContaining([expect.objectContaining({ id: 'Retained', claim: 'work:continued' })]) } } });
  expect((await other.call('map_list')).structuredContent).toMatchObject({ maps: [
    expect.objectContaining({ mapId: 'Acceptance.Alpha', currentRevision: 3 }), expect.objectContaining({ mapId: 'Acceptance.Other', currentRevision: 1 }),
    expect.objectContaining({ mapId: 'Delete.First', currentRevision: 1 }), expect.objectContaining({ mapId: 'Delete.Second', currentRevision: 1 }),
  ] });
});

function childHost(path: string, port: number, mode: string, hostPath = fileURLToPath(new URL('./helpers/mcp-http-host.mjs', import.meta.url))) {
  const child = fork(hostPath, [path, String(port), mode], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: unknown[] = []; const waiting: ((message: unknown) => void)[] = [];
  child.on('message', value => { const resolve = waiting.shift(); if (resolve) resolve(value); else messages.push(value); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let logs = ''; child.stdout!.on('data', data => logs += data); child.stderr!.on('data', data => logs += data);
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } });
  return { child, exit, logs: () => logs, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => waiting.push(resolve)) };
}

test.each(['idle', 'before', 'after'] as const)('D10/D11/P09: real HTTP child SIGKILL at %s boundary retains atomic durable outcome, receipt never implies no change', async mode => {
  const f = storageFixture(); f.storage.close(); const port = await freePort(); const host = childHost(f.path, port, mode);
  expect(await host.next()).toEqual({ kind: 'ready' });
  const c = await connect(port); await seed(c); const before = await observe(c);
  let lost: Promise<unknown> | undefined;
  if (mode !== 'idle') {
    host.child.send('arm'); expect(await host.next()).toEqual({ kind: 'armed' });
    lost = raw(port, message('map_apply', { mapId: 'Acceptance.Alpha', expectedRevision: 3, commands: update }), sessionHeaders(c.transport.sessionId!)).then(reply => ({ reply }), () => ({ outcome: 'unknown' }));
    expect(await host.next()).toEqual({ kind: 'boundary', boundary: mode });
  }
  host.child.kill('SIGKILL'); expect(await host.exit).toEqual({ code: null, signal: 'SIGKILL' });
  if (lost) expect(await lost).toEqual({ outcome: 'unknown' });
  await c.client.close();
  const reopened = sqliteLifecycleForTests().open(f.path); cleanups.push(() => reopened.close());
  const service = await serveLocalMcp(reopened, configuration(f.path, port)); cleanups.push(() => service.stop());
  const next = await connect(port); const recovered = await observe(next);
  if (mode !== 'after') expect(recovered).toEqual(before);
  else {
    expect(recovered.maps[1]).toEqual(before.maps[1]);
    expect(recovered.maps[0]!.history.slice(0, 3)).toEqual(before.maps[0]!.history.slice(0, 3));
    expect(recovered.maps[0]!.history[4]).toEqual(before.maps[0]!.history[4]);
    const newRevision = (await next.read(4)).structuredContent!.revision as Record<string, unknown>;
    expect(recovered.maps[0]!.current.structuredContent!.revision).toEqual(newRevision);
    expect(newRevision).toMatchObject({ revision: 4, priorRevision: 3, state: { notes: 'HTTP advanced', tickets: expect.arrayContaining([
      expect.objectContaining({ id: 'Retained', claim: 'work:continued' }),
      expect.objectContaining({ id: 'Settled', settlement: expect.objectContaining({ introducedAtRevision: 3 }) }),
    ]) } });
    expect(recovered.catalog.structuredContent).toMatchObject({ maps: [expect.objectContaining({ currentRevision: 4 }), expect.objectContaining({ currentRevision: 1 })] });
  }
  expect(host.logs()).not.toContain(token); expect(host.logs()).not.toContain(f.path); expect(host.logs()).not.toContain('HTTP advanced');
});

test('D10/P08: child SIGTERM stops HTTP admission, completes controlled active commit, then exits and restarts with exact receipt', async () => {
  const f = storageFixture(); f.storage.close(); const port = await freePort(); const host = childHost(f.path, port, 'graceful');
  expect(await host.next()).toEqual({ kind: 'ready' });
  const c = await connect(port); await seed(c); const before = await observe(c);
  host.child.send('arm'); expect(await host.next()).toEqual({ kind: 'armed' });
  const active = c.apply(update, 3); expect(await host.next()).toEqual({ kind: 'boundary', boundary: 'active' });
  host.child.kill('SIGTERM'); expect(await host.next()).toEqual({ kind: 'stopping' });
  expect((await raw(port, message(), sessionHeaders(c.transport.sessionId!))).status).toBe(503);
  expect(host.child.exitCode).toBe(null);
  host.child.send('release'); const receipt = await active;
  expect(receipt.structuredContent).toMatchObject({ kind: 'committed', revision: { revision: 4 } });
  expect(await host.exit).toEqual({ code: 0, signal: null }); await c.client.close();
  const storage = sqliteLifecycleForTests().open(f.path); cleanups.push(() => storage.close());
  const service = await serveLocalMcp(storage, configuration(f.path, port)); cleanups.push(() => service.stop());
  const next = await connect(port); const recovered = await observe(next);
  expect(recovered.maps[1]).toEqual(before.maps[1]);
  expect(recovered.maps[0]!.history.slice(0, 3)).toEqual(before.maps[0]!.history.slice(0, 3));
  expect(recovered.maps[0]!.history[4]).toEqual(before.maps[0]!.history[4]);
  expect((await next.read(4)).structuredContent!.revision).toEqual(receipt.structuredContent!.revision);
  expect((await next.read()).structuredContent!.frontier).toEqual(receipt.structuredContent!.frontier);
  expect((await next.read()).structuredContent!.revision).toEqual(receipt.structuredContent!.revision);
});

test('U01: a restart onto a new release ends old sessions; a reconnected caller gets the new definitions; a stale or resent write is refused unwritten', async () => {
  const f = storageFixture(); f.storage.close(); const port = await freePort();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wayfinder-upgrade-'))); cleanups.push(() => rmSync(root, { recursive: true }));
  const canaryRoot = join(root, 'canary');
  const { before, after } = await writeCanaryCheckout(fileURLToPath(new URL('..', import.meta.url)), canaryRoot);
  mkdirSync(join(canaryRoot, 'tests/helpers'), { recursive: true });
  cpSync(fileURLToPath(new URL('./helpers/mcp-http-host.mjs', import.meta.url)), join(canaryRoot, 'tests/helpers/mcp-http-host.mjs'));

  const current = childHost(f.path, port, 'idle'); expect(await current.next()).toEqual({ kind: 'ready' });
  const c = await connect(port);
  expect(c.client.getServerVersion()).toEqual({ name: 'wayfinder-map', version: before.version });
  expect((await c.create()).structuredContent).toMatchObject({ kind: 'committed', revision: 1 });
  current.child.kill('SIGTERM'); expect(await current.exit).toEqual({ code: 0, signal: null });
  const upgraded = childHost(f.path, port, 'idle', join(canaryRoot, 'tests/helpers/mcp-http-host.mjs'));
  expect(await upgraded.next()).toEqual({ kind: 'ready' });

  // The old session serves neither old nor new definitions; MCP clients answer this 404 with a new initialize.
  const write = (version: string, expectedRevision: number) => ({ name: 'map_apply', arguments: { version, mapId: 'Acceptance.Alpha', expectedRevision, commands: update } });
  expect((await raw(port, message('map_apply', write(before.version, 1).arguments), sessionHeaders(c.transport.sessionId!))).status).toBe(404);
  const d = await connect(port);
  expect(d.client.getServerVersion()).toEqual({ name: 'wayfinder-map', version: canaryVersion });
  expect(d.client.getInstructions()).toBe(after.instructions); expect(d.client.getInstructions()).toContain(replyRule);
  expect((await d.client.listTools()).tools.find(tool => tool.name === 'map_apply')!.description).toContain(ticketRule);
  const rules = (await d.client.readResource({ uri: 'wayfinder://workflow/exploration' })).contents[0] as { text: string };
  expect(rules.text.startsWith(`version: ${canaryVersion}\n\n`)).toBe(true); expect(rules.text).toContain(replyRule); expect(rules.text).toContain(ticketRule);

  // Codex and Claude Code resend the failed call once on the new session, still carrying the old rules' version.
  expect((await d.client.callTool(write(before.version, 1))).structuredContent).toEqual(
    { kind: 'rejected', code: 'version_mismatch', version: before.version, rules: 'wayfinder://workflow/exploration' });
  expect((await d.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Alpha' } })).structuredContent).toMatchObject({ revision: { revision: 1 } });
  // With the new rules read, the write lands once; repeating it is a Conflict, not a second change.
  expect((await d.client.callTool(write(canaryVersion, 1))).structuredContent).toMatchObject({ kind: 'committed', revision: 2 });
  expect((await d.client.callTool(write(canaryVersion, 1))).structuredContent).toEqual(
    { kind: 'conflict', conflict: { mapId: 'Acceptance.Alpha', expectedRevision: 1, currentRevision: 2 } });
  upgraded.child.kill('SIGTERM'); expect(await upgraded.exit).toEqual({ code: 0, signal: null });
});

test('P08/P09: actual operator command startup failures return nonzero with fixed safe logs', async () => {
  const child = fork(fileURLToPath(new URL('../dist/mcp-start.js', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, WAYFINDER_PORT: '0', WAYFINDER_TOKEN: token, WAYFINDER_DATABASE_PATH: '/private-path-fixture/maps.sqlite' },
  });
  let logs = ''; child.stdout!.on('data', data => logs += data); child.stderr!.on('data', data => logs += data);
  const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
  expect(code).toBe(1); expect(logs).toContain('startup failed: invalid_configuration');
  expect(logs).not.toContain(token); expect(logs).not.toContain('/private-path-fixture');
});
