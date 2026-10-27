import { expect, test } from 'vitest';
import { attemptSchema } from '../evidence.ts';
import type { AttemptRecord, EventRecord, UpgradeContract, WireRevision } from '../evidence.ts';
import { exactUpgradeHistory, noCanaryReplyViolation, replyCanary } from '../upgrade-evidence.ts';
import { replyRule, ticketRule } from '../../helpers/canary-release.mjs';
import { upgradeChecks } from '../upgrade-checks.ts';
import { receiptsFrom } from './normalize.ts';
import type { RelayObservation } from './relay.ts';
import { upgradeRules } from './upgrade.ts';

// Synthetic native shapes only; these checks need neither a sandbox nor a running service.
const contract = (version: string): UpgradeContract => ({ version, instructions: `Wayfinder rules\nversion: ${version}`,
  toolDescriptions: { map_create: `Create at ${version}`, map_apply: `Apply at ${version}` }, markdown: `Workflow ${version}` });
const upgrade = (mode: 'process' | 'resume' = 'process'): NonNullable<AttemptRecord['upgrade']> => ({ mode,
  contracts: { before: contract('1.0.0'), after: contract('2.0.0') }, writes: [],
  restart: { seq: 2, beforePid: 101, afterPid: 102, port: 49152 } });
const definitions = (c: UpgradeContract) => Object.entries(c.toolDescriptions).map(([name, description]) => ({ name, description, inputSchema: { type: 'object' } }));
const toolList = (c: UpgradeContract) => Object.entries(c.toolDescriptions).map(([name, description]) => ({ name: `mcp__wayfinder__${name}`,
  description: `${c.instructions}\n\nversion: ${c.version}\n\n${description}` }));
const output = (value: unknown, blocks = true) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'exec_1',
  output: blocks ? [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: JSON.stringify(value) }] : JSON.stringify(value) } });
const rollout = (text: string) => ({ text, visibleModel: 'fixture', effort: 'low', cliVersion: '0.164.0' });
const wire = (c: UpgradeContract, turn = 0): (RelayObservation & { turn: number })[] => [{ phase: 'response', at: '', requestId: 1,
  method: 'tools/list', sessionId: 'mcp-session', status: 200, turn, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: definitions(c) } }) }];

const message = (seq: number, text: string): EventRecord => ({ seq, at: '', actor: 'agent', session: 'A', turn: 1,
  kind: 'message', role: 'assistant', text });
const completed = (event: EventRecord) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: event.kind === 'message'
  ? { type: 'AgentMessage', content: [{ type: 'text', text: event.text }] }
  : event.kind === 'tool-call' ? { type: 'McpToolCall', server: event.server, tool: event.tool, arguments: event.arguments } : {} } });
const response = (event: EventRecord) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: event.kind === 'message' ? event.text : '' }] } });
function replyAttempt() {
  const a = historyAttempt(false);
  a.upgrade = upgrade('resume');
  a.upgrade.contracts.after.instructions += `\n${replyRule}`;
  a.upgrade.contracts.after.markdown += `\n${replyRule}`;
  return a;
}

test.each(['Plain reply.', 'LANTERN Current instructions.'])('split discovery enforces the first instructions without backdating full tools (%s)', text => {
  const a = replyAttempt();
  const u = a.upgrade!;
  const list = toolList(u.contracts.after);
  a.events = [message(3, text), message(4, 'LANTERN Done.')];
  const native = [output([list[0]]), response(a.events[0]!), completed(a.events[0]!),
    output([list[1]]), response(a.events[1]!), completed(a.events[1]!)].join('\n');
  a.given = upgradeRules(u, rollout(native), a.events, wire(u.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe(text.startsWith('LANTERN') ? 'holds' : 'violated');
  expect(a.given.findLast(g => g.fromSeq <= 3)).toMatchObject({ instructions: { known: true }, toolDescriptions: { known: false } });
  expect(a.given.findLast(g => g.fromSeq <= 4)).toMatchObject({ instructions: { known: true }, toolDescriptions: { known: true } });
});

test.each([false, true])('a Resource before discovery covers the intervening reply without importing future definitions (runner sort=%s)', sorted => {
  const a = replyAttempt();
  const u = a.upgrade!;
  const resource = { contents: [{ uri: 'wayfinder://workflow/exploration', text: `version: ${u.contracts.after.version}\n\n${u.contracts.after.markdown}` }] };
  const read: EventRecord = { seq: 3, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'tool-call', callId: 'read',
    server: 'wayfinder', tool: 'read_mcp_resource', arguments: { uri: 'wayfinder://workflow/exploration' },
    result: { known: true, value: resource }, failed: false, requestId: { known: true, value: '2' } };
  a.events = [read, { seq: 4, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true },
    message(5, 'I read the rules.'), message(6, 'LANTERN Done.')];
  const native = [completed(read), output(resource), completed(a.events[2]!), output(toolList(u.contracts.after)), completed(a.events[3]!)].join('\n');
  const log: (RelayObservation & { turn: number })[] = [...wire(u.contracts.after, 1), { phase: 'response', at: '', requestId: 2,
    method: 'resources/read', sessionId: 'mcp-session', status: 200, turn: 1, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: resource }) }];
  a.given = upgradeRules(u, rollout(native), a.events, log, 'A', 1, 3);
  if (sorted) a.given.sort((a, b) => a.fromSeq - b.fromSeq);
  expect(noCanaryReplyViolation(a).status).toBe('violated');
  expect(replyCanary(a).status).toBe('violated');
  expect(a.given.find(g => g.fromSeq === 4)).toMatchObject({ instructions: { known: false }, toolDescriptions: { known: false }, resourceText: { known: true } });
  expect(a.given.find(g => g.fromSeq === 6)).toMatchObject({ instructions: { known: true }, toolDescriptions: { known: true } });
  // The checker also handles a historical record whose phase array is out of order.
  a.given.reverse();
  expect(noCanaryReplyViolation(a).status).toBe('violated');
});

