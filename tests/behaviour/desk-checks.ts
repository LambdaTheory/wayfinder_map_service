import { agentRevisions, holds, need, notObserved, unknown } from './checks.ts';
import type { ChangeFilter } from './checks.ts';
import type { ScriptCheck } from './scenario.ts';

/** Change subjects are question IDs, never Ticket IDs. The immutable publication binds them. */
export const deskPost = (ticketId: string, turn?: number): ChangeFilter => ({
  command: 'deskQuestion.post', ...(turn === undefined ? {} : { turn }),
  where: (r, c) => !!r.rev.state.deskQuestions?.some(q => q.questionId === c.subjectId && q.ticketId === ticketId),
});

/** The last committed state before the input, not merely a historical post. */
export function activeDeskBefore(turn: number, mapId: string, ticketIds?: string[]): ScriptCheck {
  return a => {
    const gap = need(a, 'active desk at input', 'maps', 'receipts');
    if (gap) return gap;
    const revisions = agentRevisions(a).filter(r => r.map === mapId);
    if (revisions.some(r => r.turn === null)) return unknown('cannot place desk state at the input boundary', revisions.map(r => r.locator));
    const before = revisions.filter(r => r.turn! < turn).at(-1);
    const map = a.maps.find(m => m.mapId === mapId);
    const state = before?.rev.state ?? map?.history.findLast(r => r.revision <= (map.seedHeadRevision ?? 0))?.state;
    if (!state?.deskQuestions) return unknown('desk publications not captured');
    const active = state.deskQuestions.filter(q => q.state === 'published' && state.tickets.some(t => t.id === q.ticketId && t.status === 'open'));
    const evidence = before ? [before.locator] : [];
    return (ticketIds ? ticketIds.every(id => active.some(q => q.ticketId === id)) : active.length > 0)
      ? holds('active questions exist before the input', evidence) : notObserved('no required active questions at the input boundary', evidence);
  };
}
