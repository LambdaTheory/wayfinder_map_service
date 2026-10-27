import type { DeskAnswerCitation, DeskCommand, DeskQuestion } from './desk-types.js';
declare const idBrand: unique symbol;
export type Id<K extends string> = string & { readonly [idBrand]: K };
export type MapId = Id<'Map'>;
export type TicketId = Id<'Ticket'>;
export type ClaimantId = Id<'Claimant'>;
export type ContentId = Id<'Content'>;
export type ActorId = Id<'Actor'>;
export type ClientId = Id<'Client'>;
export type RevisionNumber = number;
export type JsonValue = null | boolean | number | string
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Extensions = Readonly<Record<string, JsonValue>>;
export type NonEmpty<T> = readonly [T, ...T[]];
export type Result<T, E> = { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: E };
export interface InvalidInput {
  readonly code: 'invalid_input';
  readonly path: readonly (string | number)[];
  readonly constraint: string;
}
export type TicketType = 'grilling' | 'prototype' | 'research' | 'task';
export interface Reference { readonly locator: string; readonly label?: string }
export interface Provenance { readonly method: string; readonly sources: readonly Reference[] }
export interface Evidence {
  readonly statement: string;
  readonly references: readonly Reference[];
  readonly provenance?: Provenance;
  readonly extensions: Extensions;
}
export interface Decision { readonly kind: 'decision'; readonly statement: string; readonly rationale: string }
export interface Finding { readonly kind: 'finding'; readonly statement: string; readonly limitations?: string }
export interface Completion {
  readonly kind: 'completion';
  readonly statement: string;
  readonly resultingFacts?: Readonly<Record<string, JsonValue>>;
}
export type OutcomeByType = {
  grilling: Decision; prototype: Decision; research: Finding; task: Completion;
};
export interface Settlement<T extends TicketType> {
  readonly outcome: OutcomeByType[T];
  readonly evidence: readonly Evidence[];
  readonly references: readonly Reference[];
  readonly provenance: Provenance;
  readonly extensions: Extensions;
}
export type StoredSettlement<T extends TicketType> = Settlement<T> & {
  readonly introducedAtRevision: RevisionNumber;
  readonly deskAnswer?: DeskAnswerCitation;
};
export interface TicketBase<T extends TicketType> {
  readonly id: TicketId;
  readonly title: string;
  readonly question: string;
  readonly type: T;
  readonly prerequisites: readonly TicketId[];
  readonly extensions: Extensions;
}
export type StoredTicket = {
  [T in TicketType]: TicketBase<T> & (
    | { readonly status: 'open'; readonly claim: ClaimantId | null; readonly reopenedAtRevision?: RevisionNumber }
    | { readonly status: 'settled'; readonly claim: null; readonly settlement: StoredSettlement<T> }
  )
}[TicketType];
export interface MapContent {
  readonly id: ContentId;
  readonly text: string;
  readonly references: readonly Reference[];
}
export interface StoredMapState {
  readonly id: MapId;
  readonly title: string;
  readonly destination: string;
  readonly notes: string;
  readonly fog: readonly MapContent[];
  readonly scopeExclusions: readonly MapContent[];
  readonly tickets: readonly StoredTicket[];
  readonly extensions: Extensions;
  readonly currentRevision: RevisionNumber;
  readonly deskQuestions?: readonly DeskQuestion[];
}
export interface MutationAuthor {
  readonly actorId: ActorId;
  readonly clientId: ClientId;
  readonly occurredAt: string;
}
export interface CreateMapInput {
  readonly id: MapId;
  readonly title: string;
  readonly destination: string;
  readonly notes?: string;
  readonly extensions?: Extensions;
  readonly author: MutationAuthor;
}
// Command subset grows with the accepted implementation slices.
export type MapPatch = Readonly<Partial<Pick<StoredMapState, 'title' | 'destination' | 'notes' | 'extensions'>>>;
export interface TicketInput {
  readonly id: TicketId;
  readonly title: string;
  readonly question: string;
  readonly type: TicketType;
  readonly extensions?: Extensions;
}
export type Access = { readonly claimantId?: ClaimantId };
export type TicketPatch = Readonly<Partial<Pick<TicketInput, 'title' | 'question' | 'type' | 'extensions'>>>;
export type SettleCommand = {
  [T in TicketType]: { readonly kind: 'ticket.settle'; readonly ticketId: TicketId; readonly ticketType: T;
    readonly claimantId: ClaimantId; readonly settlement: Settlement<T>; readonly deskAnswer?: DeskAnswerCitation }
}[TicketType];
export type Command = { readonly kind: 'map.update'; readonly patch: MapPatch }
  | DeskCommand
  | SettleCommand
  | { readonly kind: 'ticket.reopen'; readonly ticketId: TicketId; readonly reason: string }
  | (({ readonly kind: 'claim.acquire' } | { readonly kind: 'claim.release'; readonly reason?: string }) & {
    readonly ticketId: TicketId; readonly claimantId: ClaimantId;
  })
  | { readonly kind: 'claim.clear'; readonly ticketId: TicketId; readonly expectedClaimantId: ClaimantId; readonly reason: string }
  | { readonly kind: 'ticket.create'; readonly ticket: TicketInput }
  | ({ readonly kind: 'ticket.update'; readonly ticketId: TicketId; readonly patch: TicketPatch } & Access)
  | ({ readonly kind: 'dependency.add' | 'dependency.remove'; readonly dependentId: TicketId; readonly prerequisiteId: TicketId } & Access)
  | (({ readonly kind: 'content.add' } | { readonly kind: 'content.update' }) & {
    readonly section: 'fog' | 'scopeExclusions'; readonly item: MapContent;
  })
  | { readonly kind: 'content.remove'; readonly section: 'fog' | 'scopeExclusions'; readonly itemId: ContentId };
