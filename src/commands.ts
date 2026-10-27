import { emptyDesk } from './desk-types.js';
import type { DeskState } from './desk-types.js';
import { activeQuestion, currentAnswer, targetBinding } from './desk-domain.js';
import type { Command, CommandErrorCode, CommandRejection, Result, StoredMapState, StoredTicket, TicketId } from './types.js';
import { calculateFrontier } from './frontier.js';

export function applyCommand(state: StoredMapState, command: Command, commandIndex: number, desk: DeskState = emptyDesk, postedAt = ''): Result<StoredMapState, CommandRejection> {
  const reject = (code: CommandErrorCode, ...ticketIds: TicketId[]): Result<StoredMapState, CommandRejection> => ({
    kind: 'error', error: { stage: 'command', commandIndex, code, ticketIds },
  });
  if (command.kind === 'reopenRequest.close') {
    const r = desk.reopenRequests.find(r => r.requestId === command.requestId);
    if (!r) return reject('reopen_request_not_found');
    if (r.state !== 'pending' && r.state !== 'taken') return reject('reopen_request_inactive', r.ticketId);
    if (targetBinding(state, r.ticketId) === r.settlementIntroducedAtRevision) return reject('reopen_close_guard', r.ticketId);
    return { kind: 'ok', value: state };
  }
  if (command.kind === 'deskQuestion.post' || command.kind === 'deskQuestion.withdraw') {
    const ticket = state.tickets.find(t => t.id === command.ticketId);
    if (!ticket) return reject('ticket_not_found', command.ticketId);
    if (ticket.status !== 'open') return reject('ticket_not_open', ticket.id);
    if (ticket.claim === null) return reject('claim_required', ticket.id);
    if (ticket.claim !== command.claimantId) return reject('claim_mismatch', ticket.id);
    const active = activeQuestion(state, ticket.id);
    const questions = state.deskQuestions ?? [];
    if (command.kind === 'deskQuestion.withdraw') {
      if (!active || active.questionId !== command.questionId || active.questionVersion !== command.questionVersion) return reject('desk_question_not_found', ticket.id);
      return { kind: 'ok', value: { ...state, deskQuestions: questions.map(q => q === active
        ? { ...q, state: 'withdrawn', withdrawnReason: command.reason } : q) } };
    }
    if (active) return reject('desk_question_active', ticket.id);
    const previous = questions.filter(q => q.ticketId === ticket.id);
    if (questions.some(q => q.questionId === command.question.questionId && q.ticketId !== ticket.id)
      || previous.some(q => q.questionId !== command.question.questionId)) return reject('desk_question_identity_mismatch', ticket.id);
    const questionVersion = Math.max(0, ...previous.map(q => q.questionVersion)) + 1;
    return { kind: 'ok', value: { ...state, deskQuestions: [...questions, { ...command.question,
      ticketId: ticket.id, question: ticket.question, questionVersion, postedAt, state: 'published' }] } };
  }
  if (command.kind === 'map.update') return { kind: 'ok', value: { ...state, ...command.patch } };
  if (command.kind === 'content.add' || command.kind === 'content.update' || command.kind === 'content.remove') {
    const items = state[command.section];
    if (command.kind === 'content.add') {
      if ([...state.fog, ...state.scopeExclusions].some(item => item.id === command.item.id)) return reject('content_already_exists');
      return { kind: 'ok', value: { ...state, [command.section]: [...items, command.item] } };
    }
    const identity = command.kind === 'content.remove' ? command.itemId : command.item.id;
    if (!items.some(item => item.id === identity)) return reject('content_not_found');
    const updated = command.kind === 'content.remove' ? items.filter(item => item.id !== identity)
      : items.map(item => item.id === identity ? command.item : item);
    return { kind: 'ok', value: { ...state, [command.section]: updated } };
  }
  if (command.kind === 'ticket.create') {
    if (state.tickets.some(ticket => ticket.id === command.ticket.id)) return reject('ticket_already_exists', command.ticket.id);
    return { kind: 'ok', value: { ...state, tickets: [...state.tickets, {
      ...command.ticket, extensions: command.ticket.extensions ?? {}, prerequisites: [], status: 'open', claim: null,
    }] } };
  }
  const identity = command.kind === 'ticket.update' || command.kind === 'ticket.settle' || command.kind === 'ticket.reopen' || command.kind === 'claim.acquire' || command.kind === 'claim.release' || command.kind === 'claim.clear'
    ? command.ticketId : command.dependentId;
  const ticket = state.tickets.find(ticket => ticket.id === identity);
  if (!ticket) return reject('ticket_not_found', identity);
  if (command.kind === 'ticket.reopen') {
    if (ticket.status !== 'settled') return reject('ticket_not_settled', ticket.id);
    const { settlement: _old, ...descriptive } = ticket;
    const next = replaceTicket(state, { ...descriptive, status: 'open', claim: null });
    return { kind: 'ok', value: state.deskQuestions === undefined ? next : { ...next,
      deskQuestions: state.deskQuestions.map(q => q.ticketId === ticket.id && q.state === 'published' ? { ...q, state: 'superseded_by_reopen' } : q) } };
  }
  if (ticket.status !== 'open') return reject('ticket_not_open', ticket.id);
  if (command.kind === 'ticket.settle') {
    if (ticket.claim === null) return reject('claim_required', ticket.id);
    if (command.claimantId !== ticket.claim) return reject('claim_mismatch', ticket.id);
    if (ticket.prerequisites.some(identity => state.tickets.find(t => t.id === identity)?.status !== 'settled')) return reject('unsettled_dependency', ticket.id);
    if (ticket.type !== command.ticketType) return reject('settlement_type_mismatch', ticket.id);
    const q = activeQuestion(state, ticket.id);
    if (q && !command.deskAnswer) return reject('desk_answer_required', ticket.id);
    if (command.deskAnswer) {
      const a = q && currentAnswer(desk, q);
      if (!q || !a || a.answerId !== command.deskAnswer.answerId || a.questionVersion !== command.deskAnswer.questionVersion
        || a.state !== 'taken' || a.takenBy !== command.claimantId) return reject('desk_answer_invalid', ticket.id);
    }
    // Whole-input validation correlates outcome with command type; the gate above
    // also correlates that type with the actual Ticket before constructing storage.
    const { reopenedAtRevision: _reopen, ...descriptive } = ticket;
    const settled = { ...descriptive, status: 'settled', claim: null,
      settlement: { ...command.settlement, introducedAtRevision: state.currentRevision + 1, ...(command.deskAnswer ? { deskAnswer: command.deskAnswer } : {}) } } as StoredTicket;
    return { kind: 'ok', value: replaceTicket(state, settled) };
  }
  if (command.kind === 'claim.acquire') {
    if (ticket.claim !== null) return reject('ticket_already_claimed', ticket.id);
    if (!calculateFrontier(state).includes(ticket.id)) return reject('unsettled_dependency', ticket.id);
    return { kind: 'ok', value: replaceTicket(state, { ...ticket, claim: command.claimantId }) };
  }
  if (command.kind === 'claim.release' || command.kind === 'claim.clear') {
    if (ticket.claim === null) return reject('claim_not_found', ticket.id);
    const claimantId = command.kind === 'claim.clear' ? command.expectedClaimantId : command.claimantId;
    if (claimantId !== ticket.claim) return reject('claim_mismatch', ticket.id);
    return { kind: 'ok', value: replaceTicket(state, { ...ticket, claim: null }) };
  }
  if (ticket.claim !== null) {
    if (!command.claimantId) return reject('claim_required', ticket.id);
    if (command.claimantId !== ticket.claim) return reject('claim_mismatch', ticket.id);
  }
  let updated = ticket;
  if (command.kind === 'ticket.update') {
    if (activeQuestion(state, ticket.id) && ((command.patch.question !== undefined && command.patch.question !== ticket.question)
      || (command.patch.type !== undefined && command.patch.type !== ticket.type))) return reject('desk_question_active', ticket.id);
    updated = { ...ticket, ...command.patch };
  }
  else {
    if (!state.tickets.some(prerequisite => prerequisite.id === command.prerequisiteId)) return reject('ticket_not_found', command.prerequisiteId);
    if (command.dependentId === command.prerequisiteId) return reject('self_dependency', ticket.id);
    const exists = ticket.prerequisites.includes(command.prerequisiteId);
    if (command.kind === 'dependency.add' && exists) return reject('dependency_already_exists', ticket.id, command.prerequisiteId);
    if (command.kind === 'dependency.remove' && !exists) return reject('dependency_not_found', ticket.id, command.prerequisiteId);
    updated = { ...ticket, prerequisites: command.kind === 'dependency.add'
      ? [...ticket.prerequisites, command.prerequisiteId] : ticket.prerequisites.filter(identity => identity !== command.prerequisiteId) };
  }
  return { kind: 'ok', value: replaceTicket(state, updated) };
}

function replaceTicket(state: StoredMapState, updated: StoredTicket): StoredMapState {
  return { ...state, tickets: state.tickets.map(existing => existing.id === updated.id ? updated : existing) };
}
