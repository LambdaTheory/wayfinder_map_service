// Shared, side-effect-free B03b reviewer selection and maximum native invocation plan.
import type { AttemptRecord } from './evidence.ts';

export interface Reviewer { cli: 'codex' | 'claude'; model: string }
export interface ReviewCall { id: string; kind: 'availability' | 'review' | 'arbitration'; target: Reviewer; conditional: boolean }
export function reviewersFor(a: Pick<AttemptRecord, 'combination'>): { reviewer: Reviewer; arbiter: Reviewer } {
  const claude = a.combination.harness === 'claude' || /claude|sonnet|opus|haiku|fable/i.test(
    a.combination.visibleModel.known ? a.combination.visibleModel.value : a.combination.requestedModel);
  return claude ? { reviewer: { cli: 'codex', model: 'gpt-6.1-sol' }, arbiter: { cli: 'codex', model: 'gpt-6-astra' } }
    : { reviewer: { cli: 'claude', model: 'claude-sonnet-5-5' }, arbiter: { cli: 'claude', model: 'claude-opus-5-5' } };
}
export function reviewCalls(a: Pick<AttemptRecord, 'combination'>, hasItems = true): ReviewCall[] {
  if (!hasItems) return [];
  const { reviewer, arbiter } = reviewersFor(a);
  return [
    { id: 'reviewer-availability', kind: 'availability', target: reviewer, conditional: false },
    { id: 'arbiter-availability', kind: 'availability', target: arbiter, conditional: false },
    { id: 'reading-1', kind: 'review', target: reviewer, conditional: false },
    { id: 'reading-2', kind: 'review', target: reviewer, conditional: false },
    { id: 'arbitration', kind: 'arbitration', target: arbiter, conditional: true },
  ];
}
