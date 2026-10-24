import type { ApplyRequest, InvalidInput, Result, TicketType } from './types.js';
import { invalid, isPlainObject, validateArrayShape, validateAuthor, validateExtensions, validateId, validateObject } from './values.js';
import { immutableClone } from './immutable.js';
import { validateMapContent } from './content-input.js';
import { validateSettlement } from './settlement-input.js';

export function decodeApplyRequest(raw: unknown): Result<ApplyRequest, InvalidInput> {
  const error = validateRequest(raw);
  return error ? { kind: 'error', error } : { kind: 'ok', value: immutableClone(raw as ApplyRequest) };
}

function validateRequest(raw: unknown): InvalidInput | undefined {
  const shape = validateObject(raw, [], ['mapId', 'expectedRevision', 'author', 'commands']);
  if (shape) return shape;
  if (!isPlainObject(raw)) return invalid([], 'Plain request required');
  const identity = validateId(raw.mapId, ['mapId']);
  if (identity) return identity;
  if (typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision <= 0) {
    return invalid(['expectedRevision'], 'Positive safe integer required');
  }
  const authorError = validateAuthor(raw.author);
  if (authorError) return authorError;
  const commands = raw.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return invalid(['commands'], 'Nonempty plain command array required');
  }
  const arrayShape = validateArrayShape(commands, ['commands']);
  if (arrayShape) return arrayShape;
  for (let i = 0; i < commands.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(commands, String(i))!;
    const command: unknown = descriptor.value;
    const path = ['commands', i] as const;
    const shape = validateObject(command, path);
    if (shape) return shape;
    if (!isPlainObject(command)) return invalid(path, 'Plain command required');
    if (command.kind === 'ticket.reopen') {
      const shape = validateObject(command, path, ['kind', 'ticketId', 'reason']);
      if (shape) return shape;
      const identity = validateId(command.ticketId, [...path, 'ticketId']);
      if (identity) return identity;
      if (typeof command.reason !== 'string' || command.reason.trim() === '') return invalid([...path, 'reason'], 'Nonblank reason required');
      continue;
    }
    if (command.kind === 'ticket.settle') {
      const shape = validateObject(command, path, ['kind', 'ticketId', 'ticketType', 'claimantId', 'settlement']);
      if (shape) return shape;
      for (const key of ['ticketId', 'claimantId']) {
        const identity = validateId(command[key], [...path, key]);
        if (identity) return identity;
      }
      if (!isTicketType(command.ticketType)) return invalid([...path, 'ticketType'], 'Supported Ticket type required');
      const settlement = validateSettlement(command.settlement, command.ticketType, [...path, 'settlement']);
      if (settlement) return settlement;
      continue;
    }
    if (command.kind === 'claim.acquire' || command.kind === 'claim.release' || command.kind === 'claim.clear') {
      const clearing = command.kind === 'claim.clear';
      // A release may say why; a clear must.
      const reasoned = clearing || (command.kind === 'claim.release' && Object.hasOwn(command, 'reason'));
      const shape = validateObject(command, path, clearing ? ['kind', 'ticketId', 'expectedClaimantId', 'reason']
        : command.kind === 'claim.release' ? ['kind', 'ticketId', 'claimantId', 'reason'] : ['kind', 'ticketId', 'claimantId']);
      if (shape) return shape;
      for (const key of ['ticketId', clearing ? 'expectedClaimantId' : 'claimantId']) {
        const identity = validateId(command[key], [...path, key]);
        if (identity) return identity;
      }
      if (reasoned && (typeof command.reason !== 'string' || command.reason.trim() === '')) return invalid([...path, 'reason'], 'Nonblank reason required');
      continue;
    }
    if (command.kind === 'content.add' || command.kind === 'content.update' || command.kind === 'content.remove') {
      const shape = validateObject(command, path, command.kind === 'content.remove' ? ['kind', 'section', 'itemId'] : ['kind', 'section', 'item']);
      if (shape) return shape;
      if (command.section !== 'fog' && command.section !== 'scopeExclusions') return invalid([...path, 'section'], 'Supported content section required');
      const itemError = command.kind === 'content.remove' ? validateId(command.itemId, [...path, 'itemId']) : validateMapContent(command.item, [...path, 'item']);
      if (itemError) return itemError;
      continue;
    }
    if (command.kind === 'ticket.create') {
      const shape = validateObject(command, path, ['kind', 'ticket']);
      if (shape) return shape;
      const ticketPath = [...path, 'ticket'];
      const ticketShape = validateObject(command.ticket, ticketPath, ['id', 'title', 'question', 'type', 'extensions']);
      if (ticketShape) return ticketShape;
      if (!isPlainObject(command.ticket)) return invalid(ticketPath, 'Plain Ticket required');
      const ticket = command.ticket;
      const identity = validateId(ticket.id, [...ticketPath, 'id']);
      if (identity) return identity;
      for (const key of ['title', 'question']) {
        if (typeof ticket[key] !== 'string' || ticket[key].trim() === '') return invalid([...ticketPath, key], 'Nonblank text required');
      }
      if (!isTicketType(ticket.type)) return invalid([...ticketPath, 'type'], 'Supported Ticket type required');
      if (Object.hasOwn(ticket, 'extensions')) {
        const error = validateExtensions(ticket.extensions, [...ticketPath, 'extensions']);
        if (error) return error;
      }
      continue;
    }
    if (command.kind === 'dependency.add' || command.kind === 'dependency.remove') {
      const shape = validateObject(command, path, ['kind', 'dependentId', 'prerequisiteId', 'claimantId']);
      if (shape) return shape;
      for (const key of ['dependentId', 'prerequisiteId', ...(Object.hasOwn(command, 'claimantId') ? ['claimantId'] : [])]) {
        const identity = validateId(command[key], [...path, key]);
        if (identity) return identity;
      }
      continue;
    }
    if (command.kind !== 'map.update' && command.kind !== 'ticket.update') return invalid([...path, 'kind'], 'Unsupported command kind');
    const ticketUpdate = command.kind === 'ticket.update';
    const commandShape = validateObject(command, path, ticketUpdate ? ['kind', 'ticketId', 'patch', 'claimantId'] : ['kind', 'patch']);
    if (commandShape) return commandShape;
    if (ticketUpdate) {
      const identity = validateId(command.ticketId, [...path, 'ticketId']);
      if (identity) return identity;
      if (Object.hasOwn(command, 'claimantId')) {
        const access = validateId(command.claimantId, [...path, 'claimantId']);
        if (access) return access;
      }
    }
    const patchPath = [...path, 'patch'];
    const patchShape = validateObject(command.patch, patchPath, ticketUpdate ? ['title', 'question', 'type', 'extensions'] : ['title', 'destination', 'notes', 'extensions']);
    if (patchShape) return patchShape;
    if (!isPlainObject(command.patch)) return invalid(patchPath, 'Plain patch required');
    const patch = command.patch;
    if (Object.keys(patch).length === 0) return invalid(patchPath, 'Nonempty patch required');
    for (const key of ticketUpdate ? ['title', 'question'] : ['title', 'destination']) {
      if (Object.hasOwn(patch, key) && (typeof patch[key] !== 'string' || patch[key].trim() === '')) {
        return invalid([...patchPath, key], 'Nonblank text required');
      }
    }
    if (ticketUpdate && Object.hasOwn(patch, 'type') && !isTicketType(patch.type)) return invalid([...patchPath, 'type'], 'Supported Ticket type required');
    if (Object.hasOwn(patch, 'notes') && typeof patch.notes !== 'string') return invalid([...patchPath, 'notes'], 'String required');
    if (Object.hasOwn(patch, 'extensions')) {
      const error = validateExtensions(patch.extensions, [...patchPath, 'extensions']);
      if (error) return error;
    }
  }
}

const ticketTypes: Readonly<Record<TicketType, true>> = { grilling: true, prototype: true, research: true, task: true };
function isTicketType(value: unknown): value is TicketType {
  return typeof value === 'string' && Object.hasOwn(ticketTypes, value);
}
