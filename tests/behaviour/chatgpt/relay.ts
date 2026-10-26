// Capture the actual MCP wire exchange. Authentication never comes from the incoming public request.
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { freePort } from '../runner/service.ts';

export interface Exchange { id: string; at: string; request: Record<string, unknown>; response: unknown; status: number; sessionId: string | null }
export interface Relay {
  port: number;
  /** Writes and reads by the client are allowed only inside a labelled turn. Discovery is allowed between turns. */
  active: boolean;
  token: string;
  inFlight: number;
  stop(): Promise<void>;
}
export async function startRelay(servicePort: number, token: string, observe: (e: Exchange) => void): Promise<Relay> {
  if ([18765, 18766].includes(servicePort)) throw new Error('Everyday service ports are forbidden');
  let counter = 0;
  const state: Relay = { port: await freePort(), token, active: false, inFlight: 0, stop: async () => close(server) };
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url !== '/mcp') { outgoing.writeHead(404).end(); return; }
    if (incoming.headers.origin !== undefined) { outgoing.writeHead(403).end(); return; }
    if (!['POST', 'DELETE'].includes(incoming.method ?? '')) { outgoing.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 1_048_576) { outgoing.writeHead(413).end(); return; }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    let rpc: Record<string, unknown> = {};
    try { if (body.length) rpc = JSON.parse(body.toString()) as Record<string, unknown>; }
    catch { outgoing.writeHead(400).end(); return; }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) { outgoing.writeHead(400).end(); return; }
    // Out-of-turn operations cannot mutate or leak Scenario state into another chat.
    if (!state.active && !['initialize', 'notifications/initialized', 'tools/list', undefined].includes(rpc.method as string | undefined)) {
      outgoing.writeHead(503).end(); return;
    }
    const id = `rpc-${++counter}`;
    const at = new Date().toISOString();
    const headers: Record<string, string | string[]> = { host: `127.0.0.1:${servicePort}`, authorization: `Bearer ${state.token}` };
    for (const key of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version']) {
      if (incoming.headers[key] !== undefined) headers[key] = incoming.headers[key]!;
    }
    if (body.length) headers['content-length'] = String(body.length);
    state.inFlight++;
    let finished = false;
    const finish = (response: unknown, status: number, sessionId: string | null) => {
      if (finished) return;
      finished = true;
      observe({ id, at, request: rpc, response, status, sessionId });
      state.inFlight--;
    };
    const upstream = request({ hostname: '127.0.0.1', port: servicePort, path: '/mcp', method: incoming.method, headers }, response => {
      const forwarded: Record<string, string | string[]> = {};
      for (const key of ['content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version']) {
        if (response.headers[key] !== undefined) forwarded[key] = response.headers[key]!;
      }
      const result: Buffer[] = [];
      response.on('data', (chunk: Buffer) => result.push(chunk));
      const done = () => {
        let value: unknown = null;
        try { value = JSON.parse(Buffer.concat(result).toString()); } catch { /* empty or interrupted result stays unknown */ }
        finish(value, response.statusCode ?? 502, String(response.headers['mcp-session-id'] ?? incoming.headers['mcp-session-id'] ?? '') || null);
      };
      response.once('end', done); response.once('error', done);
      outgoing.writeHead(response.statusCode ?? 502, forwarded);
      response.pipe(outgoing);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.once('error', () => { finish(null, 502, null); if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); });
    upstream.end(body);
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(state.port, '127.0.0.1', resolve); });
  return state;
}

async function close(server: Server) {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
