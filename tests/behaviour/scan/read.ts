// Read explicitly selected files only. No client config, credential file, database, network or process access.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { classifyResult, entries, resultClasses } from '../evidence.ts';
import type { Entry } from '../evidence.ts';
import type { CallResult } from '../../../src/call-metadata.ts';
import type { Call, Inputs, Launch, Manifest, NativeCall, Session, Usage } from './types.ts';

export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sessionKey = (harness: string, nativeId: string, agentId?: string | null) => `${harness}:${nativeId}${agentId ? `/subagent/${agentId}` : ''}`;
export const nativeHarness = (value: unknown): Session['harness'] => value === 'codex' || value === 'claude' || value === 'chatgpt' ? value : 'unknown';
export function mergeUsage(s: Session, next: Usage, basis: string[] = []): void {
  s.usageBasis.push(...basis);
  if (next === 'unknown' || s.ambiguities.includes('usage')) return;
  if (s.usage !== 'unknown' && s.usage !== next) { s.usage = 'unknown'; s.ambiguities.push('usage'); s.gaps.push('Conflicting usage evidence'); }
  else s.usage = next;
}
type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const strings = (v: unknown): string[] => array(v).filter((x): x is string => typeof x === 'string');
const usage = (v: unknown): Usage => v === 'normal' || v === 'test' || v === 'research' ? v : 'unknown';
const entry = (v: unknown): Entry | 'unknown' => entries.includes(v as Entry) ? v as Entry : 'unknown';
const known = (v: unknown): unknown => obj(v).known === true ? obj(v).value : null;
const parse = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const textContent = (v: unknown): string => typeof v === 'string' ? v : array(v).map(x => str(obj(x).text) ?? '').filter(Boolean).join('\n');
const toolName = (name: unknown): string | null => typeof name === 'string'
  ? /^(?:mcp__|mcp_)?wayfinder(?:__|_)(map_create|map_apply|map_list|map_read)$/.exec(name)?.[1] ?? null : null;

function claudeHumanWords(value: unknown, questions: string[]): string {
  const answers = obj(obj(value).answers);
  const annotations = obj(obj(value).annotations);
  // Structured values preserve free text without parsing the agent's question/summary.
  // Only notes are human-authored; annotation previews and question keys are not.
  return questions.flatMap(question => {
    const answer = str(answers[question]);
    if (!answer?.trim()) return [];
    const notes = str(obj(annotations[question]).notes);
    return notes?.trim() ? [answer, notes] : [answer];
  }).join('\n');
}

export function blankSession(key: string, harness: Session['harness'], nativeId: string | null): Session {
  return { key, harness, nativeId, subagent: false, model: null, effort: null, entry: 'unknown', usage: 'unknown',
    usageBasis: [], sources: [], skill: [], mcpSessionIds: [], fingerprints: [], calls: [], fragments: [], gaps: [], ambiguities: [], correlationBasis: [] };
}