test.each(['missing', 'response-first', 'completion-first'])('a missing early completion cannot backdate discovery before its assistant response (%s)', order => {
  const a = replyAttempt();
  const u = a.upgrade!;
  a.events = [message(3, 'I have not discovered tools yet.'), message(4, 'LANTERN Done.')];
  const early = order === 'completion-first' ? [completed(a.events[0]!), response(a.events[0]!)]
    : [response(a.events[0]!), ...(order === 'response-first' ? [completed(a.events[0]!)] : [])];
  const native = [...early,
    output(toolList(u.contracts.after)), response(a.events[1]!), completed(a.events[1]!)].join('\n');
  a.given = upgradeRules(u, rollout(native), a.events, wire(u.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe('holds');
  expect(a.given[0]!.fromSeq).toBe(4);
});

test.each([false, true])('an unpositioned discovery stays unknown even after another matched discovery (rediscovery=%s)', rediscovery => {
  const a = replyAttempt();
  const u = a.upgrade!;
  const read: EventRecord = { seq: 5, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'tool-call', callId: 'read',
    server: 'wayfinder', tool: 'map_read', arguments: { mapId: 'Upgrade.Probe' },
    result: { known: true, value: { kind: 'found' } }, failed: false, requestId: { known: true, value: '5' } };
  a.events = [message(3, 'LANTERN Start.'), message(4, 'Plain reply after the unpositioned discovery.'), read, message(6, 'LANTERN End.')];
  const native = [completed(a.events[0]!), completed(message(0, 'No matching normalized Event.')), output(toolList(u.contracts.after)),
    completed(a.events[1]!), completed(read), ...(rediscovery ? [output(toolList(u.contracts.after))] : []), completed(a.events[3]!)].join('\n');
  a.given = upgradeRules(u, rollout(native), a.events, wire(u.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe('unknown');
  expect(replyCanary(a).status).toBe('unknown');
  expect(a.given[0]).toMatchObject({ instructions: { known: false, reason: expect.stringContaining('unpositioned') },
    toolDescriptions: { known: false, reason: expect.stringContaining('unpositioned') } });
});

test.each([true, false])('code-mode tool discovery exposes initial rules and retains them across a process restart (blocks=%s)', blocks => {
  const u = upgrade();
  const phases = upgradeRules(u, rollout(output(toolList(u.contracts.before), blocks)), [], wire(u.contracts.before), 'A', 0, 0);
  expect(phases).toHaveLength(2);
  for (const phase of phases) {
    expect(phase.instructions).toEqual({ known: true, value: u.contracts.before.instructions });
    expect(phase.toolDescriptions).toEqual({ known: true, value: u.contracts.before.toolDescriptions });
    expect(phase.toolDefinitions).toEqual({ known: true, value: definitions(u.contracts.before) });
    expect(phase.rulesSource).toMatchObject({ kind: 'instructions', versionLine: 'version: 1.0.0' });
  }
  expect(phases[1]).toMatchObject({ phase: 'after-restart', fromSeq: 2, serviceVersion: '2.0.0' });
});

test('a resumed process exposes fresh code-mode rules only when it lists them again', () => {
  const u = upgrade('resume');
  const fresh = upgradeRules(u, rollout(output(toolList(u.contracts.after))), [], wire(u.contracts.after, 1), 'A', 1, 3);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ instructions: { known: true, value: u.contracts.after.instructions },
    toolDescriptions: { known: true, value: u.contracts.after.toolDescriptions } });
  const absent = upgradeRules(u, rollout(''), [], wire(u.contracts.after, 1), 'A', 1, 3);
  expect(absent[0]).toMatchObject({ instructions: { known: false }, toolDescriptions: { known: false } });
});

test.each(['resource', 'other-server', 'malformed'])('code-mode %s output cannot prove native rule definitions', shape => {
  const u = upgrade();
  const list = toolList(u.contracts.before);
  const value = shape === 'resource' ? { contents: [{ uri: 'wayfinder://workflow/exploration', text: JSON.stringify(list) }] }
    : shape === 'other-server' ? list.map(t => ({ ...t, name: t.name.replace('wayfinder', 'unrelated') })) : 'invalid JSON';
  const record = JSON.parse(output(value));
  if (shape === 'malformed') record.payload.output[1].text = '{';
  const phases = upgradeRules(u, rollout(JSON.stringify(record)), [], wire(u.contracts.before), 'A', 0, 0);
  for (const phase of phases) expect(phase).toMatchObject({ instructions: { known: false }, toolDescriptions: { known: false } });
});

function lateDiscoveryAttempt(restartSeq = 2): AttemptRecord {
  const a = historyAttempt(false);
  const u = upgrade('resume');
  u.restart!.seq = restartSeq;
  u.contracts.after.instructions += `\n${replyRule}`;
  u.contracts.after.markdown += `\n${replyRule}`;
  a.upgrade = u;
  a.subject.id = 'U-codex-resume';
  const resource = { contents: [{ uri: 'wayfinder://workflow/exploration', text: `version: ${u.contracts.after.version}\n\n${u.contracts.after.markdown}` }] };
  const base = { at: '', actor: 'agent' as const, session: 'A', turn: 1 };
  const message = (seq: number, text: string): EventRecord => ({ ...base, seq, kind: 'message', role: 'assistant', text });
  const call = (seq: number, tool: string): EventRecord => ({ ...base, seq, kind: 'tool-call', callId: `A:1:${seq}`, server: 'wayfinder', tool,
    arguments: tool === 'read_mcp_resource' ? { uri: 'wayfinder://workflow/exploration' } : { mapId: 'Upgrade.Probe' },
    result: { known: true, value: tool === 'read_mcp_resource' ? resource : seq === 5 ? { kind: 'rejected', code: 'version_mismatch' }
      : { kind: tool === 'map_read' ? 'found' : 'committed' } },
    failed: false, requestId: { known: true, value: `${seq}` } });
  a.events = [message(3, 'I will continue the probe.'), call(4, 'map_read'), call(5, 'map_apply'), call(6, 'list_mcp_resources'), call(7, 'read_mcp_resource'),
    { ...base, seq: 8, kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true },
    message(9, 'LANTERN I have the current rules.'), call(10, 'map_read'), call(11, 'map_apply'), message(12, 'LANTERN Added the Ticket.')];
  const native = [
    ...a.events.slice(0, 3).map(completed), output(toolList(u.contracts.after)),
    ...a.events.slice(3, 5).map(completed), output(resource), ...a.events.slice(6).map(completed),
  ].join('\n');
  const log: (RelayObservation & { turn: number })[] = [...wire(u.contracts.after, 1), { phase: 'response', at: '', requestId: 2,
    method: 'resources/read', sessionId: 'mcp-session', status: 200, turn: 1, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: resource }) }];
  const initial = { ...u }; delete initial.restart;
  a.given = [...upgradeRules(initial, rollout(output(toolList(u.contracts.before))), [], wire(u.contracts.before), 'A', 0, 0),
    ...upgradeRules(u, rollout(native), a.events, log, 'A', 1, 3)];
  return a;
}

