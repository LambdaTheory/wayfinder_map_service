import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { expect, test } from 'vitest';
import { directAgent, directFetch } from './direct-http.ts';

async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`);
  const agent = directAgent();
  return { url, fetch: directFetch(url, agent), close: async () => {
    agent.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('direct MCP transport preserves POST bytes, metadata and a bodyless DELETE response', async () => {
  const calls: {method:string;body:string;authenticated:boolean}[] = [];
  const f = await endpoint(async (req, res) => {
    const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(Buffer.from(bytes));
    calls.push({method:req.method!,body:Buffer.concat(chunks).toString(),authenticated:req.headers.authorization === 'Bearer synthetic'});
    if (req.method === 'DELETE') res.writeHead(204).end();
    else res.writeHead(200, {'content-type':'application/json','mcp-session-id':'fixture'}).end('{"ok":true}');
  });
  try {
    const response = await f.fetch(f.url, {method:'POST',headers:{authorization:'Bearer synthetic'},body:'{"title":"地图"}'});
    expect(await response.json()).toEqual({ok:true}); expect(response.headers.get('mcp-session-id')).toBe('fixture');
    const removed = await f.fetch(f.url, {method:'DELETE',headers:{authorization:'Bearer synthetic'}});
    expect(removed.status).toBe(204); expect(removed.body).toBeNull();
    expect(calls).toEqual([{method:'POST',body:'{"title":"地图"}',authenticated:true},{method:'DELETE',body:'',authenticated:true}]);
  } finally { await f.close(); }
});

test('direct MCP transport streams GET immediately and abort closes the owned socket', async () => {
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await endpoint((_req, res) => {
    res.on('close', disconnected); res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: {"ok":true}\n\n');
  });
  try {
    const abort = new AbortController();
    const response = await f.fetch(f.url, {signal:abort.signal});
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"ok":true}\n\n');
    abort.abort(); await expect(reader.read()).rejects.toThrow(); await closed;
  } finally { await f.close(); }
});

test('direct MCP transport never follows redirects or sends credentials to another endpoint', async () => {
  let foreignCalls = 0;
  const other = await endpoint((_req, res) => { foreignCalls++; res.end('unexpected'); });
  const f = await endpoint((_req, res) => res.writeHead(307, {location:other.url.href}).end());
  try {
    const response = await f.fetch(f.url, {headers:{authorization:'Bearer synthetic'}});
    expect(response.status).toBe(307); await response.body?.cancel();
    await expect(f.fetch(other.url, {headers:{authorization:'Bearer synthetic'}})).rejects.toThrow('endpoint changed');
    expect(foreignCalls).toBe(0);
  } finally { await f.close(); await other.close(); }
});
