import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebStandardStreamableHTTPServerTransport, createMcpHandler, isLegacyRequest, isInitializeRequest } from '@modelcontextprotocol/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import type { Server } from '@modelcontextprotocol/server';
import { createMapMcpServer } from './mcp-tools.js';
import type { ToolCallControl } from './mcp-tools.js';
import { CallAdmission } from './call-admission.js';
import { DeskDelivery, WaitCancelled } from './desk-delivery.js';
import { sendMcpResponse } from './mcp-response.js';
import type { SQLiteStorage } from './sqlite-storage.js';
import { isPlainObject, validateAuthor, validateId, validateObject } from './values.js';
import { handleViewer, requestTarget } from './viewer-http.js';
import { CallMetadata, classifyCallResult } from './call-metadata.js';
import type { CallObservation } from './call-metadata.js';

export const MAX_REQUEST_BYTES = 1_048_576;
export interface LocalServiceConfiguration {
  readonly databasePath: string;
  readonly port: number;
  readonly token: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly allowedOrigins?: readonly string[];
  // Optional operator-written file of further credentials, each with its own Client ID.
  readonly credentialsPath?: string;
  // The primary credential's client shows its model no server instructions (compatibility mode).
  readonly toolsOnly?: boolean;
  // Staged Answer Desk capability; #114 enables it by default.
  readonly answerDeskEnabled?: boolean;
}
export interface LocalMcpService {
  stop(): Promise<void>;
  metadataStatus(): { observations: number; missingObservations: number };
}
export class LocalServiceFailure extends Error {
  constructor(readonly code: 'invalid_configuration' | 'storage_not_ready' | 'port_unavailable' | 'service_failure' | 'answer_desk_required') {
    super(code === 'answer_desk_required'
      ? 'The configured private SQLite database has used Answer Desk; enable answerDeskEnabled (WAYFINDER_ANSWER_DESK_ENABLED=true).'
      : `Local MCP ${code}`);
    this.name = 'LocalServiceFailure';
  }
}

export function captureConfiguration(input: LocalServiceConfiguration): LocalServiceConfiguration {
  if (validateObject(input, [], ['databasePath', 'port', 'token', 'actorId', 'clientId', 'allowedOrigins', 'credentialsPath', 'toolsOnly', 'answerDeskEnabled'])
    || (input.answerDeskEnabled !== undefined && typeof input.answerDeskEnabled !== 'boolean')
    || (input.toolsOnly !== undefined && typeof input.toolsOnly !== 'boolean')
    || typeof input.databasePath !== 'string' || !input.databasePath
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
    || typeof input.token !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(input.token)
    || validateAuthor({ actorId: input.actorId, clientId: input.clientId, occurredAt: new Date().toISOString() })
    || (input.allowedOrigins !== undefined && (!Array.isArray(input.allowedOrigins) || !input.allowedOrigins.every(localOrigin)))
    || (input.credentialsPath !== undefined && (typeof input.credentialsPath !== 'string' || !isAbsolute(input.credentialsPath)))) {
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
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  response.end(errorBody(message, code));
}
const digest = (value: string) => createHash('sha256').update(value).digest();
interface Credential { readonly key: Buffer; readonly clientId: string; readonly toolsOnly: boolean }
// The file is re-read on every attempt, so an entry added or removed by the
// operator applies to the next request. Any invalid content admits no one.
function readCredentials(path: string | undefined): readonly Credential[] {
  if (path === undefined) return [];
  let file: unknown;
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  if (validateObject(file, [], ['credentials']) || !isPlainObject(file) || !Array.isArray(file.credentials)) return [];
  const credentials: Credential[] = [];
  for (const entry of file.credentials) {
    if (validateObject(entry, [], ['clientId', 'tokenSha256', 'toolsOnly']) || !isPlainObject(entry)
      || validateId(entry.clientId, []) || typeof entry.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.tokenSha256)
      || (entry.toolsOnly !== undefined && typeof entry.toolsOnly !== 'boolean')) return [];
    credentials.push({ key: Buffer.from(entry.tokenSha256, 'hex'), clientId: entry.clientId as string, toolsOnly: entry.toolsOnly === true });
  }
  return credentials;
}
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
  // Requests within a session must present the credential that opened it.
  readonly credential: Buffer;
  readonly clientId: string;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly pending: Set<Promise<void>>;
  closing: boolean;
}