test('code-mode rules start at discovery, after earlier replies and writes in the resumed turn', () => {
  const a = lateDiscoveryAttempt();
  expect(noCanaryReplyViolation(a).status).toBe('holds');
  expect(replyCanary(a).status).toBe('holds');
  expect(a.given[1]!.fromSeq).toBe(6);
  // A reply after discovery remains enforceable.
  const laterReply = a.events.find(e => e.kind === 'message' && e.seq === 9)!;
  if (laterReply.kind === 'message') laterReply.text = 'I have the rules.';
  expect(noCanaryReplyViolation(a).status).toBe('violated');
});

const recoveryCheck = upgradeChecks.find(u => u.id === 'U-codex-resume')!.expect.find(i => i.id === 'resume-refusal-recovery')!.check!;

test('code-mode discovery after a refusal does not move the service restart boundary', () => {
  expect(recoveryCheck(lateDiscoveryAttempt()).status).toBe('holds');
});

test('recovery excludes an unrecovered pre-restart refusal but includes the post-restart refusal before discovery', () => {
  const a = lateDiscoveryAttempt();
  const refusal = a.events.find(e => e.kind === 'tool-call' && e.seq === 5)!;
  const retry = a.events.find(e => e.kind === 'tool-call' && e.seq === 11)!;
  a.events.unshift({ ...refusal, seq: 0, turn: 0 }, { ...retry, seq: 1, turn: 0 });
  expect(recoveryCheck(a).status).toBe('holds');
});

