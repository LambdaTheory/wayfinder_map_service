// The evidence contract for one Attempt (spec R3). Drivers normalize native client output into
// this record; verdicts read its evidence and append separately hashed review annotations. Raw native files stay private.
import type { ReviewSummary } from './review-types.ts';

export const attemptSchema = 'wayfinder-behaviour-attempt/1';

export const entries = ['mcp-only', 'dedicated', 'chatgpt', 'matt'] as const;
export type Entry = typeof entries[number];

export const harnesses = ['codex', 'claude', 'chatgpt', 'pi', 'grok'] as const;
export type Harness = typeof harnesses[number];

/** A value the Driver could not obtain is recorded with the reason, never left out or guessed. */
export type Field<T> = { known: true; value: T } | { known: false; reason: string };

/** How the run ended, kept apart from the behaviour verdict (R4). */
export const completeness = ['complete', 'precondition-not-met', 'launch-failed', 'timeout', 'rate-limited',
  'cancelled', 'driver-failed', 'service-failed'] as const;
export type Completeness = typeof completeness[number];

/** Where the agent under test can learn the write `version` (ADR 0005). The runner never supplies it. */
export type RulesSource =
  | { kind: 'unknown'; reason: string }
  | { kind: 'instructions'; versionLine: string }
  | { kind: 'tool-parameter'; tool: 'map_create' | 'map_apply'; description: string };

export type Surface = 'available' | 'unavailable' | 'undocumented';

/** What the client was actually given in one phase of the Attempt; content it did not show its model is never claimed as read. */
export interface GivenRules {
  /** `initial` at the first connection; later phases after a Controller restart or an app refresh (upgrade checks). */
  phase: 'initial' | 'after-restart' | 'after-refresh';
  /** First event sequence number this phase covers. */
  fromSeq: number;
  compatibilityMode: 'instructions' | 'toolsOnly';
  /** Release observed by the Controller at this phase; never evidence of model visibility. */
  serviceVersion?: string;
  /** Only content actually exposed by the client, or unknown. Controller imports are not a rules source. */
  rulesSource: RulesSource;
  instructions: Field<string>;
  toolDescriptions: Field<Record<string, string>>;
  resources: Surface;
  prompts: Surface;
  /** Context the Entry loads besides the server: Skill, launcher instructions. Empty for MCP-only. */
  extraContext: string[];
}

/**
 * Markers a Driver puts in `missing` when a whole evidence class is unavailable. A check that needs a missing
 * class answers `unknown`, never `holds`. Single fields use their path instead, e.g. `combination.visibleModel`.
 * Native integrity guards are also registered here; `combination.model-mismatch` means requested versus observed,
 * while a missing or conflicting native model observation uses the `combination.visibleModel` field path.
 */
export const missingMarkers = ['maps', 'receipts', 'events', 'events.message', 'events.tool-call', 'events.resource-read',
  'events.file-read', 'events.file-change', 'events.command', 'events.delegation', 'events.process',
  'native.integrity', 'native.boundaries', 'native.sidechain', 'native.unhandled', 'combination.model-mismatch'] as const;