/** Parse the clients' native JSONL envelopes, retaining original words and stable line references. */
export function nativeSessions(rows: { value: ObjectValue; ref: string }[], harness: 'codex' | 'claude', fileRef: string): Session[] {
  const sessions = new Map<string, Session>();
  const completedCalls = new WeakSet<NativeCall>();
  const callInputs = new WeakMap<NativeCall, Session['fragments'][number]>();
  const claudeQuestions = new Map<Session, Map<string, string[]>>();
  let current: Session | undefined;
  const get = (id: string | null, subagentId: string | null = null) => {
    const key = sessionKey(harness, id ?? fileRef, subagentId);
    if (!sessions.has(key)) sessions.set(key, blankSession(key, harness, id));
    return sessions.get(key)!;
  };
  const addCall = (s: Session, id: string | null, name: string | null, args: unknown, ref: string) => {
    if (!name) return;
    const existing = harness === 'codex' && id ? s.calls.find(c => c.id === id) : undefined;
    const call: NativeCall = existing ?? { id: id ?? ref, tool: name, ref, mapId: null, requestId: null, requestIdType: null, result: null };
    call.mapId ??= str(obj(parse(args)).mapId);
    // A function_call arriving after its completion still supplies the input and its locator.
    call.ref = ref;
    if (!existing) s.calls.push(call);
    const input = { ref, role: 'tool' as const, text: JSON.stringify({ name, arguments: parse(args) }) };
    const previous = callInputs.get(call);
    if (previous) Object.assign(previous, input);
    else { s.fragments.push(input); callInputs.set(call, input); }
    return call;
  };
  const result = (s: Session, id: string | null, value: unknown, ref: string) => {
    const call = s.calls.find(c => c.id === id);
    if (!call) return;
    const parsed = parse(value);
    const content = obj(parsed).structuredContent ?? obj(parsed).structured_content
      ?? parse(textContent(obj(parsed).content)) ?? parsed;
    call.result = classifyResult(content);
    call.resultRef = ref;
    s.fragments.push({ ref, role: 'tool', text: typeof value === 'string' ? value : JSON.stringify(value) });
  };
  const message = (s: Session, role: unknown, value: unknown, ref: string) => {
    const text = textContent(value);
    if ((role !== 'user' && role !== 'assistant') || !text) return;
    if (role === 'user' && /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<INSTRUCTIONS>|<user_instructions>)/.test(text.trim())) return;
    s.fragments.push({ ref, role, text });
    // A directory's Skill catalog and server instructions are not a Skill invocation.
    if (role === 'user' && (/^(?:[@$]wayfinder\b|(?:please )?use (?:the )?wayfinder skill\b)/i.test(text.trim())
      || harness === 'claude' && /<command-name>\/wayfinder<\/command-name>/.test(text))) s.skill.push(ref);
  };
  const setting = (s: Session, field: 'model' | 'effort', value: unknown, ref: string) => {
    const next = str(value);
    if (!next) return;
    const changed = `Multiple ${field} values in this session`;
    if (s.ambiguities.includes(field)) { s.gaps.push(`${changed}: ${next} at ${ref}`); return; }
    if (s[field] && s[field] !== next) { s.gaps.push(`${changed}: ${s[field]}, ${next} at ${ref}`); s.ambiguities.push(field); s[field] = null; }
    else s[field] = next;
  };
  for (const { value: row, ref } of rows) {
    const p = obj(row.payload);
    if (harness === 'codex') {
      if (row.type === 'session_meta') {
        current = get(str(p.id));
        current.subagent ||= obj(p.source).subagent !== undefined;
      }
      current ??= get(null);
      const s = current;
      if (row.type === 'turn_context') { setting(s, 'model', p.model, ref); setting(s, 'effort', p.effort, ref); }
      if (row.type === 'event_msg' && p.type === 'thread_settings_applied') {
        const settings = obj(p.thread_settings);
        setting(s, 'model', settings.model, ref);
        setting(s, 'effort', settings.reasoning_effort ?? settings.model_reasoning_effort, ref);
      }
      if (row.type === 'event_msg' && p.type === 'item_completed') {
        const item = obj(p.item);
        if (item.type === 'McpToolCall' && item.server === 'wayfinder'
          && typeof item.tool === 'string' && ['map_create', 'map_apply', 'map_list', 'map_read'].includes(item.tool)
          && (item.status === 'completed' || item.status === 'failed')) {
          const id = str(item.id) ?? ref;
          const call = s.calls.find(c => c.id === id) ?? addCall(s, id, item.tool, item.arguments, ref);
          if (call) call.turnId = str(p.turn_id);
          // Product kinds, not client status/isError, establish the outcome (src/call-metadata.ts).
          // infrastructure_error is service-failure; absent/unrecognized results are transport-failure.
          result(s, id, item.result ?? null, ref);
          if (call) completedCalls.add(call);
        }
      }
      if (row.type === 'response_item') {
        if (p.type === 'message') message(s, p.role, p.content, ref);
        if (p.type === 'function_call') {
          addCall(s, str(p.call_id), toolName(p.name), p.arguments, ref);
        }
        if (p.type === 'function_call_output') {
          const call = s.calls.find(c => c.id === str(p.call_id));
          if (!call || !completedCalls.has(call)) result(s, str(p.call_id), p.output, ref);
        }
      }
      // EventMsg-only recordings can contain messages instead of ResponseItems. Do not count a mirror twice.
      if (row.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) {
        const role = p.type === 'user_message' ? 'user' : 'assistant';
        if (!s.fragments.some(f => f.role === role && f.text === p.message)) message(s, role, p.message, ref);
      }
    } else {
      // Bookkeeping rows such as summary/file-history-snapshot do not create conversations.
      if ((row.type !== 'user' && row.type !== 'assistant') || row.isCompactSummary === true) continue;
      const id = str(row.sessionId);
      const sidechain = row.isSidechain === true;
      // Claude subagents share the parent's sessionId: never attach their calls to the parent's launch.
      const s = get(id, sidechain ? str(row.agentId) ?? fileRef : null);
      s.subagent ||= sidechain;
      const m = obj(row.message);
      setting(s, 'model', m.model, ref);
      if (row.type === 'user' || row.type === 'assistant') {
        if (row.isMeta !== true && !(row.type === 'user' && /<(?:local-command-stdout|local-command-caveat|command-message)>/.test(textContent(m.content))
          && !/<command-name>\/wayfinder<\/command-name>/.test(textContent(m.content)))) message(s, row.type, m.content, ref);
        const blocks = array(m.content).map(obj);
        const singleResult = blocks.filter(b => b.type === 'tool_result').length === 1;
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            addCall(s, str(block.id), toolName(block.name), block.input, ref);
            if (block.name === 'AskUserQuestion' && row.type === 'assistant' && row.isMeta !== true && str(block.id)) {
              if (!claudeQuestions.has(s)) claudeQuestions.set(s, new Map());
              claudeQuestions.get(s)!.set(String(block.id), array(obj(block.input).questions).flatMap(q => str(obj(q).question) ?? []));
              s.fragments.push({ ref, role: 'assistant', text: JSON.stringify({ name: block.name, input: block.input }) });
            }
            if (block.name === 'Skill' && /^(?:[^:]+:)?wayfinder$/.test(String(obj(block.input).skill))) {
              s.skill.push(ref); s.fragments.push({ ref, role: 'tool', text: JSON.stringify({ name: 'Skill', skill: obj(block.input).skill }) });
            }
          }
          if (block.type === 'tool_result') {
            const id = str(block.tool_use_id);
            const questions = id ? claudeQuestions.get(s)?.get(id) : undefined;
            // toolUseResult belongs to the row, so multiple results would make its owner ambiguous.
            const humanWords = questions && row.type === 'user' && row.isMeta !== true && block.is_error !== true
              && singleResult ? claudeHumanWords(row.toolUseResult, questions) : '';
            if (humanWords) s.fragments.push({ ref, role: 'user', text: humanWords });
            else if (questions) s.fragments.push({ ref, role: 'tool', text: textContent(block.content) });
            else result(s, id, textContent(block.content), ref);
          }
        }
      }
    }
  }
  for (const s of sessions.values()) {
    s.sources.push(fileRef);
    if (!s.nativeId) s.gaps.push('Native session ID missing');
    if (s.calls.length) s.gaps.push('Native tool-use IDs are not JSON-RPC request IDs; correlation needs a launch or Attempt bridge');
  }
  return [...sessions.values()];
}

