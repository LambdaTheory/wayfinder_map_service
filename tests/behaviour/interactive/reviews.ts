// Coordinator-supplied review artifacts, kept separate from the assessment and bound to exact evidence.
import { createHash } from 'node:crypto';
import type { AttemptRecord } from '../evidence.ts';
import type { Review } from '../verdict.ts';
import { reviewProblem } from '../review-verdict.ts';
import { abilities, criteria, selectedNames } from './acceptance.ts';
import type { Ability, Assessment } from './acceptance.ts';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** One input bundle covers all four items, so two independent model invocations suffice per Attempt. */
export function reviewInput(record: AttemptRecord, assessment: Assessment): string {
  const { modelReviews: _untrustedAnnotations, ...attempt } = record;
  return JSON.stringify({ attempt, verdictVersion: assessment.verdictVersion, criteria, selection: assessment.selection }, null, 2);
}
export interface ReviewOutput {
  status: 'holds' | 'violated' | 'undecided';
  reason: string;
  evidence: { seq: number; quote: string; explanation: string }[];
}
export interface ReviewArtifact {
  ability: Ability;
  role: 'review' | 'arbitration';
  reviewer: string;
  sessionId: string;
  vendor: 'openai' | 'anthropic';
  model: string;
  input: string;
  output: string;
  /** Arbitration must retain the exact two independent outputs, in addition to the shared evidence input. */
  basis?: string[];
}
export interface VerifiedReviews { readonly verified: true }
const verified = new WeakMap<VerifiedReviews, { binding: string; readings: Review[] }>();
const binding = (record: AttemptRecord, assessment: Assessment) => digest(reviewInput(record, assessment));
const equivalentText = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]+/gu, '');

/** This is the only producer of a review handle. JSON cannot fabricate a handle or a human verdict. */
export function verifyReviews(record: AttemptRecord, assessment: Assessment, artifacts: ReviewArtifact[]): VerifiedReviews {
  const readings: Review[] = [];
  for (const ability of abilities) {
    const group = artifacts.filter(a => a.ability === ability);
    if (group.filter(a => a.role === 'review').length > 2 || group.filter(a => a.role === 'arbitration').length > 1) throw new Error('at most two independent readings and one arbitration per item');
    const seenReviewers = new Set<string>(); const seenSessions = new Set<string>(); const seenOutputs = new Set<string>();
    const reviewOutputs: string[] = [];
    const reviewStatuses: ReviewOutput['status'][] = [];
    for (const artifact of group.sort((a, b) => Number(a.role === 'arbitration') - Number(b.role === 'arbitration'))) {
      if (!['review', 'arbitration'].includes(artifact.role)) throw new Error('human verdicts cannot be imported from files');
      if (!artifact.reviewer?.trim() || !artifact.sessionId?.trim() || !artifact.model?.trim()) throw new Error('review identity is incomplete');
      if (artifact.vendor !== (record.combination.harness === 'claude' ? 'openai' : 'anthropic')) throw new Error('review must use the R4 other-vendor route');
      const expectedModel = record.combination.harness === 'claude' ? artifact.role === 'review' ? 'gpt-6.1-sol' : 'gpt-6-astra'
        : artifact.role === 'review' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      if (artifact.model !== expectedModel) throw new Error('review model does not match the approved R4 route');
      if (artifact.input !== reviewInput(record, assessment)) throw new Error('review input does not match this Attempt and selected native evidence');
      const parsed = JSON.parse(artifact.output) as ReviewOutput | { items: (ReviewOutput & { ability: Ability })[] };
      const output = 'items' in parsed ? parsed.items.find(item => item.ability === ability) : parsed;
      if (!output) throw new Error('review bundle omitted the capability');
      if (!['holds', 'violated', 'undecided'].includes(output.status) || !output.reason?.trim() || !Array.isArray(output.evidence)) throw new Error('invalid review output');
      const required = selectedNames(ability).map(n => assessment.selection[n]).filter((seq): seq is number => typeof seq === 'number');
      if (!required.length || required.some(seq => !output.evidence.some(e => e.seq === seq))) throw new Error('review does not cite the selected native events');
      for (const citation of output.evidence) {
        const event = record.events.find(e => e.seq === citation.seq);
        const content = event?.kind === 'message' ? event.text : event?.kind === 'tool-call' ? `${JSON.stringify(event.arguments)} ${event.result.known ? typeof event.result.value === 'string' ? event.result.value : JSON.stringify(event.result.value) : ''}` : '';
        // All selected events remain required. Additional quoted events can supply B03's same-turn corroboration.
        if (!event || event.actor === 'controller' || !citation.quote?.trim() || !citation.explanation?.trim() || !content.includes(citation.quote)) throw new Error('review quote lacks an explanation or is unrelated to native evidence');
      }
      const canonical = JSON.stringify({ status: output.status, reason: equivalentText(output.reason),
        evidence: [...output.evidence].map(e => ({ seq: e.seq, quote: equivalentText(e.quote) })).sort((a, b) => a.seq - b.seq) });
      if (seenReviewers.has(artifact.reviewer) || seenSessions.has(artifact.sessionId) || seenOutputs.has(canonical)) throw new Error('duplicate reviewer, review session or output cannot count as independent');
      seenReviewers.add(artifact.reviewer); seenSessions.add(artifact.sessionId); seenOutputs.add(canonical);
      if (artifact.role === 'arbitration' && (reviewOutputs.length !== 2 || JSON.stringify(artifact.basis) !== JSON.stringify(reviewOutputs))) throw new Error('arbitration needs both independent review outputs');
      if (artifact.role === 'arbitration' && reviewStatuses[0] !== 'undecided' && reviewStatuses[0] === reviewStatuses[1]) throw new Error('agreeing settled reviews cannot be arbitrated; only disagreement or undecided readings qualify');
      if (artifact.role === 'review') { reviewOutputs.push(artifact.output); reviewStatuses.push(output.status); }
      const support = output.evidence.map(citation => ({ location: `events[${record.events.findIndex(e => e.seq === citation.seq)}]`,
        quote: citation.quote, explanation: citation.explanation }));
      const reading: Review = { itemId: `${ability}.content`, role: artifact.role, by: `${artifact.vendor}/${artifact.model}/${artifact.reviewer}/${artifact.sessionId}`,
        readingId: artifact.sessionId, roundId: binding(record, assessment), evidence: support.map(s => s.location), support,
        ...(artifact.role === 'arbitration' ? { basedOn: group.filter(a => a.role === 'review').map(a => a.sessionId) } : {}),
        status: output.status, reason: output.reason };
      const problem = reviewProblem(reading, record);
      readings.push(problem ? { ...reading, rejected: problem } : reading);
    }
  }
  const handle: VerifiedReviews = Object.freeze({ verified: true });
  verified.set(handle, { binding: binding(record, assessment), readings });
  return handle;
}

export function verifiedReadings(record: AttemptRecord, assessment: Assessment, handle?: VerifiedReviews): Review[] {
  const result = handle ? verified.get(handle) : undefined;
  return result?.binding === binding(record, assessment) ? result.readings : [];
}
