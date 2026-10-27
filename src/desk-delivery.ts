import { randomUUID } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ClaimantId, MapId } from './types.js';
import type { SQLiteStorage } from './sqlite-storage.js';
import type { ReadDelivery } from './desk-types.js';
import { SQLiteFailure } from './sqlite-storage.js';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export class WaitCancelled extends ProtocolError {
  constructor() { super(ProtocolErrorCode.InvalidRequest, 'Request cancelled'); }
}
export interface WaitArguments { readonly mapId: MapId; readonly claimantId: ClaimantId; readonly maxWaitSeconds: number }
type Release = <T>(call: () => T, signal: AbortSignal) => Promise<T>;
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
interface Wait {
  readonly args: WaitArguments;
  readonly controller: AbortController;
  readonly createdAt: number;
  readonly taskId?: string;
  readonly owner: string;
  status: 'working' | 'completed' | 'cancelled' | 'failed';
  updatedAt: number;
  outcome?: 'superseded' | 'interrupted';
  result?: CallToolResult;
  error?: { code: number; message: string };
  collection?: Promise<void>;
}
export function toolResult(result: object): CallToolResult {
  return { content: [], structuredContent: structuredClone(result) as Record<string, unknown> };
}
export function storageError(error: unknown): CallToolResult {
  return { ...toolResult({ kind: 'infrastructure_error', code: error instanceof SQLiteFailure ? error.code : 'storage_failure',
    outcome: error instanceof SQLiteFailure ? error.outcome : 'unknown', requiresRestart: error instanceof SQLiteFailure ? error.requiresRestart : true }), isError: true };
}

// One instance per service, shared by both eras and every request-scoped server.
// Task handles are memory-only; answers and Taken remain in SQLite.
export class DeskDelivery {
  private readonly waits = new Map<string, Wait>();
  private readonly tasks = new Map<string, Wait>();
  private stopping = false;
  constructor(private readonly storage: SQLiteStorage,
    private readonly release: Release = async (call, signal) => { signal.throwIfAborted(); return call(); }) {}

  take(mapId: MapId, claimantId: ClaimantId) { return this.storage.desk.takeEligible(mapId, claimantId); }

  start(args: WaitArguments, task: boolean, owner: string): Wait | CallToolResult {
    this.sweep();
    if (this.stopping || (task && this.tasks.size >= 1000)) return { ...toolResult({ kind: 'infrastructure_error',
      code: this.stopping ? 'service_stopping' : 'service_busy', outcome: 'not_published', requiresRestart: false }), isError: true };
    const current = this.storage.desk.inspect(args.mapId);
    if (current.kind !== 'found') return toolResult(current);
    const key = this.key(args);
    const prior = this.waits.get(key);
    if (prior) { prior.outcome = 'superseded'; prior.controller.abort(); this.detach(prior); }
    const now = Date.now();
    const wait: Wait = { args, owner, createdAt: now, updatedAt: now, controller: new AbortController(), status: 'working', ...(task ? { taskId: randomUUID() } : {}) };
    this.waits.set(key, wait);
    if (wait.taskId) this.tasks.set(wait.taskId, wait);
    return wait;
  }

  handle(wait: Wait): CallToolResult { return { content: [], resultType: 'task', ...this.describe(wait) }; }