// Internal ownership seam: tests may provide disposable real storage/faults.
// Production enters through mcp-service.ts, which opens only existing private DBs.
export async function serveLocalMcp(storage: SQLiteStorage, input: LocalServiceConfiguration): Promise<LocalMcpService> {
  const config = captureConfiguration(input);
  if (config.answerDeskEnabled !== true && storage.hasDeskHistory()) throw new LocalServiceFailure('answer_desk_required');
  const metadata = new CallMetadata(config.databasePath, config.token);
  const tokenHash = digest(`Bearer ${config.token}`);
  function authenticate(authorization: string | undefined): Credential | undefined {
    const presented = digest(authorization ?? '');
    if (timingSafeEqual(tokenHash, presented)) return { key: presented, clientId: config.clientId, toolsOnly: config.toolsOnly === true };
    const bearer = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(authorization ?? '');
    if (!bearer) return undefined;
    const key = digest(bearer[1]!);
    return readCredentials(config.credentialsPath).find(credential => timingSafeEqual(credential.key, key));
  }
  const host = `127.0.0.1:${config.port}`;
  const origins = new Set(config.allowedOrigins ?? []);
  const sessions = new Map<string, Session>();
  let stopping = false;
  const admission = new CallAdmission();
  const delivery = new DeskDelivery(storage, (call, signal) => admission.release(call, signal));
  const requests = new Set<Promise<void>>();
  const calls = new Set<Promise<unknown>>();
  const responseContext = new AsyncLocalStorage<ServerResponse>();
  const control: ToolCallControl = call => {
    const response = responseContext.getStore();
    // Both eras must cancel a suspended blocking wait on HTTP disconnect,
    // including legacy SSE peers that send no notifications/cancelled.
    // Only blocking waits consume this signal; writes keep their publication boundary.
    const disconnected = new AbortController();
    const close = () => disconnected.abort();
    response?.once('close', close);
    if (response?.destroyed) close();
    const work = metadata.observeTool(() => admission.admit(suspend => call(suspend, disconnected.signal)), classifyCallResult).catch(error => {
      // MCP cancellation suppresses the protocol response. End its HTTP stream
      // too, otherwise the legacy SDK leaves an empty SSE exchange suspended.
      if (error instanceof WaitCancelled && response && !response.destroyed && !response.writableEnded) response.end();
      throw error;
    }).finally(() => response?.removeListener('close', close));
    calls.add(work); void work.then(() => calls.delete(work), () => calls.delete(work));
    return work;
  };
  const serverFor = (credential: Credential) => createMapMcpServer(storage, {
    actorId: config.actorId, clientId: credential.clientId, viewerOrigin: `http://${host}`, toolsOnly: credential.toolsOnly, answerDeskEnabled: config.answerDeskEnabled === true,
  }, control, delivery, `${credential.key.toString('hex')}:${credential.clientId}`);
  async function sendProtocolResponse(result: Response, response: ServerResponse, observation: CallObservation | undefined) {
    await sendMcpResponse(result, response, payload => metadata.response(observation, payload, classifyCallResult));
  }
  async function handle(request: IncomingMessage, response: ServerResponse, observation: CallObservation | undefined) {
    if (stopping) { httpFailure(response, 503, 'Service stopping'); return; }
    if (request.headers.host !== host) { httpFailure(response, 403, 'Host forbidden'); return; }
    // The read-only viewer needs no token; routing by pathname keeps /mcp?query on the 404 below.
    if (requestTarget(request.url, host)?.pathname !== '/mcp') { await handleViewer(request, response, storage, host); return; }
    const credential = authenticate(request.headers.authorization);
    if (!credential) { httpFailure(response, 401, 'Local token required'); return; }
    const presentedSession = typeof request.headers['mcp-session-id'] === 'string' ? sessions.get(request.headers['mcp-session-id']) : undefined;
    const matchingSession = presentedSession && timingSafeEqual(presentedSession.credential, credential.key) ? presentedSession : undefined;
    metadata.identify(observation, matchingSession?.clientId ?? credential.clientId, request.headers.authorization!.slice(7),
      request.headers['mcp-session-id'], matchingSession?.transport.sessionId);
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
        metadata.capture(observation, body);
        // Current MCP requires one message per POST; no protocol batch bridge.
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          httpFailure(response, 400, 'Invalid protocol request', -32600); return;
        }
      }
    }
    // stop() may have started while the request body was arriving.
    if (stopping) { httpFailure(response, 503, 'Service stopping'); return; }
    // Omit optional IncomingMessage fields that the adapter's exact optional types do not accept.
    const webRequest = await toWebRequest({ method: request.method!, url: request.url!, headers: request.headers,
      [Symbol.asyncIterator]: () => request[Symbol.asyncIterator]() }, body);
    if (!await isLegacyRequest(webRequest, body)) {
      // Modern requests carry their protocol context on every call, not in an MCP
      // session. The authenticated credential still supplies the author identity.
      if (request.headers['mcp-session-id'] !== undefined) { httpFailure(response, 400, 'Modern requests do not use sessions'); return; }
      const modernHandler = createMcpHandler(() => serverFor(credential),
      { legacy: 'reject', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BYTES });
      // Modern HTTP cancellation is aborting the POST. It must also abort a
      // blocking wait before any progress has caused auto mode to open SSE.
      const blockingRequest = config.answerDeskEnabled === true && isPlainObject(body) && body.method === 'tools/call'
        && isPlainObject(body.params) && body.params.name === 'map_wait';
      const disconnected = () => { void modernHandler.close().catch(() => {}); };
      if (blockingRequest) response.once('close', disconnected);
      try {
        await sendProtocolResponse(await modernHandler.fetch(webRequest, { parsedBody: body }), response, observation);
      } finally { response.removeListener('close', disconnected); await modernHandler.close(); }
      return;
    }
    const sessionId = request.headers['mcp-session-id'];
    let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    let initializing = false;
    if (!session) {
      if (sessionId !== undefined) { httpFailure(response, 404, 'Session not found'); return; }
      if (request.method !== 'POST' || !isInitializeRequest(body)) { httpFailure(response, 400, 'Initialization required'); return; }
      initializing = true;
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: config.answerDeskEnabled !== true,
        onsessioninitialized(id) { sessions.set(id, created); metadata.update(observation, value => { value.fields.mcpSessionId = id; }); },
      });
      const server = serverFor(credential);
      const created: Session = { credential: credential.key, clientId: credential.clientId, server, transport, pending: new Set(), closing: false };
      await server.connect(transport);
      session = created;
      const closed = transport.onclose;
      transport.onclose = () => { closed?.(); if (transport.sessionId) sessions.delete(transport.sessionId); };
      // Never print SDK errors, which may contain submitted protocol data.
      server.onerror = () => {};
    }
    if (!timingSafeEqual(session.credential, credential.key)) { httpFailure(response, 403, 'Session belongs to another credential'); return; }
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
      const result = await Promise.race([session.transport.handleRequest(webRequest, { parsedBody: body }), lostResponse]);
      if (result && !response.destroyed) {
        await sendProtocolResponse(result, response, observation);
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
    const observation = requestTarget(request.url, host)?.pathname === '/mcp'
      ? metadata.begin(request.method) : undefined;
    const work = responseContext.run(response, () => metadata.run(observation, async () => {
      try { await handle(request, response, observation); }
      catch { httpFailure(response, 500, 'Service failure; outcome unknown'); }
      finally { metadata.finishHttp(observation, response.writableEnded ? response.statusCode : null); }
    }));
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
  return { metadataStatus: () => metadata.status(), stop() {
    if (!stopped) {
      stopping = true;
      admission.stop();
      delivery.stop();
      stopped = (async () => {
        await Promise.all([...requests]);
        await Promise.allSettled([...calls]);
        await admission.drain();
        await Promise.all([...sessions.values()].map(session => session.server.close()));
        await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); });
        storage.close();
        metadata.stop();
      })().catch(() => { throw new LocalServiceFailure('service_failure'); });
    }
    return stopped;
  } };
}
