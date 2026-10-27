import { syntheticClientState } from './test-state.ts';
// Session orchestration with actual MCP calls and fixed native evidence; never starts a model.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { agentRevisions, anyWrite, happened, mapCalls, never } from '../checks.ts';
import type { AttemptRecord, EventRecord } from '../evidence.ts';
import { library } from '../library.ts';
import type { Scenario } from '../scenario.ts';
import * as codex from './codex.ts';
import { correlateReceipts } from './normalize.ts';
import type { AttemptIsolation } from './run.ts';
import { preflight, runAttempt } from './run.ts';

const scratch = realpathSync(mkdtempSync('/private/tmp/wf-behave-sessions-'));
const clientState = syntheticClientState(scratch);
const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(cache, { recursive: true, mode: 0o700 });
const records = mkdtempSync(join(cache, 'sessions-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });
const sandboxDriverDir = join(scratch, 'driver'); mkdirSync(sandboxDriverDir);
const sandboxDriver = join(sandboxDriverDir, 'fake-codex.mjs');
copyFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), sandboxDriver); chmodSync(sandboxDriver, 0o755);
const scenario = (id: string) => library.find(s => s.id === id)!;
const run = async (s: Scenario, model = 'fake-sessions', timeoutMs = 10_000, cancel?: { value: boolean; kill?: () => void }, sandbox = false) => {
  const out = mkdtempSync(join(records, 'attempt-'));
  const outcome = await runAttempt({ batchId: 'T-sessions', scenarios: [], count: 1, ceiling: 1, out, scratchRoot: scratch, ...clientState,
    codex: { model, effort: 'low', bin: sandbox ? sandboxDriver : fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), sandbox, timeoutMs } },
  { attemptId: `${s.id}-1`, scenario: s }, () => cancel?.value ?? false, kill => { if (cancel) cancel.kill = kill; });
  const record = JSON.parse(readFileSync(join(out, `${s.id}-1`, 'attempt.json'), 'utf8')) as AttemptRecord & { isolation: AttemptIsolation };
  return { outcome, record, out };
};
const seeded = (turns: Scenario['turns']): Scenario => ({ ...scenario('S6'), controller: [], turns });