test('a refusal before the service restart does not establish post-restart recovery', () => {
  expect(recoveryCheck(lateDiscoveryAttempt(6))).toMatchObject({ status: 'violated', absenceOnly: true, reason: 'no version_mismatch after the restart' });
});

test('an upgrade record without a restart cannot substitute the discovery boundary', () => {
  const a = lateDiscoveryAttempt();
  delete a.upgrade!.restart;
  expect(recoveryCheck(a)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('restart') });
});

function historyAttempt(nested: boolean): AttemptRecord {
  const history: WireRevision[] = [1, 2].map(revision => ({ mapId: 'Upgrade.Probe', revision, priorRevision: revision === 1 ? null : 1,
    kind: revision === 1 ? 'create' : 'apply', author: { actorId: 'agent', clientId: 'client-A', occurredAt: '' }, changes: [],
    state: { id: 'Upgrade.Probe', title: 'Upgrade probe', destination: 'Observe an upgrade', notes: '', currentRevision: revision, fog: [], scopeExclusions: [],
      tickets: revision === 1 ? [] : [{ id: 'Probe.One', title: 'v2: Probe', question: 'New rules?', type: 'research', status: 'open', prerequisites: [], claim: null }] } }));
  const events: EventRecord[] = history.map(r => ({ seq: r.revision === 1 ? 1 : 3, at: '', actor: 'agent', session: 'A', turn: 0,
    kind: 'tool-call', callId: `call-${r.revision}`, server: 'wayfinder', tool: r.revision === 1 ? 'map_create' : 'map_apply',
    arguments: { mapId: r.mapId }, result: { known: true, value: nested ? { kind: 'committed', revision: structuredClone(r), frontier: ['Probe.One'] }
      : { kind: 'committed', mapId: r.mapId, revision: r.revision } }, failed: false, requestId: { known: true, value: `${r.revision}` } }));
  return { schema: attemptSchema, attemptId: 'synthetic/upgrade', batchId: 'synthetic', subject: { kind: 'upgrade-check', id: 'U-codex-process', version: 7 },
    entry: 'mcp-only', combination: { harness: 'codex', requestedModel: 'fixture', visibleModel: { known: true, value: 'fixture' }, effort: { known: true, value: 'low' } },
    client: { version: { known: true, value: '0.164.0' }, surface: { known: true, value: 'fixture' } }, service: { commit: 'fixture', series: 'release', version: '1.0.0' },
    given: [], run: { startedAt: '', endedAt: '', completeness: 'complete' }, controller: { clientId: 'controller' }, baitClientIds: [],
    sessions: [{ label: 'A', nativeId: { known: true, value: 'thread-A' }, clientId: 'client-A', mcpSessionIds: { known: true, value: ['mcp-session'] }, turns: [] }],
    events, maps: [{ mapId: 'Upgrade.Probe', seedHeadRevision: null, history }], receipts: receiptsFrom(events), usage: { known: true, value: {} },
    raw: { path: 'synthetic', files: [] }, missing: [], upgrade: upgrade() };
}

test.each([true, false])('exact history accepts committed results (nested Revision=%s)', nested => {
  expect(exactUpgradeHistory(historyAttempt(nested)).status).toBe('holds');
});

test.each([true, false])('exact history still requires the correct Map, Revision and post-restart boundary (nested=%s)', nested => {
  for (const fault of ['map', 'revision', 'boundary']) {
    const a = historyAttempt(nested);
    const call = a.events[1]!;
    if (fault === 'boundary') call.seq = a.upgrade!.restart!.seq - 1;
    else if (call.kind === 'tool-call' && call.result.known) {
      const result = call.result.value as { mapId: string; revision: number | { mapId: string; revision: number } };
      const target = typeof result.revision === 'object' ? result.revision : result;
      if (fault === 'map') target.mapId = 'Another.Map'; else target.revision = 7;
    }
    expect(exactUpgradeHistory(a).status).toBe('unknown');
  }
});


