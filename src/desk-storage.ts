// Internal application seam for the keyed browser and release coordinator; never an MCP write tool.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ClaimantId, MapId, Revision, TicketId } from './types.js';
import type { AnswerItem, DeskChoice, DeskState, ReadDelivery, ReopenChoice, ReopenItem } from './desk-types.js';
import { activeQuestion, affectedSettlementRevisions, answerItem, currentAnswer, projectDesk, targetBinding } from './desk-domain.js';
import { immutableClone } from './immutable.js';
import { isPlainObject, validateId, validateObject } from './values.js';
import { positiveVersion } from './desk-input.js';

export interface AnswerSubmission { readonly questionId: string; readonly questionVersion: number; readonly choice: { readonly option: 1 | 2 | 3 } | { readonly text: string } }
export interface ReopenSubmission {
  readonly ticketId: TicketId; readonly settlementIntroducedAtRevision: number; readonly affectedTickets: readonly TicketId[];
  readonly affectedSettlementRevisions: Readonly<Record<TicketId, number>>; readonly requested: ReopenChoice;
}
export type DeskFailure = { readonly kind: 'rejected'; readonly code: 'invalid_input' | 'question_changed' | 'list_changed' | 'request_not_pending' | 'request_not_found' }
  | { readonly kind: 'not_found'; readonly code: 'map_not_found'; readonly mapId: MapId };
