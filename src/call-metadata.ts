// Private operational observations, independent of Map storage and MCP responses.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { isPlainObject, validateId } from './values.js';
import { answerDeskMapTools } from './mcp-schemas.js';
import { workflowContract } from './workflow.generated.js';
import { assertPrivate, assertPrivateFileParent } from './private-paths.js';

export const metadataSchema = 'wayfinder-service-call/1';
export type CallResult = 'committed' | 'read' | 'input-error' | 'command-rejected' | 'version-mismatch'
  | 'map-exists' | 'not-found' | 'conflict' | 'service-failure' | 'transport-failure' | 'stream-not-supported' | 'ok';
export interface CallMetadataRecord {
  schema: typeof metadataSchema;
  serviceStartedAt: string;
  version: string;
  sequence: number;
  missingObservations: number;
  startedAt: string;
  httpMethod: string | null;
  httpStatus: number | null;
  mcpSessionId: string | null;
  presentedMcpSessionId: string | null;
  requestId: string | null;
  requestIdType: 'string' | 'number' | null;
  requestIdHash: string | null;
  clientId: string | null;
  credentialFingerprint: string | null;
  method: string | null;
  tool: string | null;
  mapId: string | null;
  result: CallResult;
  durationMs: number;
}
export interface CallObservation {
  fields: Omit<CallMetadataRecord, 'schema' | 'serviceStartedAt' | 'version' | 'sequence' | 'missingObservations' | 'result' | 'durationMs'>;
  startedMonotonicMs: number;
  handled: boolean;
  toolCompleted: boolean;
  httpCompleted: boolean;
  recorded: boolean;
  failed: boolean;
  protocolFailed: boolean;
  result: CallResult | undefined;
}
const methods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping',
  'tools/list', 'tools/call', 'tasks/get', 'tasks/cancel', 'tasks/update', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get']);