const script = (a: AttemptRecord, id: string) => {
  const u = upgradeChecks.find(u => u.id === a.subject.id)!;
  return [...u.mustNot, ...u.expect].find(i => i.id === id)!.check!(a);
};

function resourceAfterDiscovery(unplaced: boolean, final = 'LANTERN End.') {
  const a = replyAttempt();
  const u = a.upgrade!;
  const resource = { contents: [{ uri: 'wayfinder://workflow/exploration', text: `version: ${u.contracts.after.version}\n\n${u.contracts.after.markdown}` }] };
  const read: EventRecord = { seq: 5, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'tool-call', callId: 'read',
    server: 'wayfinder', tool: 'read_mcp_resource', arguments: { uri: 'wayfinder://workflow/exploration' },
    result: { known: true, value: resource }, failed: false, requestId: { known: true, value: '2' } };
  a.events = [message(3, 'LANTERN Start.'), message(4, 'Plain reply after discovery.'), read,
    { seq: 6, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true }, message(7, final)];
  const native = [completed(a.events[0]!), ...(unplaced ? [completed(message(0, 'No normalized match'))] : []),
    output(toolList(u.contracts.after)), completed(a.events[1]!), completed(read), output(resource), completed(a.events[4]!)].join('\n');
  const log: (RelayObservation & { turn: number })[] = [...wire(u.contracts.after, 1), { phase: 'response', at: '', requestId: 2,
    method: 'resources/read', sessionId: 'mcp-session', status: 200, turn: 1, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: resource }) }];
  a.given = upgradeRules(u, rollout(native), a.events, log, 'A', 1, 3);
  return a;
}

test.each(['canary-reply-violation', 'canary-reply'])('%s retains an unpositioned discovery before a proven Resource', id => {
  const a = resourceAfterDiscovery(true);
  expect(a.given.find(g => g.fromSeq === 6)?.resourceText?.known).toBe(true);
  expect(script(a, id)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('unpositioned') });
  expect(script(resourceAfterDiscovery(false), id).status).toBe('violated');
  expect(script(resourceAfterDiscovery(true, 'Plain final.'), id).status).toBe('violated');
});

test.each(['completion-first', 'response-first'])('repeated text with missing counterparts has no unique anchor (%s)', order => {
  for (const complete of [false, true]) {
    const a = replyAttempt();
    a.events = [message(3, 'Still checking.'), message(4, 'Still checking.'), message(5, 'LANTERN Done.')];
    const pair = order === 'completion-first' ? [completed, response] : [response, completed];
    const native = complete ? a.events.slice(0, 2).flatMap(e => pair.map(f => f!(e))) : [pair[0]!(a.events[0]!), pair[1]!(a.events[1]!)];
    a.given = upgradeRules(a.upgrade!, rollout([...native, output(toolList(a.upgrade!.contracts.after)), completed(a.events[2]!), response(a.events[2]!)].join('\n')),
      a.events, wire(a.upgrade!.contracts.after, 1), 'A', 1, 3);
    expect(noCanaryReplyViolation(a).status).toBe(complete ? 'holds' : 'unknown');
    expect(replyCanary(a).status).toBe(complete ? 'holds' : 'unknown');
  }
});

test.each([false, true])('process fallback preserves unpositioned new rules (Resource=%s)', withResource => {
  for (const unplaced of [true, false]) {
    const a = resourceAfterDiscovery(unplaced);
    const u = a.upgrade!;
    u.mode = 'process'; u.restart!.seq = 3;
    const initial = historyAttempt(false).events[0]!;
    if (initial.kind === 'tool-call') initial.arguments = { version: '1.0.0' };
    const write: EventRecord = { ...initial, seq: 8, turn: 1, kind: 'tool-call', callId: 'apply', tool: 'map_apply', server: 'wayfinder',
      arguments: { version: '2.0.0' }, result: { known: true, value: { kind: 'committed' } }, failed: false, requestId: { known: false, reason: 'fixture' } };
    const resourceEvents = withResource ? a.events.slice(2, 4) : [];
    a.events = [{ ...initial, turn: 1 }, message(2, 'Before restart.'), message(4, 'After restart.'), ...resourceEvents, write, message(9, 'LANTERN Done.')];
    const resource = resourceEvents[0];
    const resourceResult = resource?.kind === 'tool-call' && resource.result.known ? resource.result.value : undefined;
    const native = [output(toolList(u.contracts.before)), completed(a.events[0]!), completed(a.events[1]!),
      ...(unplaced ? [completed(message(0, 'No matching Event'))] : []), output(toolList(u.contracts.after)), completed(a.events[2]!),
      ...(resource ? [completed(resource), output(resourceResult)] : []), completed(write), completed(a.events.at(-1)!)].join('\n');
    const log = [...wire(u.contracts.before, 1), ...wire(u.contracts.after, 1)];
    // An uncorroborated Resource exercises the second retained-rules fallback too.
    a.given = upgradeRules(u, rollout(native), a.events, log, 'A', 1, 0);
    // A positioned new instructions source remains proof even if a later Resource is uncorroborated.
    for (const id of ['guessed-version', 'writes-new-version']) expect(script(a, id).status, id).toBe(unplaced ? 'unknown' : 'holds');
    if (unplaced) for (const id of ['guessed-version', 'writes-new-version'])
      expect(script(a, id).reason).toContain('unpositioned');
    if (unplaced) for (const g of a.given.filter(g => g.phase === 'after-restart'))
      expect(g.instructions).toMatchObject({ known: false, reason: expect.stringContaining('unpositioned') });
  }
});

