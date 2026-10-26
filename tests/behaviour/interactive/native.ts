// Conservative adapters for explicitly supplied native files, never discovery of personal logs.
import { questionTool } from './tools.ts';
import { classifyResult } from '../evidence.ts';
import type { EventRecord, Field, SessionRecord } from '../evidence.ts';

export type InteractiveClient = 'codex' | 'claude';
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const parsed = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const content = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v)
  ? v.map(b => string(object(b).text)).filter(Boolean).join('\n') : '';
const known = <T>(value: T): Field<T> => ({ known: true, value });
const absent = (reason: string): Field<never> => ({ known: false, reason });
// Only absent or explicitly false clears the flag; malformed values cannot establish successful input.
const errorFlag = (value: unknown) => value !== undefined && value !== false
  && !(typeof value === 'string' && value.trim().toLowerCase() === 'false');
const rejection = (value: string) => /^(?:error: )?user (?:rejected|denied|cancelled|canceled)/i.test(value.trim());
const rejectionNotice = (value: string) => /^(?:error: )?user (?:rejected|denied|cancelled|canceled)(?: tool use)?[.!]?$/i.test(value.trim());

export interface NativeEvidence {
  events: EventRecord[];
  session: SessionRecord;
  locations: Record<number, string>;
  missing: string[];
  model: Field<string>;
  version: Field<string>;
  effort: Field<string>;
  range: Field<{ startedAt: string; endedAt: string }>;
}

/**
 * A completed native turn is the interval, not a wall-clock speed estimate. Codex must carry task_started /
 * task_complete; Claude must carry an opening user record and an explicit end_turn or system turn_duration.
 * Unknown boundaries, compaction, sidechains and malformed records fail closed. Tool results are joined by ID.
 */