export interface ApplyRequest {
  readonly mapId: MapId;
  readonly expectedRevision: RevisionNumber;
  readonly author: MutationAuthor;
  readonly commands: NonEmpty<Command>;
  readonly reopenRequestId?: string;
}
export type CommandErrorCode = 'ticket_already_exists' | 'ticket_not_found' | 'ticket_not_open' | 'claim_required' | 'claim_mismatch'
  | 'ticket_already_claimed' | 'unsettled_dependency' | 'claim_not_found' | 'settlement_type_mismatch' | 'ticket_not_settled'
  | 'desk_question_active' | 'desk_question_not_found' | 'desk_question_identity_mismatch' | 'desk_answer_required' | 'desk_answer_invalid'
  | 'reopen_request_not_found' | 'reopen_request_pending' | 'reopen_request_handled' | 'reopen_request_inactive' | 'reopen_request_stale'
  | 'reopen_target_omitted' | 'reopen_set_mismatch' | 'reopen_authorization_exceeded' | 'reopen_close_guard'
  | 'self_dependency' | 'dependency_already_exists' | 'dependency_not_found' | 'content_already_exists' | 'content_not_found';
export type CommandRejection = { readonly stage: 'command'; readonly commandIndex: number;
  readonly code: CommandErrorCode; readonly ticketIds: readonly TicketId[];
  readonly uncoveredTickets?: readonly { readonly ticketId: TicketId; readonly reason: 'not_listed' | 'settlement_changed' }[] };
export type InvariantErrorCode = 'dependency_cycle' | 'dangling_dependency'
  | 'settled_ticket_has_open_prerequisite' | 'claimed_ticket_has_open_prerequisite';
export type InvariantRejection = { readonly stage: 'final_state'; readonly code: InvariantErrorCode; readonly ticketIds: readonly TicketId[] };
export type Rejection = { readonly stage: 'input'; readonly error: InvalidInput }
  | CommandRejection
  | InvariantRejection
  | { readonly stage: 'final_state'; readonly code: 'no_changes' };
export type PrepareResult =
  | { readonly kind: 'prepared'; readonly change: import('./create.js').PreparedCommit; readonly frontier: readonly TicketId[] }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }
  | { readonly kind: 'conflict'; readonly conflict: Conflict };
export interface SemanticChange {
  readonly commandIndex: number;
  readonly command: Command['kind'] | 'map.create';
  readonly subjectId: string;
  readonly reason?: string;
}
export interface Revision {
  readonly mapId: MapId;
  readonly revision: RevisionNumber;
  readonly priorRevision: RevisionNumber | null;
  readonly kind: 'create' | 'apply';
  readonly author: MutationAuthor;
  readonly changes: NonEmpty<SemanticChange>;
  readonly state: StoredMapState;
}
export type ReadResult<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'not_found'; readonly code: 'map_not_found'; readonly mapId: MapId }
  | { readonly kind: 'not_found'; readonly code: 'revision_not_found'; readonly mapId: MapId; readonly revision: RevisionNumber }
  | { readonly kind: 'rejected'; readonly error: InvalidInput };
export interface Conflict {
  readonly mapId: MapId;
  readonly expectedRevision: RevisionNumber;
  readonly currentRevision: RevisionNumber;
}
export type CommitResult =
  | { readonly kind: 'rejected'; readonly rejection: Rejection }
  | { readonly kind: 'committed'; readonly revision: Revision; readonly frontier: readonly TicketId[] }
  | { readonly kind: 'conflict'; readonly conflict: Conflict }
  | { readonly kind: 'rejected'; readonly code: 'map_already_exists' | 'map_not_found'; readonly mapId: MapId };
