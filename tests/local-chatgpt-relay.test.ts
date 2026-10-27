import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Agent, createServer, request, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { specTypeSchemas } from '@modelcontextprotocol/client';
import { createLocalChatGptRelay } from '../scripts/local-chatgpt-relay.mjs';
import { startLocalMcpService } from '../src/mcp-service.js';
import { initializeSQLite } from '../src/sqlite-storage.js';
import { toolsOnlyMapTools, workflowContract } from '../src/mcp-tools.js';
import { freePort } from './behaviour/runner/service.ts';
import { startRelay } from './behaviour/chatgpt/relay.ts';
import { chatgptDiscovery } from './helpers/chatgpt-discovery.js';
import { createHttpTestClient } from './helpers/mcp-http-client.mjs';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('everyday relay surfaces a mid-session server error without cancelling the in-flight upstream request', async () => {
  let receive!: (response: ServerResponse) => void;
  const pending = new Promise<ServerResponse>(resolve => { receive = resolve; });
  const upstream = createServer((_req, res) => receive(res));
  const listen = async (server: Server) => {
    const port = await freePort();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        // Match the runner: its startup error listener is removed after listen.
        server.removeListener('error', reject);
        resolve();
      });
    });
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    });
    return port;
  };
  const relay = createLocalChatGptRelay(await listen(upstream), 'synthetic-relay-error-token');
  const port = await listen(relay);
  const direct = new Agent({ proxyEnv: {}, keepAlive: false });
  cleanups.push(() => direct.destroy());
  const reply = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: direct }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, body }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });
  const response = await pending;
  const failure = new Error('synthetic relay accept failure');
  // In production this unhandled event crashes the runner, as in 3.2.0.
  // Catch it here so we can also check that no listener destroys the active request.
  let thrown: unknown;
  try { relay.emit('error', failure); } catch (error) { thrown = error; }
  response.end('{"ok":true}');
  const result = await reply;
  expect(thrown).toBe(failure);
  expect(result).toEqual({ status: 200, body: '{"ok":true}' });
});

test.each(['everyday', 'behaviour'] as const)('%s relay preserves modern discovery/list/call and missing-header errors', async kind => {
  const root = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'relay-headers-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'maps.sqlite');
  initializeSQLite(databasePath);
  const servicePort = await freePort();
  const token = 'isolated-relay-test-token-not-a-live-credential';
  const service = await startLocalMcpService({ databasePath, port: servicePort, token,
    actorId: 'test-operator', clientId: 'relay-test', toolsOnly: true });
  cleanups.push(() => service.stop());
  let port: number;
  if (kind === 'everyday') {
    // This is the exact relay used by local-chatgpt-test.mjs, without its tunnel/backup entry point.
    const relay = createLocalChatGptRelay(servicePort, token);
    port = await freePort([servicePort]);
    await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(port, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise<void>(resolve => relay.close(() => resolve())));
  } else {
    const relay = await startRelay(servicePort, token, () => {}, () => {});
    relay.active = true;
    port = relay.port;
    cleanups.push(() => relay.stop());
  }
  const post = (body: unknown, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const discoverHeaders = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' };
  const discovery = await post(chatgptDiscovery, discoverHeaders);
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get('mcp-session-id')).toBeNull();
  expect(specTypeSchemas.DiscoverResult['~standard'].validate((await discovery.json()).result).issues).toBeUndefined();

  const { client } = await createHttpTestClient(port, 'ignored-public-credential', '2026-07-28');
  cleanups.push(() => client.close());
  expect((await client.listTools()).tools).toEqual(toolsOnlyMapTools);
  const create = { version: workflowContract.version, mapId: 'RelayHeaders', title: 'T', destination: 'D' };
  expect((await client.callTool({ name: 'map_create', arguments: create })).structuredContent)
    .toMatchObject({ kind: 'committed', revision: 1 });
  expect((await client.callTool({ name: 'map_read', arguments: { mapId: create.mapId } })).structuredContent)
    .toMatchObject({ kind: 'found' });

  for (const headers of [{}, { 'mcp-protocol-version': '2026-07-28' }, { 'mcp-method': 'server/discover' }]) {
    const response = await post(chatgptDiscovery, headers);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: chatgptDiscovery.id,
      error: { code: -32020, message: 'Protocol request failed' } });
  }
  const missingName = await post({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
    _meta: chatgptDiscovery.params._meta, name: 'map_create', arguments: { ...create, mapId: 'MissingName' },
  } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' });
  expect(missingName.status).toBe(400);
  expect(await missingName.json()).toEqual({ jsonrpc: '2.0', id: 12,
    error: { code: -32020, message: 'Protocol request failed' } });
  expect((await client.callTool({ name: 'map_read', arguments: { mapId: 'MissingName' } })).structuredContent)
    .toMatchObject({ kind: 'not_found', code: 'map_not_found' });
});