function readAttempt(value: ObjectValue, ref: string): Session[] {
  if (value.schema !== 'wayfinder-behaviour-attempt/1' || !str(value.attemptId) || !Array.isArray(value.sessions)) throw new Error('Invalid Attempt');
  const combination = obj(value.combination);
  const harness = nativeHarness(combination.harness);
  return array(value.sessions).map(obj).map(record => {
    const nativeId = str(known(record.nativeId));
    const s = blankSession(nativeId ? sessionKey(harness, nativeId) : `attempt:${value.attemptId}:${record.label}`, harness, nativeId);
    s.usage = 'test'; s.usageBasis = [`${ref}: B01 Attempt ${value.attemptId}`]; s.sources = [ref];
    s.model = str(known(combination.visibleModel)) ?? str(combination.requestedModel);
    s.effort = str(known(combination.effort)); s.entry = entry(value.entry);
    s.mcpSessionIds = strings(known(record.mcpSessionIds));
    for (const event of array(value.events).map(obj).filter(e => e.session === record.label && e.actor === 'agent')) {
      const eventRef = `${ref}/events/${event.seq}`;
      if (event.kind === 'message' && (event.role === 'user' || event.role === 'assistant') && typeof event.text === 'string') {
        s.fragments.push({ ref: eventRef, role: event.role, text: event.text });
      }
      if (event.kind === 'tool-call' && /wayfinder/i.test(String(event.server)) && /^map_(apply|create|list|read)$/.test(String(event.tool))) {
        s.calls.push({ id: str(event.callId) ?? eventRef, tool: String(event.tool), ref: eventRef, mapId: str(obj(event.arguments).mapId),
          requestId: str(known(event.requestId)), requestIdType: null,
          result: obj(event.result).known === true ? classifyResult(known(event.result)) : null });
        s.fragments.push({ ref: eventRef, role: 'tool', text: JSON.stringify({ arguments: event.arguments, result: event.result }) });
      }
    }
    s.gaps.push(...strings(value.missing).map(g => `Attempt missing: ${g}`));
    if (obj(value.run).completeness !== 'complete') s.gaps.push('Attempt incomplete');
    return s;
  });
}

