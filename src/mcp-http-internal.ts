import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMapMcpServer } from './mcp-tools.js';
import type { SQLiteStorage } from './sqlite-storage.js';
import { validateAuthor, validateObject } from './values.js';
import { handleViewer, requestTarget } from './viewer-http.js';

export const MAX_REQUEST_BYTES = 1_048_576;
export interface LocalServiceConfiguration {
  readonly databasePath: string;
  readonly port: number;
  readonly token: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly allowedOrigins?: readonly string[];
}
export interface LocalMcpService { stop(): Promise<void> }
export class LocalServiceFailure extends Error {
  constructor(readonly code: 'invalid_configuration' | 'storage_not_ready' | 'port_unavailable' | 'service_failure') {
    super(`Local MCP ${code}`);
    this.name = 'LocalServiceFailure';
  }
}

export function captureConfiguration(input: LocalServiceConfiguration): LocalServiceConfiguration {
  if (validateObject(input, [], ['databasePath', 'port', 'token', 'actorId', 'clientId', 'allowedOrigins'])
    || typeof input.databasePath !== 'string' || !input.databasePath
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
    || typeof input.token !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(input.token)
    || validateAuthor({ actorId: input.actorId, clientId: input.clientId, occurredAt: new Date().toISOString() })
    || (input.allowedOrigins !== undefined && (!Array.isArray(input.allowedOrigins) || !input.allowedOrigins.every(localOrigin)))) {
    throw new LocalServiceFailure('invalid_configuration');
  }
  return structuredClone(input);
}
function localOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.origin === value;
  } catch { return false; }
}
function errorBody(message: string, code = -32000) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}
function httpFailure(response: ServerResponse, status: number, message: string, code = -32000) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  response.end(errorBody(message, code));
}
function refusal(code: 'service_busy' | 'service_stopping'): CallToolResult {
  return { content: [], isError: true, structuredContent: {
    kind: 'infrastructure_error', code, outcome: 'not_published', requiresRestart: false,
  } };
}
const digest = (value: string) => createHash('sha256').update(value).digest();
async function requestTooLarge(request: IncomingMessage, response: ServerResponse) {
  // Discard, never accumulate/parse, the excess body. Do not reset an uploading
  // socket before its explicit 413 can be consumed by the client.
  response.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
  response.flushHeaders();
  try {
    for await (const _chunk of request.iterator({ destroyOnReturn: false })) { /* Discard without buffering. */ }
  } catch { /* A disconnected uploader may no longer receive the refusal. */ }
  if (!response.destroyed) response.end(errorBody('Request too large'));
}
interface Session {
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly pending: Set<Promise<void>>;
  closing: boolean;
}