describe('session scheduling and attribution', () => {
  test('S5/S6/S10/W5 are planned without a capability refusal', () => {
    expect(preflight({ batchId: 'T', scenarios: ['S5', 'S6', 'S10', 'W5'], count: 2, ceiling: 8 }).refusals).toEqual([]);
  });

  test('two overlapping clients with reused native item IDs each own only their committed receipts', async () => {
    const { outcome, record } = await run(seeded([
      { session: 'A', kind: 'opening', say: 'FAKE-CONCURRENT A' },
      { session: 'B', kind: 'opening', say: 'FAKE-CONCURRENT B', concurrent: true },
    ]));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    const [a, b] = record.sessions.map(s => s.turns[0]!);
    expect(Date.parse(a!.startedAt)).toBeLessThan(Date.parse(b!.endedAt));
    expect(Date.parse(b!.startedAt)).toBeLessThan(Date.parse(a!.endedAt));
    const committed = record.receipts.filter(r => r.outcome.kind === 'committed');
    expect(committed.map(r => r.session).sort()).toEqual(['A', 'B']);
    expect(new Set(record.receipts.map(r => r.callId)).size).toBe(record.receipts.length);
    const writes = agentRevisions(record);
    expect(writes.map(r => r.session).sort()).toEqual(['A', 'B']);
    for (const r of writes) {
      expect(r.rev.author.clientId).toBe(record.sessions.find(s => s.label === r.session)!.clientId);
      expect(r.turn).toBe(r.session === 'A' ? 0 : 1);
    }
    expect(record.sessions.every(s => s.mcpSessionIds.known && s.mcpSessionIds.value.length > 0)).toBe(true);
    expect(record.given.map(g => g.session).sort()).toEqual(['A', 'B']);
  }, 30_000);

  test.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0)('the real sandbox gives concurrent clients separate HOME access and protected profiles', async () => {
    const { outcome, record } = await run(seeded([
      { session: 'A', kind: 'opening', say: 'FAKE-CONCURRENT A' },
      { session: 'B', kind: 'opening', say: 'FAKE-CONCURRENT B', concurrent: true },
    ]), 'fake-sessions', 10_000, undefined, true);
    expect(outcome.completeness, outcome.detail).toBe('complete');
    const probes = record.events.filter(e => e.kind === 'command' && e.command.startsWith('probe-other-home'));
    expect(probes).toHaveLength(4);
    expect(probes.every(e => e.kind === 'command' && e.exitCode !== 0)).toBe(true);
    const profiles = record.events.flatMap(e => e.kind === 'controller' && e.action === 'isolation-check'
      ? (e.detail as { paths: string[] }).paths : []);
    expect(new Set(profiles.filter(p => p.endsWith('.sb'))).size).toBe(2);
  });

  test('a committed write whose native receipt is lost stays unknown despite relay and author evidence', async () => {
    const { record } = await run(seeded([{ session: 'A', kind: 'opening', say: 'FAKE-LOST' }]));
    expect(record.receipts).toHaveLength(1);
    expect(record.receipts[0]!.outcome.kind).toBe('unknown');
    expect(agentRevisions(record).map(r => [r.session, r.turn])).toEqual([[null, null]]);
    expect(happened('A wrote', anyWrite({ session: 'A', turn: 0 }))(record).status).toBe('unknown');
    expect(never('A wrote', anyWrite({ session: 'A', turn: 0 }))(record).status).toBe('unknown');
  });

  test('control-file tampering stops the next turn and records an isolation failure', async () => {
    const original = codex.runTurn;
    let calls = 0;
    const spy = vi.spyOn(codex, 'runTurn').mockImplementation(async request => {
      const result = await original(request);
      if (++calls === 1) writeFileSync(request.profile.path, '(version 1) (allow default)');
      return result;
    });
    try {
      const { outcome, record } = await run(seeded([
        { session: 'A', kind: 'opening', say: 'FAKE-FRESH' },
        { session: 'A', kind: 'nudge', say: 'FAKE-FRESH' },
      ]));
      expect(outcome.completeness).toBe('driver-failed');
      expect(outcome.detail).toMatch(/isolation failure/);
      expect(mapCalls(record).some(e => e.turn === 1)).toBe(false);
      expect(record.given.some(g => g.turn === 1)).toBe(false);
      expect(record.sessions[0]!.turns).toHaveLength(1);
      expect(record.sessions[0]!.nativeId).toEqual(record.sessions[0]!.turns[0]!.nativeId);
      expect(record.events.some(e => e.actor === 'agent' && e.turn === 1)).toBe(false);
      expect(record.events.find(e => e.kind === 'controller' && e.action === 'isolation-check' && e.turn === 1)).toMatchObject({ detail: { ok: false } });
      expect(record.isolation.failures).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  test('freshProcess starts a new thread, preserves both native IDs and reads the existing Map', async () => {
    const { outcome, record, out } = await run(seeded([
      { session: 'A', kind: 'opening', say: 'FAKE-LOST' },
      { session: 'A', kind: 'opening', say: 'FAKE-FRESH', freshProcess: true },
      { session: 'A', kind: 'nudge', say: 'FAKE-FRESH' },
    ]));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    const ids = record.sessions[0]!.turns.map(t => t.nativeId);
    expect(ids[0]).not.toEqual(ids[1]);
    expect(ids[1]).toEqual(ids[2]);
    expect(mapCalls(record, 'map_read').filter(e => e.turn === 1)).toHaveLength(1);
    expect(record.raw.files.filter(f => f.startsWith('rollout-'))).toHaveLength(3);
    const raw = readFileSync(join(out, `${record.subject.id}-1`, 'raw/turn-1-A.stdout.jsonl'), 'utf8');
    expect(raw).not.toContain('map_create');
  });
});

describe('Controller actions and preconditions', () => {
  test('S6 injects a real Conflict before A writes; only A turn 2 and B may commit agent changes', async () => {
    const { outcome, record } = await run(scenario('S6'));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    const conflict = mapCalls(record, 'map_apply').find(e => e.session === 'A' && e.turn === 0 && e.result.known && (e.result.value as { kind: string }).kind === 'conflict');
    expect(conflict).toBeDefined();
    expect(record.events.some(e => e.actor === 'controller' && e.kind === 'controller' && e.action === 'conflicting-write')).toBe(true);
    const controllerWrites = record.events.filter(e => e.actor === 'controller' && e.kind === 'tool-call' && e.tool === 'map_apply');
    expect(controllerWrites.length).toBeGreaterThan(1);
    expect(record.events.some(e => e.actor === 'controller' && e.kind === 'tool-call' && e.tool === 'map_read')).toBe(true);
    expect(agentRevisions(record).every(r => r.rev.author.clientId !== record.controller.clientId)).toBe(true);
    expect(happened('injection is not agent success', { command: 'content.add', subject: 'controller-conflict-0' })(record).status).toBe('violated');
    expect(happened('A continues', anyWrite({ session: 'A', turn: 2 }))(record).status).toBe('holds');
    expect(record.receipts.some(r => r.callId.startsWith('controller:'))).toBe(false);
  });

  test('S6 stops after an injection if the native write did not receive a Conflict', async () => {
    const s6 = scenario('S6');
    const { outcome, record } = await run({ ...s6, turns: [
      { ...s6.turns[0]!, say: 'FAKE-NO-CONFLICT' }, s6.turns[2]!,
    ] });
    expect(outcome.completeness).toBe('precondition-not-met');
    expect(outcome.detail).toMatch(/no native Conflict/);
    expect(record.events.some(e => e.kind === 'controller' && e.action === 'conflicting-write' && (e.detail as { status: string }).status === 'completed')).toBe(true);
    expect(record.receipts.some(r => r.outcome.kind === 'committed')).toBe(true);
    expect(record.sessions[0]!.turns.map(t => t.index)).toEqual([0]);
  });

  test('fresh-process evidence includes earlier HOME skills and marks inconsistent client versions unknown', async () => {
    const { outcome, record } = await run(seeded([
      { session: 'A', kind: 'opening', say: 'FAKE-EARLY-SKILL' },
      { session: 'A', kind: 'opening', say: 'FAKE-VERSION-B', freshProcess: true },
    ]));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    expect(record.isolation.clientSkills).toContain('early-only');
    expect(record.client.version).toEqual({ known: false, reason: 'cliVersion missing or inconsistent across native sessions' });
  });

  test.each(['S5', 'S10'])('%s resumes only after its proposal appeared', async id => {
    const { outcome, record } = await run(scenario(id));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    expect(record.sessions[0]!.turns.map(t => t.index)).toEqual([0, 1]);
    expect(record.sessions[0]!.turns[0]!.nativeId).toEqual(record.sessions[0]!.turns[1]!.nativeId);
    if (id === 'S5') expect(happened('cleared', { command: 'claim.clear', turn: 1 })(record).status).toBe('holds');
    else expect(mapCalls(record, 'map_read').filter(e => e.turn === 1).map(e => e.arguments)).toEqual([{ mapId: 'feishu-access-20261022' }]);
  });

  test.each(['S5', 'S6', 'S10'])('%s stops honestly if its proposal or read/write trigger is absent', async id => {
    const { outcome, record } = await run(scenario(id), 'fake-model');
    expect(outcome.completeness, JSON.stringify({ detail: outcome.detail, failures: record.isolation.failures,
      processes: record.events.filter(e => e.kind === 'process') })).toBe('precondition-not-met');
    expect(record.events.some(e => e.actor === 'script-human' && e.turn === (id === 'S6' ? 2 : 1))).toBe(false);
  });

  test('W5 does not send a reply whose proposal is missing, or cut before the stated boundary', async () => {
    const w5 = scenario('W5');
    const { outcome, record } = await run({ ...w5, turns: [w5.turns[0]!, { ...w5.turns[1]!, kind: 'reply',
      answers: { proposal: 'an absent proposal', cue: /NEVER-PROPOSED/ } }] }, 'fake-model');
    expect(outcome.completeness).toBe('precondition-not-met');
    expect(record.sessions[0]!.turns.map(t => t.index)).toEqual([0]);
    expect(record.events.filter(e => e.actor === 'controller' && e.kind === 'controller' && e.action === 'cut-agent-route')).toHaveLength(2);
  });

  test('W5 fails business calls at the relay, keeps discovery alive, records the fault and redacts the bait', async () => {
    const { outcome, record, out } = await run(scenario('W5'));
    expect(outcome.completeness, outcome.detail).toBe('complete');
    const script = scenario('W5').requiredEvents[0]!;
    expect(script.judge === 'script' && script.check(record).status).toBe('holds');
    expect(mapCalls(record).some(e => e.turn === 1 && e.failed && !e.result.known)).toBe(true);
    expect(record.events.find(e => e.kind === 'controller' && e.action === 'route-fault-mode')).toMatchObject({
      actor: 'controller', detail: { method: 'tools/call', status: 503, forwarded: false, mode: 'tool-call-envelopes',
        forwardedWhen: 'envelope contains no tools/call', scope: 'whole-envelope' },
    });
    expect(agentRevisions(record).every(r => r.turn === 0)).toBe(true);
    expect(record.baitClientIds).toEqual(['Bait-Credential']);
    const raw = join(out, 'W5-1', 'raw');
    expect(readFileSync(join(raw, 'work/.wayfinder-agent/token'), 'utf8')).toBe('<bait-token>');
    const route = readFileSync(join(raw, 'relay-A.jsonl'), 'utf8').split('\n').map(l => JSON.parse(l) as { turn: number; phase: string; requestId?: number; sessionId?: string; rpc?: { id: number; method: string } });
    const requests = route.filter(e => e.turn === 1 && e.phase === 'request' && e.rpc?.method === 'tools/call');
    expect(requests.length).toBeGreaterThan(0);
    const protocol = readFileSync(join(raw, 'protocol.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind?: string; sessionId?: string; requestId?: number });
    expect(protocol.some(e => e.kind === 'tool-call')).toBe(true); // The observer itself must work.
    for (const request of requests) {
      expect(route.some(e => e.turn === 1 && e.phase === 'cut' && e.rpc?.id === request.rpc!.id)).toBe(true);
      expect(route.some(e => e.turn === 1 && e.phase === 'response' && e.requestId === request.rpc!.id)).toBe(false);
      expect(protocol.some(e => e.kind === 'tool-call' && e.sessionId === request.sessionId && e.requestId === request.rpc!.id)).toBe(false);
    }
    expect(record.events.find(e => e.kind === 'controller' && e.action === 'relay-observations' && e.turn === 1)).toMatchObject({
      detail: { initializeResponses: 1, discoveryResponses: 1 },
    });
    expect(record.sessions[0]!.mcpSessionIds.known && record.sessions[0]!.mcpSessionIds.value.length).toBe(2);
  });

  test('a timeout stops both concurrent children and preserves their process outcomes', async () => {
    const { outcome, record } = await run(seeded([
      { session: 'A', kind: 'opening', say: 'FAKE-SLEEP' },
      { session: 'B', kind: 'opening', say: 'FAKE-SLEEP', concurrent: true },
    ]), 'fake-sessions', 1_000);
    expect(outcome.completeness).toBe('timeout');
    expect(record.events.filter(e => e.kind === 'process').map(e => e.session).sort()).toEqual(['A', 'B']);
    expect(record.raw.files).toContain('turn-0-A.stdout.jsonl');
    expect(record.raw.files).toContain('turn-1-B.stdout.jsonl');
  });
});

describe('unmatched fixed receipts', () => {
  test('missing history, wrong author, duplicate receipt and wrong Map remain unknown', async () => {
    const { record } = await run(seeded([{ session: 'A', kind: 'opening', say: 'write' }]));
    const write = mapCalls(record, 'map_apply').find(e => e.result.known && (e.result.value as { kind: string }).kind === 'committed')!;
    const correlate = (events: EventRecord[], maps = record.maps) => correlateReceipts(events, maps, record.sessions, record.controller.clientId);
    expect(correlate([write], []).every(r => r.outcome.kind === 'unknown')).toBe(true);
    const wrongAuthor = structuredClone(record.maps);
    wrongAuthor[0]!.history.at(-1)!.author.clientId = 'unknown-client';
    expect(correlate([write], wrongAuthor)[0]!.outcome.kind).toBe('unknown');
    expect(correlate([write, { ...write, callId: 'other' }]).every(r => r.outcome.kind === 'unknown')).toBe(true);
    expect(correlate([{ ...write, arguments: { mapId: 'different' } }])[0]!.outcome.kind).toBe('unknown');
    expect(correlate([{ ...write, actor: 'controller' }])).toEqual([]);
  });
});
