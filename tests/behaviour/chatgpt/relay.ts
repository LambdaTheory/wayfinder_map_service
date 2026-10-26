// Capture the actual MCP wire exchange. Authentication never comes from the incoming public request.
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { freePort, reservedPorts } from '../runner/service.ts';

export interface Exchange { id: string; at: string; request: Record<string, unknown>; response: unknown; status: number; sessionId: string | null }
export interface Relay {
  port: number;
  /** Writes and reads by the client are allowed only inside a labelled turn. Discovery is allowed between turns. */
  active: boolean;
  token: string;
  inFlight: number;
  beforeForward(): Promise<void>;
  onFailure(error: Error): void;
  stop(): Promise<void>;
}
export async function startRelay(servicePort: number, token: string, observe: (e: Exchange) => void): Promise<Relay> {
  if (reservedPorts.includes(servicePort)) throw new Error('Everyday service ports are forbidden');
  let counter = 0;
  const state: Relay = { port: await freePort(), token, active: false, inFlight: 0, beforeForward: async () => {},
    onFailure: () => { state.active = false; }, stop: async () => close(server) };
  const fail = (error: unknown) => {
    state.active = false;
    try { state.onFailure(error instanceof Error ? error : new Error('relay observation failed')); } catch { /* exit handler still owns cleanup */ }
  };
  const respond = (outgoing: ServerResponse, status: number) => {
    if (outgoing.destroyed || outgoing.writableEnded) return;
    if (outgoing.headersSent) { outgoing.destroy(); return; }
    outgoing.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null,
      error: { code: status === 400 ? -32600 : -32603, message: status === 400 ? 'Invalid request' : 'Request unavailable' } }));
  };
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (incoming.url !== '/mcp') { outgoing.writeHead(404).end(); return; }
    if (incoming.headers.origin !== undefined) { outgoing.writeHead(403).end(); return; }
    if (!['POST', 'DELETE'].includes(incoming.method ?? '')) { outgoing.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 1_048_576) { respond(outgoing, 413); return; }
        chunks.push(chunk as Buffer);
      }
    } catch { respond(outgoing, 400); return; } // Interrupted POSTs are client errors, never unhandled rejections.
    const body = Buffer.concat(chunks);
    let rpc: Record<string, unknown> = {};
    try { if (body.length) rpc = JSON.parse(body.toString()) as Record<string, unknown>; }
    catch { respond(outgoing, 400); return; }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) { respond(outgoing, 400); return; }
    if (incoming.method === 'POST' && (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')) { respond(outgoing, 400); return; }
    if (rpc.method === 'tools/call') {
      const p = rpc.params as { name?: unknown; arguments?: unknown } | null;
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.name !== 'string'
        || (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))) { respond(outgoing, 400); return; }
    }
    // Out-of-turn operations cannot mutate or leak Scenario state into another chat.
    if (!state.active && !['initialize', 'notifications/initialized', 'tools/list', 'ping', 'resources/list', 'prompts/list', undefined].includes(rpc.method as string | undefined)) {
      outgoing.writeHead(503).end(); return;
    }
    state.inFlight++;
    try { await state.beforeForward(); }
    catch (error) { state.inFlight--; fail(error); respond(outgoing, 503); return; }
    if (incoming.destroyed && !incoming.complete) { state.inFlight--; return; }
    const id = `rpc-${++counter}`;
    const at = new Date().toISOString();
    const headers: Record<string, string | string[]> = { host: `127.0.0.1:${servicePort}`, authorization: `Bearer ${state.token}` };
    for (const key of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version']) {
      if (incoming.headers[key] !== undefined) headers[key] = incoming.headers[key]!;
    }
    if (body.length) headers['content-length'] = String(body.length);
    let finished = false;
    const finish = (response: unknown, status: number, sessionId: string | null) => {
      if (finished) return;
      finished = true;
      try { observe({ id, at, request: rpc, response, status, sessionId }); }
      catch (error) { fail(error); respond(outgoing, 500); }
      finally { state.inFlight--; }
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
      if (!outgoing.destroyed) { outgoing.writeHead(response.statusCode ?? 502, forwarded); response.pipe(outgoing); }
      else response.resume();
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.once('error', () => { finish(null, 502, null); respond(outgoing, 502); });
    upstream.end(body);
  };
  const server = createServer((incoming, outgoing) => {
    outgoing.on('error', () => {}); // A disconnected client cannot crash this process through a response stream.
    void handle(incoming, outgoing).catch(error => { fail(error); respond(outgoing, 500); });
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
