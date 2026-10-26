import type { CaptureInput } from '../capture/capture.ts';
import type { Entry } from '../evidence.ts';

export type Usage = 'normal' | 'test' | 'research' | 'unknown';
export type SourceKind = 'codex' | 'claude' | 'calls' | 'gaps' | 'launches' | 'attempt';
export interface Source { id: string; kind: SourceKind; path: string }
export interface Manifest {
  schema: 'wayfinder-usage-input/1'; sources: Source[];
  /** Explicit operator classifications, never inferred from words like "test" in a prompt. */
  labels?: { harness: 'codex' | 'claude'; nativeId: string; agentId?: string; usage: Exclude<Usage, 'unknown'>; basis: string }[];
  /** Literal secrets to remove from every output; these values are never copied. */
  secrets?: string[];
}
export interface Fragment { ref: string; role: 'user' | 'assistant' | 'tool'; text: string }
export interface NativeCall {
  id: string; tool: string; ref: string; mapId: string | null;
  requestId: string | null; requestIdType: 'string' | 'number' | null;
  result: string | null;
}
export interface Session {
  key: string; harness: 'codex' | 'claude' | 'chatgpt' | 'unknown'; nativeId: string | null;
  subagent: boolean; model: string | null; effort: string | null; entry: Entry | 'unknown';
  usage: Usage; usageBasis: string[]; sources: string[]; skill: string[];
  mcpSessionIds: string[]; fingerprints: string[]; calls: NativeCall[];
  fragments: Fragment[]; gaps: string[];
}
export interface Call {
  ref: string; serviceStartedAt: string; sequence: number; missingObservations: number;
  mcpSessionId: string | null; presentedMcpSessionId: string | null;
  requestId: string | null; requestIdType: 'string' | 'number' | null; requestIdHash: string | null;
  credentialFingerprint: string | null; clientId: string | null; tool: string | null;
  mapId: string | null; result: string;
}
export interface Launch {
  ref: string; harness: string | null; model: string | null; effort: string | null;
  entry: Entry | 'unknown'; usage: Usage; nativeSessionId: string | null;
  credentialFingerprint: string | null;
}
export interface Inputs { sessions: Session[]; calls: Call[]; launches: Launch[]; gaps: string[]; sources: { id: string; kind: SourceKind; files: number }[] }
export interface Match { call: Call; session: string | null; basis: string[]; nativeCall: string | null; gaps: string[] }
export interface Inventory extends Session {
  serviceCalls: string[]; matchingBasis: string[];
  activity: 'skill-only-observed' | 'mcp' | 'unrelated' | 'unknown';
  /** This scanner cannot infer consent, even for a committed call. */
  authorization: 'not-assessed';
}
export interface Lead {
  id: string; session: string; kind: 'write' | 'refusal' | 'conflict' | 'failure' | 'skill-only' | 'missing-evidence';
  refs: string[]; evidenceHash: string; fragments: Fragment[];
  status: 'pending' | 'screened' | 'confirmed' | 'dismissed';
  reason: string; requestHumanWords: boolean; reminder: boolean;
}
export interface Review {
  leadId: string; evidenceHash: string;
  disposition: 'screened' | 'needs-human-words' | 'confirmed' | 'dismissed';
  by: string; basis: string; reason: string;
  /** Exact excerpts from native evidence; metadata is not an admissible word source. */
  quotes: { ref: string; quote: string }[];
}
export interface ScanState { schema: 'wayfinder-scan-state/1'; reminded: string[] }
/** Deliberately incomplete B04 input: no guessed pre-incident Revision or Claim decisions. */
export interface CaptureDraft {
  schema: 'wayfinder-capture-input-draft/1'; leadId: string; ready: false;
  input: Omit<CaptureInput, 'revision' | 'restores' | 'claims'> & {
    revision: null; restores: null; claims: null;
  };
  missing: string[];
}
