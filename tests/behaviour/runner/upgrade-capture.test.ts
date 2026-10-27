import { expect, test } from 'vitest';
import { attemptSchema } from '../evidence.ts';
import type { AttemptRecord, EventRecord, UpgradeContract, WireRevision } from '../evidence.ts';
import { exactUpgradeHistory, noCanaryReplyViolation, replyCanary } from '../upgrade-evidence.ts';
import { replyRule } from '../../helpers/canary-release.mjs';
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

function lateDiscoveryAttempt(): AttemptRecord {
  const a = historyAttempt(false);
  const u = upgrade('resume');
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
  const completed = (event: EventRecord) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: event.kind === 'message'
    ? { type: 'AgentMessage', content: [{ type: 'text', text: event.text }] }
    : event.kind === 'tool-call' ? { type: 'McpToolCall', server: event.server, tool: event.tool, arguments: event.arguments } : {} } });
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

test('code-mode discovery after a refusal does not move the service restart boundary', () => {
  const check = upgradeChecks.find(u => u.id === 'U-codex-resume')!.expect.find(i => i.id === 'resume-refusal-recovery')!.check!;
  expect(check(lateDiscoveryAttempt()).status).toBe('holds');
});

test('a refusal before the service restart does not establish post-restart recovery', () => {
  const a = lateDiscoveryAttempt();
  a.upgrade!.restart!.seq = 6;
  const check = upgradeChecks.find(u => u.id === 'U-codex-resume')!.expect.find(i => i.id === 'resume-refusal-recovery')!.check!;
  expect(check(a)).toMatchObject({ status: 'violated', absenceOnly: true, reason: 'no version_mismatch after the restart' });
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