const tools = new Set(answerDeskMapTools.map(tool => tool.name));
const httpMethods = new Set(['GET', 'POST', 'DELETE', 'HEAD', 'PUT', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Derived from the existing credential verifier, but not itself a stored authentication verifier.
export const credentialFingerprint = (token: string) => hash(`wayfinder-call-credential/1\0${hash(token)}`);
export const requestIdHash = (id: string) => hash(`wayfinder-call-request/1\0${id}`);
interface SecretDigest { length: number; hash: string }
const secretDigest = (value: string): SecretDigest => ({ length: value.length, hash: hash(value) });

/** Append only to a private, single-link regular file. Do not follow links or block on a substituted FIFO. */
export function appendPrivateMetadata(path: string, record: unknown): void {
  if (!isAbsolute(path)) throw new Error('Invalid metadata target');
  if (process.platform === 'win32') assertPrivateFileParent(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) {
      throw new Error('Invalid metadata target');
    }
    if (process.platform === 'win32') assertPrivate(path, false);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } finally { closeSync(fd); }
}

export function classifyCallResult(result: CallToolResult): CallResult {
  if (result.resultType === 'task') return 'ok';
  const value = result.structuredContent;
  if (!isPlainObject(value)) return 'transport-failure';
  if (['delivered', 'none_yet', 'superseded', 'interrupted'].includes(value.outcome as string) && Array.isArray(value.items)) return 'ok';
  switch (value.kind) {
    case 'committed': return 'committed';
    case 'found': case 'listed': return 'read';
    case 'conflict': return 'conflict';
    case 'not_found': return 'not-found';
    case 'infrastructure_error': return 'service-failure';
    case 'rejected':
      if (value.code === 'version_mismatch') return 'version-mismatch';
      if (value.code === 'map_already_exists') return 'map-exists';
      if (value.code === 'map_not_found') return 'not-found';
      if (value.error !== undefined || (isPlainObject(value.rejection) && value.rejection.stage === 'input')) return 'input-error';
      return 'command-rejected';
    default: return 'transport-failure';
  }
}

export class CallMetadata {
  readonly context = new AsyncLocalStorage<CallObservation | undefined>();
  private readonly serviceStartedAt = new Date().toISOString();
  private readonly primarySecret: SecretDigest;
  // Only digests and lengths are retained; an observation never holds a raw credential.
  private readonly secrets = new WeakMap<CallObservation, SecretDigest>();
  private sequence = 0;
  private missing = 0;
  constructor(private readonly databasePath: string, primaryToken: string) { this.primarySecret = secretDigest(primaryToken); }

  status() { return { observations: this.sequence, missingObservations: this.missing }; }

  begin(httpMethod: string | undefined): CallObservation | undefined {
    try {
      const observation: CallObservation = { fields: { startedAt: new Date().toISOString(),
        httpMethod: httpMethod && httpMethods.has(httpMethod) ? httpMethod : null, httpStatus: null,
        mcpSessionId: null, presentedMcpSessionId: null, requestId: null, requestIdType: null, requestIdHash: null,
        clientId: null, credentialFingerprint: null, method: null, tool: null, mapId: null },
      startedMonotonicMs: performance.now(), handled: false, toolCompleted: false, httpCompleted: false,
      recorded: false, failed: false, protocolFailed: false, result: undefined };
      return observation;
    } catch { this.sequence++; this.gap(); return undefined; }
  }

  /** Failure of context plumbing cannot prevent or replay the business operation. */
  run<T>(observation: CallObservation | undefined, call: () => Promise<T>): Promise<T> {
    let work: Promise<T> | undefined;
    let invoked = false;
    try { return this.context.run(observation, () => { invoked = true; return (work = call()); }); }
    catch (error) {
      if (observation) observation.failed = true;
      if (invoked) return work ?? Promise.reject(error);
      return call();
    }
  }

  update(observation: CallObservation | undefined, action: (value: CallObservation) => void): void {
    if (!observation) return;
    try { action(observation); } catch { observation.failed = true; }
  }

  // Only the authenticated HTTP path may supply client/session headers.
  identify(observation: CallObservation | undefined, clientId: string, token: string, presentedSession: unknown, sessionId?: string): void {
    this.update(observation, value => {
      this.secrets.set(value, secretDigest(token));
      value.fields.clientId = this.safeId(clientId, value);
      value.fields.credentialFingerprint ??= credentialFingerprint(token);
      value.fields.presentedMcpSessionId = this.safeId(presentedSession, value);
      if (sessionId !== undefined) value.fields.mcpSessionId = this.safeId(sessionId, value);
    });
  }

  capture(observation: CallObservation | undefined, body: unknown): void {
    this.update(observation, value => {
      if (!isPlainObject(body)) return;
      if (typeof body.id === 'number' && Number.isFinite(body.id)) {
        value.fields.requestIdType = 'number'; value.fields.requestId = String(body.id);
      } else if (typeof body.id === 'string') {
        value.fields.requestIdType = 'string'; value.fields.requestId = this.safeId(body.id, value);
        if (value.fields.requestId === null) value.fields.requestIdHash = requestIdHash(body.id);
      }
      value.fields.method = typeof body.method === 'string' && methods.has(body.method) ? body.method : null;
      if (body.method !== 'tools/call' || !isPlainObject(body.params)) return;
      value.fields.tool = typeof body.params.name === 'string' && tools.has(body.params.name) ? body.params.name : null;
      if (isPlainObject(body.params.arguments)) value.fields.mapId = this.safeId(body.params.arguments.mapId, value);
    });
  }

  async observeTool(call: () => Promise<CallToolResult>, classify: (result: CallToolResult) => CallResult): Promise<CallToolResult> {
    let observation: CallObservation | undefined;
    try { observation = this.context.getStore(); if (observation) observation.handled = true; }
    catch { /* The HTTP response path can recover the observation if context lookup fails. */ }
    let result: CallToolResult | undefined;
    try { result = await call(); return result; }
    finally {
      this.update(observation, value => {
        value.toolCompleted = true;
        value.result = result ? classify(result) : 'transport-failure';
      });
      if (observation?.httpCompleted) this.record(observation);
    }
  }

  response(observation: CallObservation | undefined, payload: unknown, classify: (result: CallToolResult) => CallResult): void {
    this.update(observation, value => {
      if (!isPlainObject(payload)) return;
      value.protocolFailed = isPlainObject(payload.error);
      // Recover without the async context; no business result or raw payload is retained.
      if (!value.handled && value.fields.method === 'tools/call' && isPlainObject(payload.result)) {
        value.result = classify(payload.result as CallToolResult);
      }
    });
  }

  finishHttp(observation: CallObservation | undefined, status: number | null): void {
    this.update(observation, value => { value.httpCompleted = true; value.fields.httpStatus = status; });
    // Disconnected work still owns its completion record; do not record a second, premature failure.
    if (observation && (!observation.handled || observation.toolCompleted)) this.record(observation);
  }

  private safeId(value: unknown, observation: CallObservation): string | null {
    if (typeof value !== 'string' || validateId(value, [])) return null;
    for (const secret of [this.primarySecret, this.secrets.get(observation)]) {
      if (!secret?.length) continue;
      for (let offset = 0; offset <= value.length - secret.length; offset++) {
        if (hash(value.slice(offset, offset + secret.length)) === secret.hash) return null;
      }
    }
    return value;
  }

  private record(observation: CallObservation): void {
    if (observation.recorded) return;
    observation.recorded = true;
    this.sequence++;
    try {
      if (observation.failed) throw new Error('Observation failed');
      const { fields } = observation;
      const result = observation.result ?? (fields.httpMethod === 'GET' && fields.httpStatus === 405 ? 'stream-not-supported'
        : observation.protocolFailed || fields.method === 'tools/call' || fields.httpStatus === null || fields.httpStatus >= 400 ? 'transport-failure' : 'ok');
      const record: CallMetadataRecord = { schema: metadataSchema, serviceStartedAt: this.serviceStartedAt,
        version: workflowContract.version, sequence: this.sequence, missingObservations: this.missing, ...fields,
        result, durationMs: Math.max(0, performance.now() - observation.startedMonotonicMs) };
      appendPrivateMetadata(`${this.databasePath}.calls.jsonl`, record);
    } catch { this.gap(); }
  }

  private diagnostic(record: unknown): void {
    try { writeSync(2, `${JSON.stringify(record)}\n`); } catch { /* Counters and independent gap file still remain. */ }
  }

  private gap(): void {
    this.missing++;
    const gap = { schema: 'wayfinder-service-call-gap/1', serviceStartedAt: this.serviceStartedAt,
      sequence: this.sequence, observations: this.sequence, missingObservations: this.missing };
    try { appendPrivateMetadata(`${this.databasePath}.calls.gaps.jsonl`, gap); } catch { /* stderr is an independent sink. */ }
    this.diagnostic(gap);
  }

  stop(): void {
    const summary = { schema: 'wayfinder-service-call-summary/1', serviceStartedAt: this.serviceStartedAt,
      stoppedAt: null as string | null, observations: this.sequence, missingObservations: this.missing };
    try { summary.stoppedAt = new Date().toISOString(); appendPrivateMetadata(`${this.databasePath}.calls.jsonl`, summary); }
    catch {
      try { appendPrivateMetadata(`${this.databasePath}.calls.gaps.jsonl`, summary); } catch { /* Report even when both files fail. */ }
      this.diagnostic(summary);
    }
  }
}
