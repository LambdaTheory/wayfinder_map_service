// The evidence contract for one Attempt (spec R3). Drivers normalize native client output into
// this record; verdicts read only this record. Raw native files stay in the private run directory.

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
  | { kind: 'instructions'; versionLine: string }
  | { kind: 'tool-parameter'; tool: 'map_create' | 'map_apply'; description: string };

export type Surface = 'available' | 'unavailable' | 'undocumented';

export interface AttemptRecord {
  schema: typeof attemptSchema;
  attemptId: string;
  /** Null only for Attempts outside any approved Batch, which verdicts report as such. */
  batchId: string | null;
  scenario: { id: string; version: number };
  entry: Entry;
  combination: { harness: Harness; requestedModel: string; visibleModel: Field<string>; effort: Field<string> };
  client: { version: Field<string>; surface: Field<string> };
  /**
   * `series` keeps the two numbering schemes apart (R5): `release` is the Release Version since 2026-10-25;
   * `workflowVersion` marks an imported historical run whose number belongs to the old workflow-only series.
   */
  service: { commit: string; series: 'release' | 'workflowVersion'; version: string };
  /** What the client was actually given; content it did not show its model is never claimed as read. */
  given: {
    compatibilityMode: 'instructions' | 'toolsOnly';
    rulesSource: RulesSource;
    instructions: Field<string>;
    toolDescriptions: Field<Record<string, string>>;
    resources: Surface;
    prompts: Surface;
    /** Context the Entry loads besides the server: Skill, launcher instructions. Empty for MCP-only. */
    extraContext: string[];
  };
  run: { startedAt: string; endedAt: string; completeness: Completeness; detail?: string };
  /** The Controller writes with its own credential, so its Revisions are never mistaken for the agent's. */
  controller: { clientId: string };
  /** Client IDs of credentials planted as bait (W5); any Revision they author is a borrowed credential. */
  baitClientIds: string[];
  sessions: SessionRecord[];
  events: EventRecord[];
  maps: MapEvidence[];
  receipts: Receipt[];
  usage: Field<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>;
  /** Paths of fields the Driver could not fill, e.g. `combination.visibleModel`. */
  missing: string[];
}

export interface SessionRecord {
  /** The Scenario's session label, e.g. `A`. */
  label: string;
  nativeId: Field<string>;
  /** The Client ID of the credential this session alone used; it is how Revisions are attributed. */
  clientId: string;
  turns: { index: number; input: string; startedAt: string; endedAt: string; durationMs: number }[];
}

/** Who acted. Controller seeding, injected Conflicts and evidence reads never count as agent behaviour. */
export type Actor = 'agent' | 'controller' | 'script-human';

interface EventBase { seq: number; at: string; session: string | null; turn: number | null; actor: Actor }

export type EventRecord = EventBase & (
  | { kind: 'message'; role: 'assistant' | 'user'; text: string }
  | { kind: 'tool-call'; callId: string; server: string; tool: string; arguments: unknown;
      result: Field<unknown>; failed: boolean }
  | { kind: 'resource-read'; uri: string; ok: boolean }
  /** Best effort: the Driver derives reads from read tools or read-only commands it recognizes. */
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
export const resultClasses = ['committed', 'input-error', 'command-rejected', 'version-mismatch', 'map-exists',
  'not-found', 'conflict', 'service-failure', 'transport-failure'] as const;
export type ResultClass = typeof resultClasses[number];

export function classifyResult(result: unknown, failed = false): ResultClass {
  const value = result as { kind?: string; code?: string; error?: unknown; rejection?: unknown } | null;
  if (value === null || typeof value !== 'object') return 'transport-failure';
  switch (value.kind) {
    case 'committed': case 'created': return 'committed';
    case 'conflict': return 'conflict';
    case 'not_found': return 'not-found';
    case 'infrastructure_error': return 'service-failure';
    case 'rejected':
      if (value.code === 'version_mismatch') return 'version-mismatch';
      if (value.code === 'map_already_exists') return 'map-exists';
      if (value.code === 'map_not_found') return 'not-found';
      if (value.error !== undefined) return 'input-error';
      if (value.rejection !== undefined) return 'command-rejected';
      return 'input-error';
    default: return failed ? 'transport-failure' : 'input-error';
  }
}

/** Fields a record must carry; a Driver lists the ones it cannot fill in `missing` instead. */
export const requiredFields = ['scenario.id', 'scenario.version', 'entry', 'combination.harness', 'combination.requestedModel',
  'combination.visibleModel', 'combination.effort', 'client.version', 'service.commit', 'service.series', 'service.version',
  'given.compatibilityMode', 'given.rulesSource', 'given.instructions', 'given.toolDescriptions', 'run.completeness',
  'controller.clientId',
  'sessions', 'events', 'maps', 'receipts', 'usage'] as const;

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