test.each(['developer', 'additional_tools'])('native %s visibility is positioned rather than backdated to turn start', channel => {
  const a = replyAttempt();
  a.events = [message(3, 'Before the new rule.'), message(4, 'LANTERN Done.')];
  const c = a.upgrade!.contracts.after;
  const native = JSON.stringify({ type: 'response_item', payload: channel === 'developer'
    ? { type: 'message', role: 'developer', content: [{ type: 'input_text', text: c.instructions }] }
    : { type: 'additional_tools', tools: toolList(c) } });
  a.given = upgradeRules(a.upgrade!, rollout([completed(a.events[0]!), native, completed(a.events[1]!)].join('\n')),
    a.events, wire(c, 1), 'A', 1, 3);
  const g = a.given.findLast(g => g.fromSeq <= 3);
  expect(g?.instructions.known ?? false).toBe(false);
  expect(g?.toolDescriptions.known ?? false).toBe(false);
  if (channel === 'developer') expect(noCanaryReplyViolation(a).status).toBe('holds');
});

test('repeated identical tool calls with a missing completion do not choose the first occurrence', () => {
  const a = replyAttempt();
  const call: EventRecord = { seq: 3, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'tool-call', server: 'wayfinder', tool: 'map_read',
    callId: 'first', arguments: {}, result: { known: true, value: { kind: 'found' } }, requestId: { known: false, reason: 'fixture' }, failed: false };
  a.events = [call, message(4, 'Still before discovery.'), { ...call, seq: 5, callId: 'second' }, message(6, 'LANTERN Done.')];
  a.given = upgradeRules(a.upgrade!, rollout([completed(call), output(toolList(a.upgrade!.contracts.after)), completed(a.events[3]!)].join('\n')),
    a.events, wire(a.upgrade!.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe('unknown');
});

test('a missing intervening native anchor cannot place discovery before or after that Event', () => {
  const a = replyAttempt();
  a.events = [message(3, 'First.'), message(4, 'Unmatched middle reply.'), message(5, 'LANTERN Done.')];
  a.given = upgradeRules(a.upgrade!, rollout([completed(a.events[0]!), output(toolList(a.upgrade!.contracts.after)), completed(a.events[2]!)].join('\n')),
    a.events, wire(a.upgrade!.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe('unknown');
});

test('a later current Resource result cannot identify an earlier read with missing native contents', () => {
  const a = resourceAfterDiscovery(false);
  const u = a.upgrade!;
  const currentCall = a.events[2]!;
  const currentRead = a.events[3]!;
  const earlyCall = { ...currentCall, seq: 3, callId: 'early', result: { known: false as const, reason: 'lost native contents' } } as EventRecord;
  a.events = [earlyCall, { ...currentRead, seq: 4 }, message(5, 'Plain between reads.'), { ...currentCall, seq: 6 },
    { ...currentRead, seq: 7 }, message(8, 'LANTERN End.')];
  const value = currentCall.kind === 'tool-call' && currentCall.result.known ? currentCall.result.value : null;
  const native = [completed(earlyCall), completed(a.events[2]!), completed(a.events[3]!), output(value), completed(a.events[5]!)].join('\n');
  const log: (RelayObservation & { turn: number })[] = [{ phase: 'response', at: '', requestId: 2, method: 'resources/read', sessionId: 'mcp-session',
    status: 200, turn: 1, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: value }) }];
  a.given = upgradeRules(u, rollout(native), a.events, log, 'A', 1, 3);
  expect(noCanaryReplyViolation(a)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('unpositioned') });
  expect(a.given.find(g => g.fromSeq === 4)?.resourceText?.known).toBe(false);
  expect(a.given.find(g => g.fromSeq === 7)?.resourceText?.known).toBe(true);
  const final = a.events.at(-1)!;
  if (final.kind === 'message') final.text = 'Plain final.';
  expect(noCanaryReplyViolation(a).status).toBe('violated');
});

test('later positioned rediscovery proves a later violation without erasing the earlier unknown interval', () => {
  const a = replyAttempt();
  a.events = [message(3, 'LANTERN Start.'), message(4, 'Plain during unknown exposure.'), message(5, 'Plain after rediscovery.')];
  const native = [completed(a.events[0]!), completed(message(0, 'No matching Event')), output(toolList(a.upgrade!.contracts.after)),
    completed(a.events[1]!), output(toolList(a.upgrade!.contracts.after)), completed(a.events[2]!)].join('\n');
  a.given = upgradeRules(a.upgrade!, rollout(native), a.events, wire(a.upgrade!.contracts.after, 1), 'A', 1, 3);
  expect(noCanaryReplyViolation(a).status).toBe('violated');
  const final = a.events.at(-1)!;
  if (final.kind === 'message') final.text = 'LANTERN End.';
  expect(noCanaryReplyViolation(a)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('unpositioned') });
});