export type DeskWrite<T> = { readonly kind: 'updated'; readonly value: T } | DeskFailure;
export interface DeskStorage {
  read(mapId: MapId): DeskState;
  inspect(mapId: MapId): { readonly kind: 'found'; readonly revision: Revision; readonly desk: ReturnType<typeof projectDesk> } | DeskFailure;
  submitAnswers(mapId: MapId, submissions: readonly AnswerSubmission[]): DeskWrite<readonly AnswerItem[]>;
  fileReopenRequest(mapId: MapId, submission: ReopenSubmission): DeskWrite<ReopenItem>;
  cancelReopenRequest(mapId: MapId, requestId: string): DeskWrite<null>;
  takeEligible(mapId: MapId, claimantId: ClaimantId): DeskWrite<ReadDelivery>;
}
interface TransactionState { readonly revision: Revision; readonly desk: DeskState }
type Transition<T> = DeskWrite<T> & { readonly nextDesk?: DeskState };
export interface DeskBackend {
  read(mapId: MapId): DeskState;
  inspect(mapId: MapId): TransactionState | undefined;
  transaction<T>(mapId: MapId, operation: (current: TransactionState) => Transition<T>): DeskWrite<T>;
  now(): string;
}
const rejected = (code: Extract<DeskFailure, {kind: 'rejected'}>['code']): DeskFailure => ({ kind: 'rejected', code });
const quiet = (now: string) => new Date(Date.parse(now) + 15_000).toISOString();
function validChoice(raw: unknown, reopen: boolean): boolean {
  if (validateObject(raw, []) || !isPlainObject(raw)) return false;
  if (Object.hasOwn(raw, 'text')) return !validateObject(raw, [], ['text']) && typeof raw.text === 'string' && !!raw.text.trim();
  return !validateObject(raw, [], reopen ? ['option', 'label', 'questionId', 'questionVersion'] : ['option'])
    && [1, 2, 3].includes(raw.option as number) && (!reopen || (typeof raw.label === 'string' && !!raw.label.trim()
      && !validateId(raw.questionId, []) && !positiveVersion(raw.questionVersion, [])));
}
export function createDeskStorage(backend: DeskBackend): DeskStorage {
  return {
    read: mapId => immutableClone(backend.read(mapId)),
    inspect(mapId) {
      if (validateId(mapId, [])) return rejected('invalid_input');
      const current = backend.inspect(mapId);
      return current ? immutableClone({ kind: 'found', revision: current.revision, desk: projectDesk(current.revision.state, current.desk) })
        : { kind: 'not_found', code: 'map_not_found', mapId };
    },
    submitAnswers(mapId, submissions) {
      if (validateId(mapId, []) || !Array.isArray(submissions) || !submissions.length || submissions.some(s =>
        validateObject(s, [], ['questionId', 'questionVersion', 'choice']) || !isPlainObject(s)
        || validateId(s.questionId, []) || positiveVersion(s.questionVersion, []) || !validChoice(s.choice, false))
        || new Set(submissions.map(s => s.questionId)).size !== submissions.length) return rejected('invalid_input');
      return backend.transaction(mapId, ({ revision, desk }) => {
        const now = backend.now(); let answers = [...desk.answers]; const items: AnswerItem[] = [];
        for (const s of submissions) {
          const q = revision.state.deskQuestions?.find(q => q.questionId === s.questionId && q.questionVersion === s.questionVersion);
          if (!q || activeQuestion(revision.state, q.ticketId) !== q) return rejected('question_changed');
          let choice: DeskChoice;
          if ('option' in s.choice) {
            const option = q.options[s.choice.option - 1]; if (!option) return rejected('invalid_input');
            choice = { option: s.choice.option, label: option.label };
          } else choice = { text: s.choice.text };
          const answerId = randomUUID(); const old = currentAnswer(desk, q);
          if (old) answers = answers.map(a => a.answerId === old.answerId ? { ...a, supersededBy: answerId } : a);
          const item: AnswerItem = { kind: 'answer', answerId, questionId: q.questionId, questionVersion: q.questionVersion, ticketId: q.ticketId, choice, answeredAt: now };
          items.push(item); answers.push({ ...item, state: 'answered' });
        }
        return { kind: 'updated', value: items, nextDesk: { ...desk, answers, quietUntil: quiet(now) } };
      });
    },
    fileReopenRequest(mapId, s) {
      if (validateId(mapId, []) || validateObject(s, [], ['ticketId', 'settlementIntroducedAtRevision', 'affectedTickets', 'affectedSettlementRevisions', 'requested'])
        || !isPlainObject(s) || validateId(s.ticketId, []) || positiveVersion(s.settlementIntroducedAtRevision, [])
        || !Array.isArray(s.affectedTickets) || s.affectedTickets.some(id => validateId(id, []))
        || new Set(s.affectedTickets).size !== s.affectedTickets.length || validateObject(s.affectedSettlementRevisions, [])
        || !isPlainObject(s.affectedSettlementRevisions) || Object.entries(s.affectedSettlementRevisions).some(([id, rev]) => validateId(id, []) || positiveVersion(rev, []))
        || !validChoice(s.requested, true)) return rejected('invalid_input');
      return backend.transaction(mapId, ({ revision, desk }) => {
        const state = revision.state; const affected = affectedSettlementRevisions(state, s.ticketId);
        if (targetBinding(state, s.ticketId) !== s.settlementIntroducedAtRevision
          || !isDeepStrictEqual(Object.keys(affected).sort(), [...s.affectedTickets].sort())
          || !isDeepStrictEqual(affected, s.affectedSettlementRevisions)) return rejected('list_changed');
        if ('option' in s.requested) {
          const choice = s.requested; const ticket = state.tickets.find(t => t.id === s.ticketId)!;
          const citation = ticket.status === 'settled' ? ticket.settlement.deskAnswer : undefined;
          const answer = citation && desk.answers.find(a => a.answerId === citation.answerId);
          const q = state.deskQuestions?.find(q => q.ticketId === s.ticketId && q.questionId === choice.questionId && q.questionVersion === choice.questionVersion);
          if (!answer || !q || answer.questionId !== q.questionId || answer.questionVersion !== q.questionVersion || q.options[choice.option - 1]?.label !== choice.label) return rejected('invalid_input');
        }
        const now = backend.now(); const requestId = randomUUID();
        const item: ReopenItem = { kind: 'reopen_request', requestId, ...s, requestedAt: now };
        return { kind: 'updated', value: item, nextDesk: { ...desk, quietUntil: quiet(now), reopenRequests: [
          ...desk.reopenRequests.map(r => r.ticketId === s.ticketId && (r.state === 'pending' || r.state === 'taken') ? { ...r, state: 'superseded' as const, supersededBy: requestId } : r),
          { ...item, state: 'pending' },
        ] } };
      });
    },
    cancelReopenRequest(mapId, requestId) {
      if (validateId(mapId, []) || validateId(requestId, [])) return rejected('invalid_input');
      return backend.transaction(mapId, ({ desk }) => {
        const r = desk.reopenRequests.find(r => r.requestId === requestId);
        if (!r) return rejected('request_not_found');
        if (r.state !== 'pending') return rejected('request_not_pending');
        return { kind: 'updated', value: null, nextDesk: { ...desk, quietUntil: quiet(backend.now()),
          reopenRequests: desk.reopenRequests.map(r => r.requestId === requestId ? { ...r, state: 'cancelled' } : r) } };
      });
    },
    takeEligible(mapId, claimantId) {
      if (validateId(mapId, []) || validateId(claimantId, [])) return rejected('invalid_input');
      return backend.transaction(mapId, ({ revision, desk }): Transition<ReadDelivery> => {
        if (desk.quietUntil && desk.quietUntil > backend.now()) return { kind: 'updated', value: { outcome: 'none_yet', items: [], quietUntil: desk.quietUntil } };
        const eligible = desk.answers.filter(a => {
          const q = activeQuestion(revision.state, a.ticketId);
          return a.state === 'answered' && !a.supersededBy && q?.questionId === a.questionId && q.questionVersion === a.questionVersion
            && revision.state.tickets.find(t => t.id === a.ticketId)?.claim === claimantId;
        });
        const requests = desk.reopenRequests.filter(r => r.state === 'pending');
        const items = [...eligible.map(answerItem), ...requests.map(r => {
          const { state: _state, takenBy: _taken, handledAtRevision: _handled, closedReason: _reason, supersededBy: _superseded, ...item } = r;
          return item;
        })];
        return { kind: 'updated', value: { outcome: items.length ? 'delivered' : 'none_yet', items }, nextDesk: { ...desk,
          answers: desk.answers.map(a => eligible.includes(a) ? { ...a, state: 'taken', takenBy: claimantId } : a),
          reopenRequests: desk.reopenRequests.map(r => requests.includes(r) ? { ...r, state: 'taken', takenBy: claimantId } : r),
        } };
      });
    },
  };
}