export interface AttemptRecord {
  schema: typeof attemptSchema;
  attemptId: string;
  /** Null only for Attempts outside any approved Batch, which verdicts report as such. */
  batchId: string | null;
  /** The Scenario or upgrade check this Attempt ran, at the version whose verdict items it was judged by. */
  subject: { kind: 'scenario' | 'upgrade-check'; id: string; version: number };
  entry: Entry;
  combination: { harness: Harness; requestedModel: string; visibleModel: Field<string>; effort: Field<string> };
  client: { version: Field<string>; surface: Field<string> };
  /**
   * `series` keeps the two numbering schemes apart (R5): `release` is the Release Version since 2026-10-25;
   * `workflowVersion` marks an imported historical run whose number belongs to the old workflow-only series.
   */
  service: { commit: string; series: 'release' | 'workflowVersion'; version: string };
  /** One entry per phase; an upgrade check has the rules before and after the restart or refresh. */
  given: GivenRules[];
  run: { startedAt: string; endedAt: string; completeness: Completeness; detail?: string };
  /** The Controller writes with its own credential, so its Revisions are never mistaken for the agent's. */
  controller: { clientId: string };
  /** Client IDs of credentials planted as bait (W5); any Revision they author is a borrowed credential. */
  baitClientIds: string[];
  sessions: SessionRecord[];
  /** Ordered by `seq`. `turn` is an index into the Scenario's `turns`, counted across all sessions. */
  events: EventRecord[];
  /** Every Map in the catalog after the run, read by paging `map_list` to the end; otherwise `missing` holds `maps`. */
  maps: MapEvidence[];
  receipts: Receipt[];
  usage: Field<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>;
  /** Where the raw native files of this Attempt live, relative to the private run root outside the repository. */
  raw: { path: string; files: string[] };
  /** Markers from `missingMarkers` and paths of single fields the Driver could not fill. */
  missing: string[];
  /** Append-only review rounds; each is bound to the original evidence hash. */
  modelReviews?: ReviewSummary[];
}

export interface SessionRecord {
  /** The Scenario's session label, e.g. `A`. */
  label: string;
  nativeId: Field<string>;
  /** The Client ID of the credential this session alone used. It corroborates a receipt; it never replaces one. */
  clientId: string;
  /** MCP session IDs the service issued to this session (reconnects add more): the join key with service metadata (B07). */
  mcpSessionIds: Field<string[]>;
  turns: { index: number; input: string; startedAt: string; endedAt: string; durationMs: number }[];
}

/** Who acted. Controller seeding, injected Conflicts and evidence reads never count as agent behaviour. */
export type Actor = 'agent' | 'controller' | 'script-human';

interface EventBase { seq: number; at: string; session: string | null; turn: number | null; actor: Actor }

export type EventRecord = EventBase & (
  | { kind: 'message'; role: 'assistant' | 'user'; text: string;
      /** Native tool results synthesized as user input retain their origin; they are not free-form human delivery. */
      inputSource?: { kind: 'question-tool'; tool: string; callId: string } }
  | { kind: 'tool-call'; callId: string; server: string; tool: string; arguments: unknown;
      result: Field<unknown>; failed: boolean;
      /** The JSON-RPC request ID when the Driver can see it; joins the call to the service's metadata record. */
      requestId: Field<string> }
  | { kind: 'resource-read'; uri: string; ok: boolean }
  /**
   * Best effort: the Driver derives reads from read tools or read-only commands it recognizes. File paths are
   * POSIX and relative to the agent's working directory; a path outside it is written `<outside>/<redacted path>`.
   */
  | { kind: 'file-read'; path: string }
  | { kind: 'file-change'; path: string; change: 'add' | 'modify' | 'delete' }
  | { kind: 'command'; command: string; exitCode: number | null }
  | { kind: 'delegation'; phase: 'start' | 'end'; id: string; summary?: string }
  | { kind: 'process'; exitCode: number | null; signal: string | null }
  | { kind: 'controller'; action: string; detail?: unknown }
);

export interface MapEvidence {
  mapId: string;
  /** The head after Controller seeding; null for a Map the agent created. */
  seedHeadRevision: number | null;
  /** Every Revision after the run, seed Revisions included, as `map_read` returns them. */
  history: WireRevision[];
}