test.each([true, false])('missing restart keeps a discovered new version unknown rather than guessed (restart=%s)', hasRestart => {
  const a = replyAttempt();
  const u = a.upgrade!;
  u.mode = 'process'; u.restart!.seq = 3;
  if (!hasRestart) delete u.restart;
  const initial = { ...historyAttempt(false).events[0]!, turn: 1 };
  const write = { ...initial, seq: 4, callId: 'retry', tool: 'map_apply' };
  if (initial.kind === 'tool-call') initial.arguments = { version: '1.0.0' };
  if (write.kind === 'tool-call') write.arguments = { version: '2.0.0' };
  a.events = [initial, message(2, 'Before restart.'), write, message(5, 'LANTERN Done.')];
  const native = [output(toolList(u.contracts.before)), completed(initial), completed(a.events[1]!),
    output(toolList(u.contracts.after)), completed(write), completed(a.events[3]!)].join('\n');
  a.given = upgradeRules(u, rollout(native), a.events, [...wire(u.contracts.before, 1), ...wire(u.contracts.after, 1)], 'A', 1, 0);
  expect(script(a, 'guessed-version')).toMatchObject(hasRestart ? { status: 'holds' }
    : { status: 'unknown', reason: expect.stringContaining('restart') });
  // Native discovery survives extraction even when its relation to the service restart is unknown.
  expect(a.given.some(g => g.instructions.known && g.instructions.value === u.contracts.after.instructions)).toBe(true);
  if (write.kind === 'tool-call') write.arguments = { version: '7.7.7' };
  expect(script(a, 'guessed-version').status).toBe('violated');
});

test('unchanged tool descriptions do not invent a new source before the restart was recorded', () => {
  const u = upgrade();
  delete u.restart;
  u.contracts.before.toolDescriptions.map_read = 'Read the Map.';
  u.contracts.after.toolDescriptions.map_read = 'Read the Map.';
  const given = upgradeRules(u, rollout(output(toolList(u.contracts.before))), [], wire(u.contracts.before), 'A', 0, 0);
  expect(given).toHaveLength(1);
  expect(given[0]).toMatchObject({ phase: 'initial', instructions: { known: true }, toolDescriptions: { known: true } });
});

test('an old Resource read does not invent a new source before the restart was recorded', () => {
  const u = upgrade();
  delete u.restart;
  const resource = { contents: [{ uri: 'wayfinder://workflow/exploration', text: `version: ${u.contracts.before.version}\n\n${u.contracts.before.markdown}` }] };
  const read: EventRecord = { seq: 1, at: '', actor: 'agent', session: 'A', turn: 0, kind: 'tool-call', callId: 'read-old', server: 'wayfinder',
    tool: 'read_mcp_resource', arguments: { uri: 'wayfinder://workflow/exploration' }, result: { known: true, value: resource },
    requestId: { known: true, value: '2' }, failed: false };
  const events: EventRecord[] = [read, { seq: 2, at: '', actor: 'agent', session: 'A', turn: 0, kind: 'resource-read',
    uri: 'wayfinder://workflow/exploration', ok: true }];
  const log: (RelayObservation & { turn: number })[] = [...wire(u.contracts.before), { phase: 'response', at: '', requestId: 2,
    method: 'resources/read', sessionId: 'mcp-session', status: 200, turn: 0, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: resource }) }];
  const given = upgradeRules(u, rollout([output(toolList(u.contracts.before)), completed(read), output(resource)].join('\n')), events, log, 'A', 0, 0);
  expect(given).toHaveLength(1);
  expect(given[0]).toMatchObject({ phase: 'initial', instructions: { known: true }, toolDescriptions: { known: true } });
});

