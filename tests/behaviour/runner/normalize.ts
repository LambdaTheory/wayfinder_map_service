// Codex `exec --json` output and its session log, normalized into the evidence record of `../evidence.ts`.
import { readFileSync } from 'node:fs';
import { classifyResult } from '../evidence.ts';
import type { AttemptRecord, EventRecord, GivenRules, Receipt } from '../evidence.ts';

interface CodexItem {
  id: string; type: string; text?: string; command?: string; exit_code?: number | null; server?: string; tool?: string;
  arguments?: unknown; result?: { structured_content?: unknown } | null; error?: unknown; status?: string;
  changes?: { path: string; kind: string }[];
}
export type Line = { type: string; item?: CodexItem; usage?: Record<string, number>; message?: string; thread_id?: string };

export const parseLines = (stdout: string): Line[] => stdout.split('\n').flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line) as Line]; } catch { return []; }
});

const readers = /(?:^|[\s;&|('"])(?:cat|head|tail|sed|nl|less|more|awk|rg|grep|wc)\s+([^;&|]*)/g;
const unquote = (text: string) => text.replace(/^['"]|['"]$/g, '');

/** Workdir-relative POSIX path, or `<outside>/…` for anything outside it (R3 path rule). */
export function relativePath(path: string, workdir: string): string {
  const clean = unquote(path);
  if (clean.startsWith(workdir + '/')) return clean.slice(workdir.length + 1);
  if (clean.startsWith('/')) return `<outside>${clean.replace(/^\/(Users|home)\/[^/]+/, '')}`;
  return clean.replace(/^\.\//, '');
}

/** Best-effort reads from a shell command: arguments of common read commands that look like paths. */
export function readsIn(command: string, workdir: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(readers)) {
    for (const arg of (m[1] ?? '').split(/\s+/)) {
      const a = unquote(arg);
      if (!a || a.startsWith('-') || /^\d/.test(a) || !/[./]/.test(a) || /^[^/]*['"$]/.test(a)) continue;
      out.push(relativePath(a, workdir));
    }
  }
  return [...new Set(out)];
}

export interface Normalized { events: EventRecord[]; usage: { inputTokens: number; outputTokens: number }; errors: string[] }

/** One turn of one session. `seq` continues across turns; `turn` is the Scenario's turn index. */
export function normalizeTurn(lines: Line[], session: string, turn: number, input: string, at: string, firstSeq: number, workdir: string): Normalized {
  const events: EventRecord[] = [];
  let seq = firstSeq;
  const normalizer = streamTurn(session, turn, input, at, workdir, event => events.push({ ...event, seq: seq++ }));
  for (const line of lines) normalizer.line(line);
  normalizer.finish();
  return { events, usage: normalizer.usage, errors: normalizer.errors };
}

/** Incremental normalization preserves observed interleaving across concurrent clients and Controller actions. */
export function streamTurn(session: string, turn: number, input: string, at: string, workdir: string, emit: (event: EventRecord) => void) {
  const events = { push: emit };
  const base = (actor: EventRecord['actor']) => ({ seq: 0, at: new Date().toISOString(), session, turn, actor });
  emit({ ...base('script-human'), at, kind: 'message', role: 'user', text: input });
  const usage = { inputTokens: 0, outputTokens: 0 };
  const errors: string[] = [];
  const pending = new Map<string, CodexItem>();
  const line = (line: Line) => {
    if (line.type === 'item.started' && line.item?.type === 'mcp_tool_call') pending.set(line.item.id, line.item);
    if (line.type === 'turn.completed' && line.usage) { usage.inputTokens += line.usage.input_tokens ?? 0; usage.outputTokens += line.usage.output_tokens ?? 0; }
    if ((line.type === 'error' || line.type === 'turn.failed') && line.message) errors.push(line.message);
    if (line.type !== 'item.completed' || !line.item) return;
    const item = line.item;
    pending.delete(item.id);
    switch (item.type) {
      case 'agent_message': events.push({ ...base('agent'), kind: 'message', role: 'assistant', text: item.text ?? '' }); break;
      case 'command_execution':
        events.push({ ...base('agent'), kind: 'command', command: item.command ?? '', exitCode: item.exit_code ?? null });
        for (const path of readsIn(item.command ?? '', workdir)) events.push({ ...base('agent'), kind: 'file-read', path });
        break;
      case 'mcp_tool_call': {
        const structured = item.result?.structured_content;
        events.push({ ...base('agent'), kind: 'tool-call', callId: `${session}:${turn}:${item.id}`, server: item.server ?? '', tool: item.tool ?? '', arguments: item.arguments ?? null,
          result: structured === undefined || structured === null ? { known: false, reason: item.error ? 'the call failed' : 'no structured result' } : { known: true, value: structured },
          failed: item.status === 'failed' || (item.error !== null && item.error !== undefined), requestId: { known: false, reason: 'Codex does not report JSON-RPC request IDs' } });
        if (/resource/i.test(item.tool ?? '')) events.push({ ...base('agent'), kind: 'resource-read', uri: String((item.arguments as { uri?: string } | null)?.uri ?? ''), ok: item.status !== 'failed' });
        break;
      }
      case 'file_change':
        for (const change of item.changes ?? []) events.push({ ...base('agent'), kind: 'file-change', path: relativePath(change.path, workdir),
          change: change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : 'modify' });
        break;
      case 'collab_tool_call': events.push({ ...base('agent'), kind: 'delegation', phase: 'start', id: item.id, summary: item.tool ?? 'collab' }); break;
      default: break;
    }
  };
  const finish = () => {
    // A call still running when the turn ended (timeout, cancellation) has no known outcome; its receipt stays unknown.
    for (const item of pending.values()) {
      events.push({ ...base('agent'), kind: 'tool-call', callId: `${session}:${turn}:${item.id}`, server: item.server ?? '', tool: item.tool ?? '', arguments: item.arguments ?? null,
        result: { known: false, reason: 'the turn ended before the call completed' }, failed: false, requestId: { known: false, reason: 'Codex does not report JSON-RPC request IDs' } });
    }
  };
  return { line, finish, usage, errors };
}

/** A receipt for every agent write: committed with its Revision, refused with its class, or unknown. */
export function receiptsFrom(events: EventRecord[]): Receipt[] {
  return events.flatMap((e): Receipt[] => {
    if (e.kind !== 'tool-call' || e.actor !== 'agent' || !/wayfinder/i.test(e.server) || (e.tool !== 'map_apply' && e.tool !== 'map_create')) return [];
    const args = (e.arguments ?? {}) as { mapId?: string };
    const base = { callId: e.callId, session: e.session!, turn: e.turn!, tool: e.tool as 'map_apply' | 'map_create', mapId: args.mapId ?? null };
    if (!e.result.known) return [{ ...base, outcome: { kind: 'unknown' as const, reason: e.result.reason } }];
    const value = e.result.value as { mapId?: string; revision?: number | { mapId: string; revision: number } };
    const cls = classifyResult(value, e.failed);
    if (cls === 'transport-failure') return [{ ...base, outcome: { kind: 'unknown', reason: 'unrecognized or missing write result' } }];
    if (cls !== 'committed') return [{ ...base, outcome: { kind: 'not-written' as const, because: cls } }];
    const revision = typeof value.revision === 'number' ? value.revision : value.revision?.revision;
    const mapId = value.mapId ?? (typeof value.revision === 'object' ? value.revision.mapId : undefined) ?? base.mapId;
    if (mapId !== base.mapId) return [{ ...base, outcome: { kind: 'unknown', reason: 'receipt Map does not match the call' } }];
    return !Number.isInteger(revision) || revision! < 1 ? [{ ...base, outcome: { kind: 'unknown' as const, reason: 'committed result without a Revision' } }]
      : [{ ...base, mapId, outcome: { kind: 'committed' as const, revision: revision! } }];
  });
}

/** Corroborate native receipts with history; neither relay observations nor authors manufacture a receipt. */
export function correlateReceipts(events: EventRecord[], maps: AttemptRecord['maps'], sessions: AttemptRecord['sessions'], controllerId: string): Receipt[] {
  const receipts = receiptsFrom(events);
  return receipts.map(receipt => {
    if (receipt.outcome.kind !== 'committed') return receipt;
    const revision = receipt.outcome.revision;
    const matches = maps.flatMap(m => m.history.filter(r => r.mapId === receipt.mapId && r.revision === revision
      && (m.seedHeadRevision === null || r.revision > m.seedHeadRevision)));
    const owners = sessions.filter(s => s.label === receipt.session);
    const competing = receipts.filter(r => r.mapId === receipt.mapId && r.outcome.kind === 'committed' && r.outcome.revision === revision);
    const valid = matches.length === 1 && competing.length === 1 && owners.length === 1
      && matches[0]!.author.clientId === owners[0]!.clientId && matches[0]!.author.clientId !== controllerId;
    return valid ? receipt : { ...receipt, outcome: { kind: 'unknown', reason: 'receipt does not uniquely match a post-seed Revision by this session' } };
  });
}

export interface RolloutFacts { visibleModel: string | null; effort: string | null; cliVersion: string | null; text: string }

/** What the session log says about the model and what it was shown. */
export function readRollout(path: string): RolloutFacts {
  const text = readFileSync(path, 'utf8');
  let visibleModel: string | null = null; let effort: string | null = null; let cliVersion: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> & { type?: string; thread_settings?: Record<string, unknown> } };
      if (e.type === 'session_meta' && typeof e.payload?.cli_version === 'string') cliVersion = e.payload.cli_version;
      if (e.payload?.type === 'thread_settings_applied') {
        visibleModel = (e.payload.thread_settings?.model as string) ?? visibleModel;
        effort = (e.payload.thread_settings?.reasoning_effort as string) ?? (e.payload.thread_settings?.model_reasoning_effort as string) ?? effort;
      }
      if (e.type === 'turn_context' && !effort && typeof e.payload?.effort === 'string') effort = e.payload.effort;
    } catch { /* partial line */ }
  }
  return { visibleModel, effort, cliVersion, text };
}

/**
 * Content counts as shown only if every non-blank line of it appears in what the client sent its model. Codex logs
 * the server instructions as a string inside another JSON string, so a line may appear escaped once or twice.
 */
export function shown(rolloutText: string, content: string): boolean {
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => rolloutText.includes(escape(line)) || rolloutText.includes(escape(escape(line))));
}

/** The rules the client was given in its first phase, claimed as read only where the session log shows them. */
export function initialRules(version: string, instructions: string, toolDescriptions: Record<string, string>, rollout: RolloutFacts | null): GivenRules {
  const absent = (what: string) => ({ known: false as const, reason: rollout ? `${what} not found in what the client sent its model` : 'no session log' });
  return { phase: 'initial', fromSeq: 0, compatibilityMode: 'instructions', rulesSource: { kind: 'instructions', versionLine: `version: ${version}` },
    instructions: rollout && shown(rollout.text, instructions) ? { known: true, value: instructions } : absent('the instructions'),
    toolDescriptions: rollout && Object.values(toolDescriptions).every(d => shown(rollout.text, d)) ? { known: true, value: toolDescriptions } : absent('some tool descriptions'),
    resources: 'undocumented', prompts: 'undocumented', extraContext: [] };
}
