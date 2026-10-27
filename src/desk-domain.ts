import type { ApplyRequest, Command, CommandErrorCode, CommandRejection, StoredMapState, TicketId } from './types.js';
import type { AnswerItem, DeskAnswer, DeskQuestion, DeskState, ReopenContext } from './desk-types.js';

export function activeQuestion(state: StoredMapState, ticketId: TicketId): DeskQuestion | undefined {
  if (state.tickets.find(t => t.id === ticketId)?.status !== 'open') return undefined;
  return state.deskQuestions?.find(q => q.ticketId === ticketId && q.state === 'published');
}
export function currentAnswer(desk: DeskState, q: DeskQuestion): DeskAnswer | undefined {
  return desk.answers.find(a => a.questionId === q.questionId && a.questionVersion === q.questionVersion && a.ticketId === q.ticketId && !a.supersededBy);
}
export function answerItem(a: AnswerItem): AnswerItem {
  return { kind: 'answer', answerId: a.answerId, questionId: a.questionId, questionVersion: a.questionVersion,
    ticketId: a.ticketId, choice: a.choice, answeredAt: a.answeredAt };
}
export function targetBinding(state: StoredMapState, ticketId: TicketId): number | undefined {
  const ticket = state.tickets.find(t => t.id === ticketId);
  return ticket?.status === 'settled' ? ticket.settlement.introducedAtRevision : undefined;
}
export function downstreamTickets(state: StoredMapState, ticketId: TicketId): readonly TicketId[] {
  const seen = new Set<TicketId>([ticketId]); const queue = [ticketId];
  for (const parent of queue) for (const ticket of state.tickets) {
    if (ticket.prerequisites.includes(parent) && !seen.has(ticket.id)) { seen.add(ticket.id); queue.push(ticket.id); }
  }
  seen.delete(ticketId); return [...seen].sort();
}
export function affectedSettledTickets(state: StoredMapState, ticketId: TicketId): readonly TicketId[] {
  return downstreamTickets(state, ticketId).filter(id => targetBinding(state, id) !== undefined);
}
export function affectedSettlementRevisions(state: StoredMapState, ticketId: TicketId): Readonly<Record<TicketId, number>> {
  return Object.fromEntries(affectedSettledTickets(state, ticketId).map(id => [id, targetBinding(state, id)!]));
}
export function requestRejection(code: CommandErrorCode, ticketIds: readonly TicketId[], commandIndex = 0): CommandRejection {
  return { stage: 'command', code, commandIndex, ticketIds };
}
export function validateReopenCitation(state: StoredMapState, desk: DeskState, request: ApplyRequest): CommandRejection | undefined {
  if (!request.reopenRequestId) return undefined;
  const r = desk.reopenRequests.find(r => r.requestId === request.reopenRequestId);
  if (!r) return requestRejection('reopen_request_not_found', []);
  if (r.state === 'pending') return requestRejection('reopen_request_pending', [r.ticketId]);
  if (r.state === 'handled') return requestRejection('reopen_request_handled', [r.ticketId]);
  if (r.state !== 'taken') return requestRejection('reopen_request_inactive', [r.ticketId]);
  if (targetBinding(state, r.ticketId) !== r.settlementIntroducedAtRevision) return requestRejection('reopen_request_stale', [r.ticketId]);
  const reopens = request.commands.filter(c => c.kind === 'ticket.reopen').map(c => c.ticketId);
  if (!reopens.includes(r.ticketId)) return requestRejection('reopen_target_omitted', [r.ticketId]);
  const required = affectedSettledTickets(state, r.ticketId);
  const uncoveredTickets = required.flatMap<{ ticketId: TicketId; reason: 'not_listed' | 'settlement_changed' }>(ticketId => !r.affectedTickets.includes(ticketId)
    ? [{ ticketId, reason: 'not_listed' as const }]
    : targetBinding(state, ticketId) !== r.affectedSettlementRevisions[ticketId] ? [{ ticketId, reason: 'settlement_changed' as const }] : []);
  if (uncoveredTickets.length) return { ...requestRejection('reopen_authorization_exceeded', uncoveredTickets.map(t => t.ticketId)), uncoveredTickets };
  const expected = new Set([r.ticketId, ...required]);
  if (reopens.length !== expected.size || reopens.some(id => !expected.has(id))) return requestRejection('reopen_set_mismatch', [...expected].sort());
}