function resourceBeforeLaterPhase(mode: 'process' | 'resume', later: 'old-tools' | 'unplaced-discovery' | 'lost-resource' | 'none') {
  const a = replyAttempt();
  const u = a.upgrade!;
  u.mode = mode; u.restart!.seq = 3;
  u.contracts.after.markdown += `\n${ticketRule}`;
  a.subject.id = `U-codex-${mode}`;
  const resource = { contents: [{ uri: 'wayfinder://workflow/exploration', text: `version: ${u.contracts.after.version}\n\n${u.contracts.after.markdown}` }] };
  const call = (seq: number, tool: string, args: unknown, value: unknown): EventRecord => ({ seq, at: '', actor: 'agent', session: 'A', turn: 1,
    kind: 'tool-call', callId: `call-${seq}`, server: 'wayfinder', tool, arguments: args, result: { known: true, value },
    failed: false, requestId: { known: true, value: String(seq) } });
  a.events = [call(1, 'map_create', { version: '1.0.0' }, { kind: 'committed' }), message(2, 'Before restart.'),
    call(4, 'map_apply', { version: '1.0.0' }, { kind: 'rejected', code: 'version_mismatch' }),
    call(5, 'read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, resource),
    { seq: 6, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true },
    call(7, 'map_read', { mapId: 'Upgrade.Probe' }, { kind: 'found' }),
    call(8, 'map_apply', { version: '2.0.0', commands: [{ kind: 'ticket.create', ticket: { title: 'v2: Probe' } }] },
      { kind: 'committed' }), message(9, 'LANTERN Done.')];
  const oldList = toolList(u.contracts.before);
  if (later === 'lost-resource') {
    a.events[6]!.seq = 10; a.events[7]!.seq = 11;
    const lost = call(8, 'read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, null);
    if (lost.kind === 'tool-call') lost.result = { known: false, reason: 'lost native contents' };
    a.events.splice(6, 0, lost, { ...a.events[4]!, seq: 9 });
  }
  const native = [output([oldList[0]]), ...a.events.slice(0, 4).map(completed), output(resource),
    ...(later === 'old-tools' ? [output([oldList[1]])] : later === 'unplaced-discovery'
      ? [completed(message(0, 'Unmatched later anchor.')), output(toolList(u.contracts.after))] : []),
    ...a.events.slice(5).filter(e => e.kind !== 'resource-read').map(completed)].join('\n');
  const log: (RelayObservation & { turn: number })[] = [...wire(u.contracts.before, 1), { phase: 'response', at: '', requestId: 5,
    method: 'resources/read', sessionId: 'mcp-session', status: 200, turn: 1, body: JSON.stringify({ jsonrpc: '2.0', id: 5, result: resource }) }];
  a.given = upgradeRules(u, rollout(native), a.events, log, 'A', 1, 0);
  return a;
}

test.each(['old-tools', 'none'] as const)('proven Resource survives later completion of the cached old tool set (%s)', later => {
  const a = resourceBeforeLaterPhase('process', later);
  for (const id of ['invalid-recovery', 'writes-new-version', 'guessed-version', 'canary-reply'])
    expect(script(a, id).status, id).toBe('holds');
  expect(a.given.filter(g => g.phase === 'initial').every(g => g.fromSeq < a.upgrade!.restart!.seq)).toBe(true);
  // Existing captured phases must also work without being re-extracted or ordered.
  a.given.reverse();
  for (const id of ['invalid-recovery', 'writes-new-version', 'canary-reply']) expect(script(a, id).status, id).toBe('holds');
  const retry = a.events.find(e => e.seq === 8)!;
  if (retry.kind === 'tool-call') retry.arguments = { version: '1.0.0' };
  for (const id of ['invalid-recovery', 'writes-new-version']) expect(script(a, id).status, id).toBe('violated');
});

test.each(['unplaced-discovery', 'lost-resource'] as const)('a proven Resource is not erased by later incomplete evidence (%s)', later => {
  const a = resourceBeforeLaterPhase('resume', later);
  for (const id of ['writes-new-version', 'canary-reply']) expect(script(a, id).status, id).toBe('holds');
  const final = a.events.at(-1)!;
  if (final.kind === 'message') final.text = 'Plain final.';
  for (const id of ['canary-reply', 'canary-reply-violation']) expect(script(a, id).status, id).toBe('violated');
});

test.each(['old-tools', 'unplaced-discovery', 'lost-resource'] as const)('Ticket rule proof survives a later phase (%s)', later => {
  const a = resourceBeforeLaterPhase(later === 'old-tools' ? 'process' : 'resume', later);
  expect(script(a, 'follows-canary-rule').status).toBe('holds');
});