export function validateManifest(value: unknown): asserts value is Manifest {
  const m = obj(value);
  if (m.schema !== 'wayfinder-usage-input/1' || !Array.isArray(m.sources) || m.sources.length === 0) throw new Error('Explicit scan sources required');
  const ids = new Set<string>();
  for (const s of m.sources.map(obj)) {
    if (typeof s.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(s.id) || ids.has(s.id)
      || !['codex', 'claude', 'calls', 'gaps', 'launches', 'attempt'].includes(String(s.kind)) || !str(s.path)) throw new Error('Invalid scan source');
    ids.add(s.id);
  }
  if (m.secrets !== undefined && (!Array.isArray(m.secrets) || m.secrets.some(s => typeof s !== 'string' || !s))) throw new Error('Invalid secret list');
  if (m.labels !== undefined && (!Array.isArray(m.labels) || m.labels.map(obj).some(l => !['codex', 'claude'].includes(String(l.harness))
    || !str(l.nativeId) || l.agentId !== undefined && !str(l.agentId) || usage(l.usage) === 'unknown' || !str(l.basis)))) throw new Error('Invalid usage label');
}

export function loadInputs(manifest: Manifest, base: string): Inputs {
  validateManifest(manifest);
  const out: Inputs = { sessions: [], calls: [], launches: [], gaps: [], sources: [] };
  for (const source of manifest.sources) {
    const root = resolve(base, source.path);
    const files: string[] = [];
    const walk = (path: string) => {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { out.gaps.push(`${source.id}: skipped unsafe file`); return; }
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
        else if (path.endsWith(source.kind === 'attempt' ? '.json' : '.jsonl')) files.push(path);
      } catch { out.gaps.push(`${source.id}: missing or unreadable source`); }
    };
    walk(root);
    out.sources.push({ id: source.id, kind: source.kind, files: files.length });
    if (!files.length) out.gaps.push(`${source.id}: no input files discovered`);
    for (const file of files) {
      const fileRef = `${source.id}/${relative(root, file) || basename(file)}`;
      let content: string;
      try { content = readFileSync(file, 'utf8'); } catch { out.gaps.push(`${fileRef}: unreadable file`); continue; }
      if (source.kind === 'attempt') {
        try { out.sessions.push(...readAttempt(obj(JSON.parse(content)), fileRef)); } catch { out.gaps.push(`${fileRef}: invalid Attempt`); }
        continue;
      }
      const rows: { value: ObjectValue; ref: string }[] = [];
      content.split('\n').forEach((line, index) => {
        if (!line.trim()) return;
        const ref = `${fileRef}#L${index + 1}`;
        try {
          const v: unknown = JSON.parse(line);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Not an object');
          rows.push({ value: obj(v), ref });
        } catch { out.gaps.push(`${ref}: malformed or truncated record`); }
      });
      if (source.kind === 'codex' || source.kind === 'claude') {
        if (!rows.length) out.gaps.push(`${fileRef}: empty or unreadable native records`);
        const sessions = nativeSessions(rows, source.kind, fileRef);
        const parseGaps = out.gaps.filter(g => g.startsWith(`${fileRef}#`));
        sessions.forEach(s => s.gaps.push(...parseGaps));
        out.sessions.push(...sessions);
        continue;
      }
      for (const { value: v, ref } of rows) {
        if ((source.kind === 'calls' || source.kind === 'gaps') && (v.schema === 'wayfinder-service-call-gap/1' || v.schema === 'wayfinder-service-call-summary/1')) {
          if (typeof v.missingObservations !== 'number' || v.missingObservations < 0) out.gaps.push(`${ref}: invalid gap counter`);
          else if (v.missingObservations > 0) out.gaps.push(`${ref}: ${v.missingObservations} missing service observations (${v.serviceStartedAt})`);
        } else if (source.kind === 'calls' && v.schema === 'wayfinder-service-call/1' && str(v.serviceStartedAt)
          && Number.isSafeInteger(v.sequence) && Number(v.sequence) > 0 && Number.isSafeInteger(v.missingObservations) && Number(v.missingObservations) >= 0
          && [...resultClasses, 'stream-not-supported', 'ok'].includes(String(v.result))
          && ['mcpSessionId', 'presentedMcpSessionId', 'requestId', 'requestIdHash', 'credentialFingerprint', 'clientId', 'tool', 'mapId'].every(k => v[k] === null || typeof v[k] === 'string')) {
          const c: Call = { ref, serviceStartedAt: String(v.serviceStartedAt), sequence: Number(v.sequence), missingObservations: Number(v.missingObservations),
            mcpSessionId: str(v.mcpSessionId), presentedMcpSessionId: str(v.presentedMcpSessionId), requestId: str(v.requestId),
            requestIdType: v.requestIdType === 'string' || v.requestIdType === 'number' ? v.requestIdType : null, requestIdHash: str(v.requestIdHash),
            credentialFingerprint: str(v.credentialFingerprint), clientId: str(v.clientId), tool: str(v.tool), mapId: str(v.mapId),
            result: v.httpStatus === 401 ? 'unauthenticated' : v.result as CallResult };
          out.calls.push(c);
          if (c.missingObservations > 0) out.gaps.push(`${ref}: ${c.missingObservations} missing service observations`);
        } else if (source.kind === 'launches' && v.schema === 'wayfinder-launch/1') {
          const l: Launch = { ref, harness: str(v.harness), model: str(v.model), effort: str(v.effort), entry: entry(v.entry), usage: usage(v.usage),
            nativeSessionId: str(v.nativeSessionId), credentialFingerprint: str(v.credentialFingerprint) };
          out.launches.push(l);
        } else out.gaps.push(`${ref}: unsupported or invalid record`);
      }
    }
  }
  for (const processStart of new Set(out.calls.map(c => c.serviceStartedAt))) {
    const sequences = [...new Set(out.calls.filter(c => c.serviceStartedAt === processStart).map(c => c.sequence))].sort((a,b) => a-b);
    let previous = 0;
    for (const sequence of sequences) {
      if (sequence > previous + 1) out.gaps.push(`Service ${processStart}: observation sequence gap ${previous + 1}..${sequence - 1}`);
      previous = sequence;
    }
  }
  return out;
}
