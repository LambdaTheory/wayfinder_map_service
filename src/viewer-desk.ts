import type { SQLiteStorage } from './sqlite-storage.js';
import type { MapId } from './types.js';
import type { AnswerSubmission, ReopenSubmission } from './desk-storage.js';
import { affectedSettlementRevisions } from './desk-domain.js';
import { isPlainObject, validateId, validateObject } from './values.js';

export function inspectViewerDesk(storage: SQLiteStorage, mapId: MapId) {
  const current = storage.desk.inspect(mapId);
  if (current.kind !== 'found') return undefined;
  const { revision, desk } = current;
  const reopenTargets = revision.state.tickets.flatMap(ticket => {
    if (ticket.status !== 'settled') return [];
    const affected = affectedSettlementRevisions(revision.state, ticket.id);
    const source = desk.deskQuestions.find(q => q.ticketId === ticket.id
      && 'answerHistory' in q && q.answerHistory.some(a => a.answerId === ticket.settlement.deskAnswer?.answerId));
    return [{ ticketId: ticket.id, title: ticket.title, settlement: ticket.settlement,
      settlementIntroducedAtRevision: ticket.settlement.introducedAtRevision,
      affectedTickets: Object.keys(affected), affectedSettlementRevisions: affected,
      affectedDetails: revision.state.tickets.filter(t => Object.hasOwn(affected, t.id)).map(t => ({ ticketId: t.id, title: t.title })),
      ...(source ? { source: { questionId: source.questionId, questionVersion: source.questionVersion, options: source.options } } : {}),
    }];
  });
  return { revision, desk: { ...desk, reopenTargets, quietUntil: storage.desk.read(mapId).quietUntil ?? null } };
}

// This whitelist cannot express Map commands, delivery, or agent Settlement.
export function writeViewerDesk(storage: SQLiteStorage, input: unknown) {
  const invalid = { kind: 'rejected', code: 'invalid_input' } as const;
  if (!isPlainObject(input) || validateId(input.mapId, [])) return invalid;
  const mapId = input.mapId as MapId;
  if (input.action === 'answer' && !validateObject(input, [], ['action', 'mapId', 'submissions'])) {
    if (Array.isArray(input.submissions) && input.submissions.length > 1) {
      const current = storage.desk.inspect(mapId);
      if (current.kind !== 'found') return current;
      for (const submission of input.submissions) {
        if (!isPlainObject(submission)) return invalid;
        const q = current.desk.deskQuestions.find(q => q.questionId === submission.questionId && q.questionVersion === submission.questionVersion);
        if (!q || q.state !== 'pending') return { kind: 'rejected', code: 'question_changed' } as const;
        if (q.triage !== 'followRecommendation' || !isPlainObject(submission.choice) || submission.choice.option !== q.recommendedOption) return invalid;
      }
    }
    return storage.desk.submitAnswers(mapId, input.submissions as readonly AnswerSubmission[]);
  }
  if (input.action === 'reopen' && !validateObject(input, [], ['action', 'mapId', 'submission'])) {
    return storage.desk.fileReopenRequest(mapId, input.submission as ReopenSubmission);
  }
  if (input.action === 'cancelReopen' && !validateObject(input, [], ['action', 'mapId', 'requestId'])) {
    return storage.desk.cancelReopenRequest(mapId, input.requestId as string);
  }
  return invalid;
}
