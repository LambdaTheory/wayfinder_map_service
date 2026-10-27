// Capture the actual MCP wire exchange. Authentication never comes from the incoming public request.
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { freePort, reservedPorts } from '../runner/service.ts';
import { directAgent } from '../runner/direct-http.ts';

export interface Exchange { id: string; at: string; httpMethod: string; request: Record<string, unknown>; response: unknown; status: number; sessionId: string | null }
export type RefusalReason = 'path_mismatch' | 'origin_present' | 'method_not_allowed' | 'body_too_large' | 'body_interrupted'
  | 'delete_body' | 'invalid_json' | 'non_object_json' | 'invalid_rpc' | 'invalid_tool_params' | 'outside_turn' | 'ownership_check_failed';
export interface RefusalBody {
  /** Unavailable means incomplete, over the size limit, or rejected before the body arrived. */
  bodyShape: 'object' | 'array' | 'empty' | 'unparseable' | 'scalar' | 'unavailable';
  rpcMethod: string | null;
}
export interface RelayRefusal extends RefusalBody {
  at: string;
  status: number;
  reason: RefusalReason;
  httpMethod: string;
  pathIsMcp: boolean;
  originPresent: boolean;
  contentTypeIsJson: boolean;
  withinTurn: boolean;
}
/** The same index identifies the initial refusal and its optional late body observation. */
export interface RelayRefusalEvent { index: number; kind: 'refusal' | 'body'; refusal: RelayRefusal }
const bodyLimit = 1_048_576;
const unavailableBody: RefusalBody = { bodyShape: 'unavailable', rpcMethod: null };
function describeBody(body: Buffer): RefusalBody {
  if (!body.length) return { bodyShape: 'empty', rpcMethod: null };
  try {
    const value: unknown = JSON.parse(body.toString());
    const object = value !== null && typeof value === 'object' && !Array.isArray(value);
    const method = object ? (value as Record<string, unknown>).method : undefined;
    return { bodyShape: Array.isArray(value) ? 'array' : object ? 'object' : 'scalar',
      // A bounded method name only: never serialize params, batch elements or arbitrary method text.
      rpcMethod: typeof method === 'string' && /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/.test(method) ? method : null };
  } catch { return { bodyShape: 'unparseable', rpcMethod: null }; }
}
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
export async function startRelay(servicePort: number, token: string, observe: (e: Exchange) => void,
  observeRefusal: (event: RelayRefusalEvent) => void): Promise<Relay> {
  if (reservedPorts.includes(servicePort)) throw new Error('Everyday service ports are forbidden');
  const agent = directAgent();
  let counter = 0;
  let refusalCounter = 0;
  const state: Relay = { port: await freePort(), token, active: false, inFlight: 0, beforeForward: async () => {},
    onFailure: () => { state.active = false; }, stop: async () => { agent.destroy(); await close(server); } };
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
    const metadata = { at: new Date().toISOString(), httpMethod: incoming.method ?? '', pathIsMcp: incoming.url === '/mcp',
      originPresent: incoming.headers.origin !== undefined, withinTurn: state.active,
      contentTypeIsJson: /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|\s*$)/i.test(incoming.headers['content-type'] ?? '') };
    const recordRefusal = (status: number, reason: RefusalReason, body: RefusalBody) => {
      const refusal = { ...metadata, status, reason, ...body };
      const event: RelayRefusalEvent = { index: refusalCounter++, kind: 'refusal', refusal };
      observeRefusal(event); // Persist before responding or invoking a failure/exit handler.
      return event;
    };
    const earlyRefusal = (status: number, reason: RefusalReason) => {
      const event = recordRefusal(status, reason, unavailableBody);
      // Keep the immediate header refusal. Fill in the same record if a bounded, complete body arrives later.
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= bodyLimit) chunks.push(chunk); else chunks.length = 0;
      });
      incoming.once('end', () => {
        const refusal = { ...event.refusal, ...(bytes <= bodyLimit ? describeBody(Buffer.concat(chunks)) : unavailableBody) };
        try { observeRefusal({ index: event.index, kind: 'body', refusal }); } catch (error) { fail(error); }
      });
      incoming.on('error', () => {}); // The already persisted record remains unavailable on interruption.
      outgoing.writeHead(status).end();
    };
    if (!metadata.pathIsMcp) { earlyRefusal(404, 'path_mismatch'); return; }
    if (metadata.originPresent) { earlyRefusal(403, 'origin_present'); return; }
    if (!['POST', 'DELETE'].includes(incoming.method ?? '')) { earlyRefusal(405, 'method_not_allowed'); return; }
    const refuse = (status: number, reason: RefusalReason, body: RefusalBody, emptyResponse = false) => {
      recordRefusal(status, reason, body);
      if (emptyResponse) outgoing.writeHead(status).end(); else respond(outgoing, status);
    };
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > bodyLimit) { refuse(413, 'body_too_large', unavailableBody); return; }
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      if (bytes > bodyLimit) throw error; // A refusal-persistence failure is not a second client interruption.
      refuse(400, 'body_interrupted', unavailableBody); return;
    } // Interrupted POSTs are client errors, never unhandled rejections.
    const body = Buffer.concat(chunks);
    const bodyDescription = describeBody(body);
    // DELETE terminates a session; its body can never supply JSON-RPC evidence.
    if (incoming.method === 'DELETE' && body.length) { refuse(400, 'delete_body', bodyDescription); return; }
    let rpc: Record<string, unknown> = {};
    try { if (body.length) rpc = JSON.parse(body.toString()) as Record<string, unknown>; }
    catch { refuse(400, 'invalid_json', bodyDescription); return; }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) { refuse(400, 'non_object_json', bodyDescription); return; }
    if (incoming.method === 'POST' && (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')) { refuse(400, 'invalid_rpc', bodyDescription); return; }
    if (rpc.method === 'tools/call') {
      const p = rpc.params as { name?: unknown; arguments?: unknown } | null;
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.name !== 'string'
        || (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))) { refuse(400, 'invalid_tool_params', bodyDescription); return; }
    }
    // Out-of-turn operations cannot mutate or leak Scenario state into another chat.
    if (!state.active && !['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'ping', 'resources/list', 'resources/templates/list', 'prompts/list', undefined].includes(rpc.method as string | undefined)) {
      refuse(503, 'outside_turn', bodyDescription, true); return;
    }
    state.inFlight++;
    try { await state.beforeForward(); }
    catch (error) { state.inFlight--; recordRefusal(503, 'ownership_check_failed', bodyDescription); fail(error); respond(outgoing, 503); return; }
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
      try { observe({ id, at, httpMethod: incoming.method!, request: rpc, response, status, sessionId }); }
      catch (error) { fail(error); respond(outgoing, 500); }
      finally { state.inFlight--; }
    };
    const upstream = request({ agent, hostname: '127.0.0.1', port: servicePort, path: '/mcp', method: incoming.method, headers }, response => {
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
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(state.port, '127.0.0.1', resolve); }).catch(error => { agent.destroy(); throw error; });
  return state;
}

async function close(server: Server) {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
