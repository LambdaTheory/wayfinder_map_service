import type { ClaimantId, RevisionNumber, TicketId } from './types.js';

export interface DeskOption { readonly label: string; readonly description: string }
export interface DeskQuestionInput {
  readonly questionId: string;
  readonly options: readonly DeskOption[];
  readonly recommendedOption: 1 | 2 | 3;
  readonly recommendedAnswer: string;
  readonly whyKun: string;
  readonly triage: 'needsKun' | 'followRecommendation';
  readonly triageReason: string;
  readonly gatesResearch: boolean;
}
export interface DeskQuestion extends DeskQuestionInput {
  readonly question: string;
  readonly ticketId: TicketId;
  readonly questionVersion: number;
  readonly postedAt: string;
  readonly state: 'published' | 'withdrawn' | 'superseded_by_reopen';
  readonly withdrawnReason?: string;
}
export type DeskCommand =
  | { readonly kind: 'deskQuestion.post'; readonly ticketId: TicketId; readonly claimantId: ClaimantId; readonly question: DeskQuestionInput }
  | { readonly kind: 'deskQuestion.withdraw'; readonly ticketId: TicketId; readonly claimantId: ClaimantId;
      readonly questionId: string; readonly questionVersion: number; readonly reason: string }
  | { readonly kind: 'reopenRequest.close'; readonly requestId: string; readonly reason: string };
export interface DeskAnswerCitation { readonly answerId: string; readonly questionVersion: number }
export type DeskChoice = { readonly option: 1 | 2 | 3; readonly label: string } | { readonly text: string };
export type ReopenChoice = (Extract<DeskChoice, {option: number}> & { readonly questionId: string; readonly questionVersion: number }) | { readonly text: string };
export interface AnswerItem {
  readonly kind: 'answer'; readonly answerId: string; readonly questionId: string; readonly questionVersion: number;
  readonly ticketId: TicketId; readonly choice: DeskChoice; readonly answeredAt: string;
}
export interface DeskAnswer extends AnswerItem {
  readonly state: 'answered' | 'taken'; readonly takenBy?: ClaimantId; readonly supersededBy?: string;
}
export interface ReopenItem {
  readonly kind: 'reopen_request'; readonly requestId: string; readonly ticketId: TicketId;
  readonly settlementIntroducedAtRevision: RevisionNumber; readonly requested: ReopenChoice;
  readonly affectedTickets: readonly TicketId[];
  readonly affectedSettlementRevisions: Readonly<Record<TicketId, RevisionNumber>>;
  readonly requestedAt: string;
}
export interface ReopenRequest extends ReopenItem {
  readonly state: 'pending' | 'taken' | 'handled' | 'closed' | 'cancelled' | 'superseded';
  readonly takenBy?: ClaimantId; readonly handledAtRevision?: RevisionNumber;
  readonly closedReason?: string; readonly supersededBy?: string;
}
export interface DeskState {
  readonly answers: readonly DeskAnswer[];
  readonly reopenRequests: readonly ReopenRequest[];
  readonly quietUntil?: string;
}
export const emptyDesk: DeskState = Object.freeze({ answers: Object.freeze([]), reopenRequests: Object.freeze([]) });
export interface ReopenContext {
  readonly ticketId: TicketId; readonly requestId: string; readonly requested: ReopenChoice; readonly handledAtRevision: RevisionNumber;
}
export type DeliveryItem = AnswerItem | ReopenItem;
export interface ReadDelivery {
  readonly outcome: 'delivered' | 'none_yet'; readonly items: readonly DeliveryItem[]; readonly quietUntil?: string;
}
