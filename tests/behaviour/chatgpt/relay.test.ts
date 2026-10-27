import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { rpcResponse, startRelay, type Exchange } from './relay.ts';

test('JSON/SSE evidence keeps the terminal response for this RPC, never a notification or unfinished event', () => {
  const result = { jsonrpc: '2.0', id: 7, result: { tools: [] } };
  assert.deepEqual(rpcResponse(JSON.stringify(result), 'application/json', 7), result);
  const prefix = ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n';
  const data = `event: message\r\ndata: ${JSON.stringify(result)}\r\n\r\n`;
  assert.deepEqual(rpcResponse(prefix + data, 'text/event-stream; charset=utf-8', 7), result);
  assert.equal(rpcResponse(data, 'text/event-stream', '7'), null);
  assert.equal(rpcResponse(prefix + data.trimEnd(), 'text/event-stream', 7), null);
  assert.equal(rpcResponse('data: invalid\n\n', 'text/event-stream', 7), null);
  const error = { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Unknown method' } };
  assert.deepEqual(rpcResponse(`data: ${JSON.stringify(error)}\n\n`, 'text/event-stream', 7), error);
});

test('the relay forwards modern sessionless discovery/list/call SSE bytes and records their terminal results', async () => {
  const exchanges: Exchange[] = [];
  const requests: unknown[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString()); requests.push(rpc);
    assert.equal(request.headers['mcp-session-id'], undefined);
    assert.equal(request.headers['mcp-protocol-version'], '2026-07-28');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': keepalive\n\n');
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { method: rpc.method } })}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const relay = await startRelay(address.port, 'fake-token-not-a-live-credential', e => exchanges.push(e), () => {});
  try {
    for (const method of ['server/discover', 'tools/list', 'tools/call']) {
      relay.active = method === 'tools/call';
      const rpc = { jsonrpc: '2.0', id: method, method, params: { name: 'map_list',
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } };
      const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28',
        'mcp-method': method, 'mcp-name': 'map_list', authorization: 'Bearer never-record-this', cookie: 'never-record-cookie',
      }, body: JSON.stringify(rpc) });
      const text = await response.text();
      assert.equal(response.status, 200); assert.equal(response.headers.get('mcp-session-id'), null);
      assert.equal(text, `: keepalive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: method, result: { method } })}\n\n`);
      assert.deepEqual(requests.at(-1), rpc);
      assert.deepEqual(exchanges.at(-1)?.response, { jsonrpc: '2.0', id: method, result: { method } });
      assert.equal(exchanges.at(-1)?.sessionId, null);
      assert.equal(exchanges.at(-1)?.protocolVersionHeader, '2026-07-28');
      assert.deepEqual(Object.keys(exchanges.at(-1)!).sort(), ['at', 'httpMethod', 'id', 'protocolVersionHeader', 'request', 'response', 'sessionId', 'status']);
      assert.equal(JSON.stringify(exchanges).includes('never-record'), false);
    }
    assert.equal(exchanges.length, 3);
  } finally {
    await relay.stop();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