// Run after each successful graph command. These changes never enter a Map snapshot.
export function deskEffects(before: StoredMapState, desk: DeskState, command: Command): DeskState {
  if (command.kind === 'claim.release' || command.kind === 'claim.clear') {
    const q = activeQuestion(before, command.ticketId);
    if (!q) return desk;
    const a = currentAnswer(desk, q);
    if (!a || a.state !== 'taken') return desk;
    return { ...desk, answers: desk.answers.map(answer => {
      if (answer.answerId !== a.answerId) return answer;
      const { takenBy: _taken, ...rest } = answer; return { ...rest, state: 'answered' };
    }) };
  }
  if (command.kind === 'reopenRequest.close') return { ...desk, reopenRequests: desk.reopenRequests.map(r => r.requestId === command.requestId
    ? { ...r, state: 'closed', closedReason: command.reason } : r) };
  return desk;
}
export function handleReopen(desk: DeskState, request: ApplyRequest, revision: number): DeskState {
  if (!request.reopenRequestId) return desk;
  return { ...desk, reopenRequests: desk.reopenRequests.map(r => r.requestId === request.reopenRequestId
    ? { ...r, state: 'handled', handledAtRevision: revision } : r) };
}
export function reopenContexts(state: StoredMapState, desk: DeskState): readonly ReopenContext[] {
  return state.tickets.flatMap(ticket => {
    if (ticket.status !== 'open' || ticket.reopenedAtRevision === undefined) return [];
    const r = desk.reopenRequests.find(r => r.ticketId === ticket.id && r.state === 'handled' && r.handledAtRevision === ticket.reopenedAtRevision);
    return r ? [{ ticketId: ticket.id, requestId: r.requestId, requested: r.requested, handledAtRevision: r.handledAtRevision! }] : [];
  });
}
function requestedOption(state: StoredMapState, q: DeskQuestion, context: ReopenContext | undefined): number | undefined {
  if (!context || !('option' in context.requested)) return undefined;
  const choice = context.requested;
  const source = state.deskQuestions?.find(p => p.questionId === choice.questionId && p.questionVersion === choice.questionVersion);
  const option = source?.options[choice.option - 1];
  if (!option) return undefined;
  const matches = q.options.flatMap((candidate, i) => candidate.label === option.label && candidate.description === option.description ? [i + 1] : []);
  return matches.length === 1 ? matches[0] : undefined;
}
export function projectDesk(state: StoredMapState, desk: DeskState, historical = false) {
  if (historical) return { deskQuestions: state.deskQuestions ?? [] };
  const contexts = reopenContexts(state, desk);
  const questions = (state.deskQuestions ?? []).map(q => {
    const ticket = state.tickets.find(t => t.id === q.ticketId)!;
    const answer = q.state === 'published' ? currentAnswer(desk, q) : undefined;
    const stateName = q.state !== 'published' ? q.state : ticket.status === 'settled' ? 'settled' : answer?.state ?? 'pending';
    const immediateUnlocks = state.tickets.filter(t => t.status === 'open' && t.claim === null && t.prerequisites.includes(q.ticketId)
      && t.prerequisites.every(id => id === q.ticketId || targetBinding(state, id) !== undefined)).length;
    const downstreamUnsettled = downstreamTickets(state, q.ticketId).filter(id => targetBinding(state, id) === undefined).length;
    const marker = q.state === 'published' && ticket.status === 'open' ? requestedOption(state, q, contexts.find(c => c.ticketId === q.ticketId)) : undefined;
    return { ...q, state: stateName, currentAnswer: answer ? answerItem(answer) : null,
      answerHistory: desk.answers.filter(a => a.questionId === q.questionId && a.questionVersion === q.questionVersion).map(a => ({
        ...answerItem(a), state: a.state, stale: !!a.supersededBy || q.state !== 'published',
      })), immediateUnlocks, downstreamUnsettled,
      ...(marker === undefined ? {} : { requestedOption: marker }) };
  });
  questions.sort((a, b) => Number(b.immediateUnlocks > 0 || b.gatesResearch) - Number(a.immediateUnlocks > 0 || a.gatesResearch)
    || b.immediateUnlocks - a.immediateUnlocks || b.downstreamUnsettled - a.downstreamUnsettled
    || Number(b.triage === 'needsKun') - Number(a.triage === 'needsKun')
    || compare(a.postedAt, b.postedAt) || compare(a.questionId, b.questionId) || a.questionVersion - b.questionVersion);
  return { deskQuestions: questions, reopenContexts: contexts,
    reopenRequests: desk.reopenRequests.filter(r => r.state === 'pending' || r.state === 'taken').map(r => ({
      requestId: r.requestId, ticketId: r.ticketId, settlementIntroducedAtRevision: r.settlementIntroducedAtRevision,
      requested: r.requested, affectedTickets: r.affectedTickets, affectedSettlementRevisions: r.affectedSettlementRevisions,
      requestedAt: r.requestedAt, state: r.state as 'pending' | 'taken', stale: targetBinding(state, r.ticketId) !== r.settlementIntroducedAtRevision,
    })) };
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