  async block(wait: Wait, signal: AbortSignal, progress: (elapsed: number) => Promise<void>): Promise<CallToolResult> {
    const cancel = () => { wait.status = 'cancelled'; wait.controller.abort(); this.detach(wait); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let lastProgress = -Infinity;
    try {
      while (wait.status === 'working' && !wait.outcome) {
        if (this.ready(wait)) { await this.collect(wait); if (wait.status !== 'working') break; }
        const elapsed = Date.now() - wait.createdAt;
        if (elapsed - lastProgress >= 10_000) { lastProgress = elapsed; await progress(elapsed / 1000).catch(() => {}); }
        await pause(Math.min(1000, Math.max(1, wait.createdAt + wait.args.maxWaitSeconds * 1000 - Date.now())), wait.controller.signal);
      }
      if (wait.status === 'cancelled') throw new WaitCancelled();
      if (wait.outcome) return this.empty(wait, wait.outcome);
      return wait.result!;
    } catch (error) {
      if (wait.status === 'cancelled') throw error;
      return storageError(error);
    } finally { signal.removeEventListener('abort', cancel); this.detach(wait); }
  }

  async get(taskId: string, owner: string): Promise<Record<string, unknown>> {
    const wait = this.find(taskId, owner);
    if (wait.outcome === 'superseded' && wait.status === 'working') this.complete(wait, this.empty(wait, 'superseded'));
    if (wait.status === 'working') {
      try { if (this.ready(wait)) await this.collect(wait); }
      catch (error) { this.complete(wait, storageError(error)); }
    }
    if (wait.outcome === 'superseded' && wait.status === 'working') this.complete(wait, this.empty(wait, 'superseded'));
    return { resultType: 'complete', ...this.describe(wait) };
  }

  cancel(taskId: string, owner: string) {
    const wait = this.find(taskId, owner);
    if (wait.status === 'working') { wait.status = 'cancelled'; wait.updatedAt = Date.now(); wait.controller.abort(); this.detach(wait); }
    return { resultType: 'complete' };
  }

  stop() {
    this.stopping = true;
    for (const wait of this.waits.values()) {
      wait.outcome = 'interrupted';
      if (wait.taskId) { wait.status = 'failed'; wait.error = { code: -32603, message: 'service stopping' }; wait.updatedAt = Date.now(); }
      wait.controller.abort();
    }
    this.waits.clear();
  }

  private ready(wait: Wait): boolean {
    if (Date.now() >= wait.createdAt + wait.args.maxWaitSeconds * 1000) return true;
    const current = this.storage.desk.inspect(wait.args.mapId);
    if (current.kind !== 'found') return true;
    const desk = this.storage.desk.read(wait.args.mapId);
    if (desk.quietUntil && Date.parse(desk.quietUntil) > Date.now()) return false;
    return desk.reopenRequests.some(r => r.state === 'pending') || current.desk.deskQuestions.some(q => q.state === 'answered'
      && current.revision.state.tickets.some(t => t.id === q.ticketId && t.claim === wait.args.claimantId));
  }

  private async collect(wait: Wait) {
    // Concurrent tasks/get calls share one release and the exact retained result.
    wait.collection ??= this.release(() => {
      if (wait.outcome || wait.status !== 'working') return;
      const delivery = this.take(wait.args.mapId, wait.args.claimantId);
      if (delivery.kind !== 'updated') { this.complete(wait, toolResult(delivery)); return; }
      if (!wait.taskId && delivery.value.outcome === 'none_yet' && Date.now() < wait.createdAt + wait.args.maxWaitSeconds * 1000) return;
      this.complete(wait, this.withRevision(wait, delivery.value));
    }, wait.controller.signal).catch(error => {
      if (!wait.controller.signal.aborted) this.complete(wait, storageError(error));
    });
    await wait.collection;
    if (!wait.taskId && wait.status === 'working') delete wait.collection;
  }
  private withRevision(wait: Wait, delivery: ReadDelivery | { outcome: 'superseded' | 'interrupted'; items: readonly [] }): CallToolResult {
    const current = this.storage.desk.inspect(wait.args.mapId);
    return current.kind === 'found' ? toolResult({ ...delivery, currentRevision: current.revision.revision }) : toolResult(current);
  }
  private empty(wait: Wait, outcome: 'superseded' | 'interrupted') { return this.withRevision(wait, { outcome, items: [] }); }
  private complete(wait: Wait, result: CallToolResult) {
    // The SDK encodes only the outer RPC result. A task's retained nested result
    // must be a modern complete tool result too, including errors/empty outcomes.
    // Keep it for retries when the first tasks/get response is lost after Taken.
    wait.result = wait.taskId ? { ...result, resultType: 'complete' } : result;
    wait.status = 'completed'; wait.updatedAt = Date.now(); this.detach(wait);
  }
  private describe(wait: Wait): Record<string, unknown> {
    return { taskId: wait.taskId, status: wait.status, createdAt: new Date(wait.createdAt).toISOString(),
      lastUpdatedAt: new Date(wait.updatedAt).toISOString(), ttlMs: wait.args.maxWaitSeconds * 1000 + 600_000, pollIntervalMs: 1000,
      ...(wait.result ? { result: wait.result } : {}), ...(wait.error ? { error: wait.error, statusMessage: wait.error.message } : {}) };
  }
  private find(id: string, owner: string) {
    this.sweep(); const wait = this.tasks.get(id);
    if (!wait || wait.owner !== owner) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task');
    return wait;
  }
  private sweep() {
    for (const [id, wait] of this.tasks) if (Date.now() >= wait.createdAt + wait.args.maxWaitSeconds * 1000 + 600_000) {
      this.tasks.delete(id); wait.controller.abort(); this.detach(wait);
    }
  }
  private key(args: WaitArguments) { return JSON.stringify([args.mapId, args.claimantId]); }
  private detach(wait: Wait) { if (this.waits.get(this.key(wait.args)) === wait) this.waits.delete(this.key(wait.args)); }
}
