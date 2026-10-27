import type { DeskState } from './desk-types.js';
import { emptyDesk } from './desk-types.js';
import { deskEffects, handleReopen, validateReopenCitation } from './desk-domain.js';
import type { ApplyRequest, CreateMapInput, InvalidInput, MapId, MutationAuthor, NonEmpty, PrepareResult, Result, SemanticChange, StoredMapState } from './types.js';
import { invalid, isPlainObject, validateAuthor, validateExtensions, validateId, validateObject } from './values.js';
import { immutableClone } from './immutable.js';
import { decodeApplyRequest } from './apply-input.js';
import { isDeepStrictEqual } from 'node:util';
import { calculateFrontier } from './frontier.js';
import { applyCommand } from './commands.js';
import { checkFinalGraph } from './graph.js';

const preparedBrand: unique symbol = Symbol('PreparedCommit');
interface PreparedBase {
  readonly [preparedBrand]: true;
  readonly mapId: MapId;
  readonly next: StoredMapState;
  readonly author: MutationAuthor;
  readonly changes: NonEmpty<SemanticChange>;
  readonly request?: ApplyRequest;
  readonly desk?: DeskState;
}
export type PreparedCommit = PreparedBase & (
  | { readonly kind: 'create'; readonly priorRevision: null }
  | { readonly kind: 'apply'; readonly priorRevision: number }
);

export function prepareCreate(input: CreateMapInput): Result<PreparedCommit, InvalidInput> {
  const error = validateCreate(input);
  if (error) return { kind: 'error', error };
  const prepared: PreparedCommit = {
    [preparedBrand]: true, kind: 'create', priorRevision: null, mapId: input.id,
    next: {
      id: input.id, title: input.title, destination: input.destination,
      notes: input.notes ?? '', extensions: input.extensions ?? {},
      fog: [], scopeExclusions: [], tickets: [], currentRevision: 1,
    },
    author: input.author,
    changes: [{ commandIndex: 0, command: 'map.create', subjectId: input.id }],
  };
  return { kind: 'ok', value: Object.freeze({
    ...immutableClone(prepared), [preparedBrand]: true as const,
  }) };
}

export function prepareApply(current: StoredMapState, request: ApplyRequest, desk: DeskState = emptyDesk): PrepareResult {
  const decoded = decodeApplyRequest(request);
  if (decoded.kind === 'error') return { kind: 'rejected', rejection: { stage: 'input', error: decoded.error } };
  request = decoded.value;
  if (!Number.isSafeInteger(current.currentRevision) || current.currentRevision <= 0) return { kind: 'rejected', rejection: {
    stage: 'input', error: invalid(['current', 'currentRevision'], 'Positive safe current head required'),
  } };
  if (request.mapId !== current.id) return { kind: 'rejected', rejection: {
    stage: 'input', error: invalid(['mapId'], 'Must match current Map identity'),
  } };
  if (request.expectedRevision !== current.currentRevision) return { kind: 'conflict', conflict: {
    mapId: request.mapId, expectedRevision: request.expectedRevision, currentRevision: current.currentRevision,
  } };
  const citation = validateReopenCitation(current, desk, request);
  if (citation) return { kind: 'rejected', rejection: citation };
  const initial = structuredClone(current);
  let nextDesk = structuredClone(desk);
  let next = structuredClone(initial);
  for (const [commandIndex, command] of request.commands.entries()) {
    const result = applyCommand(next, command, commandIndex, nextDesk, request.author.occurredAt);
    if (result.kind === 'error') return { kind: 'rejected', rejection: result.error };
    nextDesk = deskEffects(next, nextDesk, command);
    next = result.value;
    if (command.kind === 'ticket.reopen' && request.reopenRequestId
      && desk.reopenRequests.some(r => r.requestId === request.reopenRequestId && r.ticketId === command.ticketId)) {
      next = { ...next, tickets: next.tickets.map(t => t.id === command.ticketId && t.status === 'open'
        ? { ...t, reopenedAtRevision: current.currentRevision + 1 } : t) };
    }
  }
  const graphError = checkFinalGraph(next);
  if (graphError) return { kind: 'rejected', rejection: graphError };
  if (isDeepStrictEqual(comparableState(initial), comparableState(next)) && isDeepStrictEqual(desk, nextDesk)) return { kind: 'rejected', rejection: { stage: 'final_state', code: 'no_changes' } };
  if (!Number.isSafeInteger(current.currentRevision + 1)) return { kind: 'rejected', rejection: {
    stage: 'input', error: invalid(['expectedRevision'], 'Cannot advance beyond positive safe revisions'),
  } };
  next = { ...next, currentRevision: current.currentRevision + 1 };
  const change: PreparedCommit = {
    [preparedBrand]: true, kind: 'apply', priorRevision: current.currentRevision,
    mapId: current.id, next, author: request.author, request, desk: handleReopen(nextDesk, request, next.currentRevision),
    changes: request.commands.map((command, commandIndex) => ({
      commandIndex, command: command.kind, subjectId: command.kind === 'map.update' ? current.id
        : command.kind === 'content.add' || command.kind === 'content.update' ? command.item.id
        : command.kind === 'content.remove' ? command.itemId
        : command.kind === 'reopenRequest.close' ? command.requestId
        : command.kind === 'deskQuestion.post' ? command.question.questionId
        : command.kind === 'deskQuestion.withdraw' ? command.questionId
        : command.kind === 'ticket.create' ? command.ticket.id
        : command.kind === 'ticket.update' || command.kind === 'ticket.settle' || command.kind === 'ticket.reopen' || command.kind === 'claim.acquire' || command.kind === 'claim.release' || command.kind === 'claim.clear'
          ? command.ticketId : command.dependentId,
      ...(command.kind === 'deskQuestion.withdraw' || command.kind === 'reopenRequest.close' || command.kind === 'claim.clear' || command.kind === 'ticket.reopen' || (command.kind === 'claim.release' && command.reason !== undefined)
        ? { reason: command.reason } : {}),
    })) as unknown as NonEmpty<SemanticChange>,
  };
  return { kind: 'prepared', change: Object.freeze({
    ...immutableClone(change), [preparedBrand]: true as const,
  }), frontier: calculateFrontier(next) };
}

function comparableState(state: StoredMapState): StoredMapState {
  // AND Dependencies are relationships, not a priority/display-order list.
  // Normalize only for comparison; never reorder caller or stored snapshots.
  return { ...state, tickets: state.tickets.map(ticket => ({
    ...ticket, prerequisites: [...ticket.prerequisites].sort(),
  })) };
}

function validateCreate(input: unknown): InvalidInput | undefined {
  const shapeError = validateObject(input, [], ['id', 'title', 'destination', 'notes', 'extensions', 'author']);
  if (shapeError) return shapeError;
  if (!isPlainObject(input)) return invalid([], 'Plain create object required');
  const idError = validateId(input.id, ['id']);
  if (idError) return idError;
  for (const key of ['title', 'destination']) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') {
      return invalid([key], 'Nonblank text required');
    }
  }
  if (Object.hasOwn(input, 'notes') && typeof input.notes !== 'string') {
    return invalid(['notes'], 'String notes required');
  }
  if (Object.hasOwn(input, 'extensions')) {
    const error = validateExtensions(input.extensions);
    if (error) return error;
  }
  return validateAuthor(input.author);
}