export function normalizeNative(client: InteractiveClient, text: string, file: string, clientId: string): NativeEvidence {
  const events: EventRecord[] = []; const locations: Record<number, string> = {}; const missing = new Set<string>();
  const turns: SessionRecord['turns'] = [];
  let nativeId: Field<string> = absent('native session ID unavailable');
  let model: Field<string> = absent('visible model unavailable');
  let version: Field<string> = absent('client version unavailable');
  let effort: Field<string> = absent('effort unavailable');
  let active: { index: number; startedAt: string; input: string; id: string } | null = null;
  const models = new Set<string>(); const efforts = new Set<string>();
  const setModel = (value: unknown) => { if (typeof value === 'string' && value) { models.add(value); model = models.size === 1 ? known(value) : absent('native model changed during the run'); } };
  const setEffort = (value: unknown) => { if (typeof value === 'string' && value) { efforts.add(value); effort = efforts.size === 1 ? known(value) : absent('native effort changed during the run'); } };
  const timestamps: string[] = [];
  const uncertainTurns = new Set<number>();
  const markUncertain = () => { if (active) uncertainTurns.add(active.index); };
  let nextTurn = 0; let previousTime = -Infinity;
  const calls = new Map<string, Extract<EventRecord, { kind: 'tool-call' }>>();
  const setId = (id: string) => {
    if (!id) return;
    if (nativeId.known && nativeId.value !== id) missing.add('native.integrity');
    nativeId = known(id);
  };
  const start = (at: string, id: string, input = '') => {
    if (active) missing.add('native.boundaries');
    active = { index: nextTurn++, startedAt: at, input, id };
  };
  const rememberInput = (body: string) => { if (active && !active.input) active.input = body; };
  const end = (at: string, id?: string) => {
    if (!active || (id && id !== active.id)) { missing.add('native.boundaries'); return; }
    turns.push({ index: active.index, input: active.input, startedAt: active.startedAt, endedAt: at,
      durationMs: Date.parse(at) - Date.parse(active.startedAt) });
    active = null;
  };
  for (const [offset, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let row: ObjectValue;
    try { row = object(JSON.parse(line)); } catch { missing.add('native.integrity'); continue; }
    if (row.isSidechain === true) { missing.add('native.sidechain'); continue; }
    const at = string(row.timestamp); const time = Date.parse(at);
    if (!Number.isFinite(time) || time < previousTime) missing.add('native.integrity');
    previousTime = time; timestamps.push(at);
    const add = (event: Omit<EventRecord, 'seq' | 'at' | 'session' | 'turn'>) => {
      const seq = events.length;
      events.push({ ...event, seq, at, session: 'A', turn: active && !uncertainTurns.has(active.index) ? active.index : null } as EventRecord);
      locations[seq] = `${file}:${offset + 1}`;
    };
    const message = (role: 'assistant' | 'user', value: string, inputSource?: Extract<EventRecord, { kind: 'message' }>['inputSource']) => {
      if (value) add({ kind: 'message', actor: role === 'assistant' ? 'agent' : 'script-human', role, text: value, ...(inputSource ? { inputSource } : {}) } as EventRecord);
    };
    const call = (id: string, name: string, args: unknown) => {
      if (!id || calls.has(id)) { missing.add('native.integrity'); return; }
      const tool = /(?:^|__)wayfinder__(.+)$/.exec(name)?.[1];
      const event = { kind: 'tool-call', actor: 'agent', callId: id, server: tool ? 'wayfinder' : client,
        tool: tool ?? name, arguments: parsed(args), result: absent('native result absent'), failed: false,
        requestId: absent('native log does not expose JSON-RPC request ID') } as EventRecord;
      add(event); calls.set(id, events.at(-1)! as Extract<EventRecord, { kind: 'tool-call' }>);
    };
    const result = (id: string, value: unknown, failed = false) => {
      const c = calls.get(id);
      if (!c) { missing.add('native.integrity'); return; }
      const decoded = parsed(value); const obj = object(decoded);
      const unwrapped = obj.structuredContent ?? obj.structured_content
        ?? (Array.isArray(decoded) ? parsed(content(decoded)) : obj.content ? parsed(content(obj.content)) : decoded);
      c.result = /wayfinder/i.test(c.server) && ['map_create', 'map_apply'].includes(c.tool) && classifyResult(unwrapped) === 'transport-failure'
        ? absent('write result is not decodable; inspect the raw native result') : known(unwrapped);
      c.failed = failed || errorFlag(obj.is_error) || rejection(content(value));
      // A question answer is an input at the result's time, not at the earlier call's time.
      if (!c.failed && questionTool(c.tool) === 'blocking') {
        const answers = object(decoded).answers;
        const source = { kind: 'question-tool' as const, tool: c.tool, callId: c.callId };
        if (answers && typeof answers === 'object' && Object.keys(answers).length) message('user', JSON.stringify(answers), source);
        else if (/^User has answered your questions:/i.test(content(value))) message('user', content(value), source);
      }
      // Completed work is timed at the result, so work finishing after an answer cannot prove preparation.
      if (questionTool(c.tool) === null) { c.at = at; locations[c.seq] = `${file}:${offset + 1}`; }
    };
    if (client === 'codex') {
      const p = object(row.payload);
      if (row.type === 'session_meta') { setId(string(p.id)); if (p.cli_version) version = known(string(p.cli_version)); }
      else if (row.type === 'turn_context') {
        setModel(p.model); setEffort(p.effort);
      } else if (row.type === 'event_msg') {
        if (p.type === 'task_started') start(at, string(p.turn_id));
        else if (p.type === 'task_complete') end(at, string(p.turn_id));
        else if (p.type === 'task_aborted' || p.type === 'turn_aborted' || p.type === 'context_compacted') missing.add('native.boundaries');
        else if (!['agent_message', 'user_message', 'token_count', 'agent_reasoning', 'agent_reasoning_raw_content', 'thread_settings_applied'].includes(string(p.type))) missing.add('native.unhandled');
        // agent_message/user_message duplicate response_items; never double count them.
      } else if (row.type === 'response_item') {
        if (p.type === 'message' && (p.role === 'assistant' || p.role === 'user')) {
          const body = content(p.content);
          if (p.role === 'user' && /^(?:<environment_context>|<system-reminder>|# AGENTS\.md instructions)/.test(body.trim())) continue;
          message(p.role, body);
          if (p.role === 'user') rememberInput(body);
        } else if (p.type === 'function_call' || p.type === 'custom_tool_call') call(string(p.call_id), string(p.name), p.arguments ?? p.input);
        else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') result(string(p.call_id), p.output, errorFlag(p.is_error));
        else if (p.type !== 'reasoning' && p.type !== 'message') missing.add('native.unhandled');
      } else if (row.type !== 'session_meta') missing.add('native.unhandled');
    } else {
      setId(string(row.sessionId)); if (row.version) version = known(string(row.version));
      if (row.type === 'system' && row.subtype === 'init') {
        setEffort(row.effort); setModel(row.model);
        continue;
      }
      const m = object(row.message);
      setModel(m.model);
      if (/^\[Request interrupted by user/.test(content(m.content).trim())) {
        if (active) end(at);
        continue;
      }
      if (row.isMeta === true || row.isCompactSummary === true) continue;
      if (row.type === 'user' || row.type === 'assistant') {
        const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
        // A tool result can share its row with actual user input. Exclude only recognized rejection
        // notices, block by block; excluding the whole row would erase a nudge or a contrary answer.
        const humanText = row.type === 'user' ? blocks.map(object)
          .filter(b => b.type === 'text' && string(b.text).trim() && !rejectionNotice(string(b.text))).map(b => string(b.text)).join('\n') : '';
        // A missing end marker is not proof that a second human text was delivered mid-turn.
        // Keep this uncertainty on the affected events; no invented Claude delivery marker is accepted.
        if (humanText) markUncertain();
        if (humanText && !active) start(at, string(row.uuid), humanText);
        for (const b of blocks.map(object)) {
          if (b.type === 'text') { if (row.type === 'assistant' || !rejectionNotice(string(b.text))) message(row.type === 'user' ? 'user' : 'assistant', string(b.text)); }
          else if (b.type === 'tool_use' && row.type === 'assistant') call(string(b.id), string(b.name), b.input);
          else if (b.type === 'tool_result' && row.type === 'user') result(string(b.tool_use_id), b.content, errorFlag(b.is_error));
          else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') missing.add('native.unhandled');
        }
        if (m.stop_reason === 'end_turn') end(at);
      } else if (row.type === 'system' && row.subtype === 'turn_duration') {
        if (active) end(at); // Often accompanies the already recorded end_turn.
      } else if (row.type === 'queue-operation') markUncertain();
      else if (row.type !== 'file-history-snapshot') missing.add('native.unhandled');
    }
  }
  if (active || !turns.length) missing.add('native.boundaries');
  if (!nativeId.known) missing.add('sessions.nativeId');
  if (!events.length) missing.add('events');
  if (!version.known) missing.add('client.version');
  if (!model.known) missing.add('combination.visibleModel');
  if (!effort.known) missing.add('combination.effort');
  // Commands, reads, delegation and file changes remain in tool arguments/results. Do not claim exhaustive classes.
  for (const kind of ['command', 'file-read', 'file-change', 'delegation', 'resource-read']) missing.add(`events.${kind}`);
  const sources = events.map(e => ({ event: e, source: locations[e.seq]! })).sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at));
  sources.forEach(({ event, source }, seq) => { event.seq = seq; locations[seq] = source; if (event.turn === null) missing.add(`events[${seq}].turn`); });
  return { events: sources.map(s => s.event), session: { label: 'A', nativeId, clientId, mcpSessionIds: absent('not correlated with protocol journal'), turns },
    locations, missing: [...missing], model, version, effort,
    range: timestamps.length && !missing.has('native.integrity') ? known({ startedAt: timestamps[0]!, endedAt: timestamps.at(-1)! }) : absent('native timestamp range unavailable') };
}