// Internal ownership seam: tests may provide disposable real storage/faults.
// Production enters through mcp-service.ts, which opens only existing private DBs.
export async function serveLocalMcp(storage: SQLiteStorage, input: LocalServiceConfiguration): Promise<LocalMcpService> {
  const config = captureConfiguration(input);
  const tokenHash = digest(`Bearer ${config.token}`);
  const host = `127.0.0.1:${config.port}`;
  const origins = new Set(config.allowedOrigins ?? []);
  const sessions = new Map<string, Session>();
  let stopping = false;
  let activeCalls = 0;
  const drains = new Set<() => void>();
  const requests = new Set<Promise<void>>();
  const control = async (call: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (stopping) return refusal('service_stopping');
    if (activeCalls >= 4) return refusal('service_busy');
    activeCalls++;
    try { return await call(); }
    finally {
      if (--activeCalls === 0) { for (const resolve of drains) resolve(); drains.clear(); }
    }
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (stopping) { httpFailure(response, 503, 'Service stopping'); return; }
    if (request.headers.host !== host) { httpFailure(response, 403, 'Host forbidden'); return; }
    // The read-only viewer needs no token; routing by pathname keeps /mcp?query on the 404 below.
    if (requestTarget(request.url, host)?.pathname !== '/mcp') { await handleViewer(request, response, storage, host); return; }
    if (!timingSafeEqual(tokenHash, digest(request.headers.authorization ?? ''))) {
      httpFailure(response, 401, 'Local token required'); return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) { httpFailure(response, 403, 'Origin forbidden'); return; }
    if (request.url !== '/mcp') { httpFailure(response, 404, 'Endpoint not found'); return; }
    const length = request.headers['content-length'];
    if (length !== undefined && Number(length) > MAX_REQUEST_BYTES) { await requestTooLarge(request, response); return; }
    // This headless service has no server-initiated subscriptions/SSE stream.
    if (request.method === 'GET') { response.setHeader('Allow', 'POST, DELETE'); httpFailure(response, 405, 'Standalone stream not offered'); return; }
    if (request.method !== 'POST' && request.method !== 'DELETE') { httpFailure(response, 405, 'Method not allowed'); return; }
    let body: unknown;
    if (request.method === 'POST' || request.method === 'DELETE') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) { await requestTooLarge(request, response); return; }
        chunks.push(chunk);
      }
      if (request.method === 'POST') {
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { httpFailure(response, 400, 'Invalid JSON', -32700); return; }
        // Current MCP requires one message per POST; no protocol batch bridge.
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          httpFailure(response, 400, 'Invalid protocol request', -32600); return;
        }
      }
    }
    // stop() may have started while the request body was arriving.
    if (stopping) { httpFailure(response, 503, 'Service stopping'); return; }
    const sessionId = request.headers['mcp-session-id'];
    let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    let initializing = false;
    if (!session) {
      if (sessionId !== undefined) { httpFailure(response, 404, 'Session not found'); return; }
      if (request.method !== 'POST' || !isInitializeRequest(body)) { httpFailure(response, 400, 'Initialization required'); return; }
      initializing = true;
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized(id) { sessions.set(id, created); },
      });
      const server = createMapMcpServer(storage, { ...configAuthor(config), viewerOrigin: `http://${host}` }, control);
      const created: Session = { server, transport, pending: new Set(), closing: false };
      await server.connect(transport);
      session = created;
      const closed = transport.onclose;
      transport.onclose = () => { closed?.(); if (transport.sessionId) sessions.delete(transport.sessionId); };
      // Never print SDK errors, which may contain submitted protocol data.
      server.onerror = () => {};
    }
    if (session.closing) { httpFailure(response, 404, 'Session closing'); return; }
    let finish: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    if (request.method === 'DELETE') {
      // The SDK close would discard unresolved JSON responses. Complete admitted
      // work before deleting a session; disconnect never cancels publication.
      session.closing = true;
      await Promise.all([...session.pending]);
    } else {
      pending = new Promise<void>(resolve => { finish = resolve; });
      session.pending.add(pending);
    }
    let disconnected!: () => void;
    const lostResponse = new Promise<undefined>(resolve => { disconnected = () => resolve(undefined); });
    response.once('close', disconnected);
    try {
      const headers = new Headers();
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
      const webRequest = new Request(`http://${host}/mcp`, { method: request.method!, headers });
      const result = await Promise.race([session.transport.handleRequest(webRequest, { parsedBody: body }), lostResponse]);
      if (result && !response.destroyed) {
        // JSON-response mode (no event replay/subscriptions). Strip SDK diagnostic
        // error data/prose, which must not expose malformed request contents.
        const text = await result.text();
        const payload = text ? JSON.parse(text) as Record<string, unknown> : undefined;
        if (payload?.error && typeof payload.error === 'object') {
          payload.error = { code: (payload.error as { code: number }).code, message: 'Protocol request failed' };
        }
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(payload ? JSON.stringify(payload) : undefined);
      }
    }
    finally {
      response.removeListener('close', disconnected);
      finish?.();
      if (pending) session.pending.delete(pending);
      if (request.method === 'DELETE') session.closing = false;
      if (initializing && !session.transport.sessionId) await session.server.close();
    }
  }
  const http = createServer((request, response) => {
    const work = handle(request, response).catch(() => { httpFailure(response, 500, 'Service failure; outcome unknown'); });
    requests.add(work); void work.finally(() => requests.delete(work));
  });
  http.requestTimeout = 30_000;
  http.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
  } catch { throw new LocalServiceFailure('port_unavailable'); }
  let stopped: Promise<void> | undefined;
  return { stop() {
    if (!stopped) {
      stopping = true;
      stopped = (async () => {
        await Promise.all([...requests]);
        if (activeCalls) await new Promise<void>(resolve => drains.add(resolve));
        await Promise.all([...sessions.values()].map(session => session.server.close()));
        await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); });
        storage.close();
      })().catch(() => { throw new LocalServiceFailure('service_failure'); });
    }
    return stopped;
  } };
}
function configAuthor(config: LocalServiceConfiguration) { return { actorId: config.actorId, clientId: config.clientId }; }