// Wire shapes as the tools return them; verdicts never depend on service internals.
export type TicketType = 'grilling' | 'prototype' | 'research' | 'task';
export interface WireReference { locator: string; label?: string }
export interface WireSettlement {
  outcome: { kind: 'decision'; statement: string; rationale: string } | { kind: 'finding'; statement: string; limitations?: string }
    | { kind: 'completion'; statement: string; resultingFacts?: Record<string, unknown> };
  evidence: { statement: string; references: WireReference[]; provenance?: { method: string; sources: WireReference[] } }[];
  references: WireReference[];
  provenance: { method: string; sources: WireReference[] };
  introducedAtRevision?: number;
}
export interface WireTicket {
  id: string; title: string; question: string; type: TicketType; prerequisites: string[];
  status: 'open' | 'settled'; claim: string | null; settlement?: WireSettlement;
}
export interface WireContent { id: string; text: string; references: WireReference[] }
export interface WireState {
  id: string; title: string; destination: string; notes: string;
  fog: WireContent[]; scopeExclusions: WireContent[]; tickets: WireTicket[]; currentRevision: number;
}
export interface WireRevision {
  mapId: string; revision: number; priorRevision: number | null; kind: 'create' | 'apply';
  author: { actorId: string; clientId: string; occurredAt: string };
  changes: { commandIndex: number; command: string; subjectId: string; reason?: string }[];
  state: WireState;
}

/**
 * One agent write call matched to its outcome. A write is attributed to a session only through this
 * receipt: the call's committed (mapId, revision) result and the Revision's author Client ID must both
 * name the session. Author name, time or a turn's revision range alone are never enough (R3).
 */
export interface Receipt {
  callId: string;
  session: string;
  turn: number;
  tool: 'map_create' | 'map_apply';
  mapId: string | null;
  outcome:
    | { kind: 'committed'; revision: number }
    | { kind: 'not-written'; because: ResultClass }
    | { kind: 'unknown'; reason: string };
}

/** Write-call results told apart (R4). */
export const resultClasses = ['committed', 'read', 'input-error', 'command-rejected', 'version-mismatch', 'map-exists',
  'not-found', 'conflict', 'service-failure', 'transport-failure'] as const;
export type ResultClass = typeof resultClasses[number];

type RawResult = { kind?: string; code?: string; error?: { path?: unknown[] }; rejection?: { stage?: string; error?: { path?: unknown[] } } } | null;

/** Classify a tool result by the shapes the service returns (`src/mcp-schemas.ts`). */
export function classifyResult(result: unknown, failed = false): ResultClass {
  const value = result as RawResult;
  if (value === null || typeof value !== 'object') return 'transport-failure';
  switch (value.kind) {
    case 'committed': return 'committed';
    case 'found': case 'listed': return 'read';
    case 'conflict': return 'conflict';
    case 'not_found': return 'not-found';
    case 'infrastructure_error': return 'service-failure';
    case 'rejected':
      if (value.code === 'version_mismatch') return 'version-mismatch';
      if (value.code === 'map_already_exists') return 'map-exists';
      if (value.code === 'map_not_found') return 'not-found';
      if (value.error !== undefined || value.rejection?.stage === 'input') return 'input-error';
      return 'command-rejected';
    default: return 'transport-failure';
  }
}

/** The field path an input error names, from either rejection shape; null for any other result. */
export function inputErrorPath(result: unknown): unknown[] | null {
  const value = result as RawResult;
  if (classifyResult(value) !== 'input-error') return null;
  return value?.error?.path ?? value?.rejection?.error?.path ?? [];
}

/** Fields a record must carry; a Driver lists the ones it cannot fill in `missing` instead. */
export const requiredFields = ['subject.kind', 'subject.id', 'subject.version', 'entry', 'combination.harness', 'combination.requestedModel',
  'combination.visibleModel', 'combination.effort', 'client.version', 'service.commit', 'service.series', 'service.version',
  'given', 'run.completeness', 'controller.clientId',
  'sessions', 'events', 'maps', 'receipts', 'usage', 'raw'] as const;

/**
 * Raw records and run summaries stay in a private run directory outside the repository. Before anything
 * leaves it, credentials are removed while correlation survives: each secret becomes a stable placeholder,
 * so two references to one token still match.
 */
export function redact(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, secret] of Object.entries(secrets)) {
    if (secret) out = out.split(secret).join(`<${name}>`);
  }
  return out;
}

export function leaks(text: string, secrets: Record<string, string>): string[] {
  return Object.entries(secrets).filter(([, secret]) => secret && text.includes(secret)).map(([name]) => name);
}
