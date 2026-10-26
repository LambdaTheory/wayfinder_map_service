// Private operational observations, independent of Map storage and MCP responses.
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, constants, fstatSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isPlainObject, validateId } from './values.js';
import { workflowContract } from './workflow.generated.js';

export const metadataSchema = 'wayfinder-service-call/1';
export type CallResult = 'committed' | 'read' | 'input-error' | 'command-rejected' | 'version-mismatch'
  | 'map-exists' | 'not-found' | 'conflict' | 'service-failure' | 'transport-failure' | 'ok';
export interface CallObservation {
  readonly startedAt: string;
  readonly started: number;
  readonly secret: string;
  mcpSessionId: string | null;
  requestId: string | null;
  clientId: string | null;
  credentialFingerprint: string | null;
  method: string | null;
  tool: string | null;
  mapId: string | null;
  handled: boolean;
  protocolFailed: boolean;
}
export interface CallMetadataRecord {
  schema: typeof metadataSchema;
  serviceStartedAt: string;
  version: string;
  sequence: number;
  missingObservations: number;
  startedAt: string;
  mcpSessionId: string | null;
  requestId: string | null;
  clientId: string | null;
  credentialFingerprint: string | null;
  method: string | null;
  tool: string | null;
  mapId: string | null;
  result: CallResult;
  durationMs: number;
}

const methods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping',
  'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get']);
const tools = new Set(['map_create', 'map_list', 'map_read', 'map_apply']);

/** B01 represents JSON-RPC IDs as strings. Invalid/free-form identifiers stay absent, never copied as prose. */
function identifier(value: unknown, secret: string): string | null {
  return typeof value === 'string' && !validateId(value, []) && !(secret && value.includes(secret)) ? value : null;
}

/** Append only to a private, single-link regular file. Do not follow links or block on a substituted FIFO. */
export function appendPrivateMetadata(path: string, record: unknown): void {
  if (!isAbsolute(path)) throw new Error('Invalid metadata target');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
      throw new Error('Invalid metadata target');
    }
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } finally { closeSync(fd); }
}

export function classifyCallResult(result: CallToolResult): CallResult {
  const value = result.structuredContent;
  switch (value?.kind) {
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
  readonly context = new AsyncLocalStorage<CallObservation>();
  private readonly serviceStartedAt = new Date().toISOString();
  private sequence = 0;
  private missing = 0;
  constructor(private readonly databasePath: string, private readonly primaryToken: string) {}

  status() { return { observations: this.sequence, missingObservations: this.missing }; }

  begin(authorization: string | undefined): CallObservation {
    return { startedAt: new Date().toISOString(), started: performance.now(), secret: authorization?.replace(/^Bearer /, '') ?? '',
      mcpSessionId: null, requestId: null, clientId: null, credentialFingerprint: null, method: null, tool: null, mapId: null,
      handled: false, protocolFailed: false };
  }

  identify(observation: CallObservation, clientId: string, credentialFingerprint: string): void {
    observation.clientId = this.safeId(clientId, observation);
    observation.credentialFingerprint = credentialFingerprint;
  }

  capture(observation: CallObservation, body: unknown): void {
    if (!isPlainObject(body)) return;
    observation.requestId = typeof body.id === 'number' && Number.isFinite(body.id) ? String(body.id) : this.safeId(body.id, observation);
    observation.method = typeof body.method === 'string' && methods.has(body.method) ? body.method : null;
    if (body.method !== 'tools/call' || !isPlainObject(body.params)) return;
    observation.tool = typeof body.params.name === 'string' && tools.has(body.params.name) ? body.params.name : null;
    if (isPlainObject(body.params.arguments)) observation.mapId = this.safeId(body.params.arguments.mapId, observation);
  }

  private safeId(value: unknown, observation: CallObservation): string | null {
    return identifier(identifier(value, observation.secret), this.primaryToken);
  }

  record(observation: CallObservation, result: CallResult): void {
    const record: CallMetadataRecord = { schema: metadataSchema, serviceStartedAt: this.serviceStartedAt,
      version: workflowContract.version, sequence: ++this.sequence, missingObservations: this.missing,
      startedAt: observation.startedAt, mcpSessionId: observation.mcpSessionId, requestId: observation.requestId,
      clientId: observation.clientId, credentialFingerprint: observation.credentialFingerprint,
      method: observation.method, tool: observation.tool, mapId: observation.mapId,
      result, durationMs: Math.max(0, performance.now() - observation.started) };
    try { appendPrivateMetadata(`${this.databasePath}.calls.jsonl`, record); }
    catch {
      this.missing++;
      // Independent safe diagnostic plus a cumulative count on subsequent records and the operator API.
      // Neither a failed append nor a failed diagnostic is allowed to affect the business result.
      try { writeSync(2, `${JSON.stringify({ schema: 'wayfinder-service-call-gap/1', serviceStartedAt: this.serviceStartedAt,
        sequence: this.sequence, missingObservations: this.missing })}\n`); } catch { /* status() still exposes the gap. */ }
    }
  }
}
