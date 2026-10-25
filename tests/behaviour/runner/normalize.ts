// Codex `exec --json` output and its session log, normalized into the evidence record of `../evidence.ts`.
import { readFileSync } from 'node:fs';
import { classifyResult } from '../evidence.ts';
import type { EventRecord, Receipt } from '../evidence.ts';

interface CodexItem {
  id: string; type: string; text?: string; command?: string; exit_code?: number | null; server?: string; tool?: string;
  arguments?: unknown; result?: { structured_content?: unknown } | null; error?: unknown; status?: string;
  changes?: { path: string; kind: string }[];
}
type Line = { type: string; item?: CodexItem; usage?: Record<string, number>; message?: string; thread_id?: string };

export const parseLines = (stdout: string): Line[] => stdout.split('\n').flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line) as Line]; } catch { return []; }
});

const readers = /(?:^|[\s;&|('"])(?:cat|head|tail|sed|nl|less|more|awk|rg|grep|wc)\s+([^;&|]*)/g;

/** Workdir-relative POSIX path, or `<outside>/…` for anything outside it (R3 path rule). */
export function relativePath(path: string, workdir: string): string {
  const clean = path.replace(/^['"]|['"]$/g, '');
  if (clean.startsWith(workdir + '/')) return clean.slice(workdir.length + 1);
  if (clean.startsWith('/')) return `<outside>${clean.replace(/^\/(Users|home)\/[^/]+/, '')}`;
  return clean.replace(/^\.\//, '');
}

/** Best-effort reads from a shell command: arguments of common read commands that look like paths. */
export function readsIn(command: string, workdir: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(readers)) {
    for (const arg of (m[1] ?? '').split(/\s+/)) {
      const a = arg.replace(/^['"]|['"]$/g, '');
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
  const base = (actor: EventRecord['actor']) => ({ seq: seq++, at, session, turn, actor });
  events.push({ ...base('script-human'), kind: 'message', role: 'user', text: input });
  const usage = { inputTokens: 0, outputTokens: 0 };
  const errors: string[] = [];
  for (const line of lines) {
    if (line.type === 'turn.completed' && line.usage) { usage.inputTokens += line.usage.input_tokens ?? 0; usage.outputTokens += line.usage.output_tokens ?? 0; }
    if ((line.type === 'error' || line.type === 'turn.failed') && line.message) errors.push(line.message);
    if (line.type !== 'item.completed' || !line.item) continue;
    const item = line.item;
    switch (item.type) {
      case 'agent_message': events.push({ ...base('agent'), kind: 'message', role: 'assistant', text: item.text ?? '' }); break;
      case 'command_execution':
        events.push({ ...base('agent'), kind: 'command', command: item.command ?? '', exitCode: item.exit_code ?? null });
        for (const path of readsIn(item.command ?? '', workdir)) events.push({ ...base('agent'), kind: 'file-read', path });
        break;
      case 'mcp_tool_call': {
        const structured = item.result?.structured_content;
        events.push({ ...base('agent'), kind: 'tool-call', callId: item.id, server: item.server ?? '', tool: item.tool ?? '', arguments: item.arguments ?? null,
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
  }
  return { events, usage, errors };
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
    if (cls !== 'committed') return [{ ...base, outcome: { kind: 'not-written' as const, because: cls } }];
    const revision = typeof value.revision === 'number' ? value.revision : value.revision?.revision;
    const mapId = value.mapId ?? (typeof value.revision === 'object' ? value.revision.mapId : undefined) ?? base.mapId;
    return revision === undefined ? [{ ...base, outcome: { kind: 'unknown' as const, reason: 'committed result without a Revision' } }]
      : [{ ...base, mapId, outcome: { kind: 'committed' as const, revision } }];
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

/** Content counts as shown only if its opening appears in what the client sent its model. */
export const shown = (rolloutText: string, content: string) => content.length > 0 && rolloutText.includes(JSON.stringify(content.slice(0, 80)).slice(1, -1));
