import { syntheticClientState } from './test-state.ts';
// The runner without a model: refusals before running, seeds against the real service, the sandbox profile,
// and one end-to-end S0b Attempt played by a Codex stand-in that makes real MCP calls.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { requiredFields } from '../evidence.ts';
import type { AttemptRecord } from '../evidence.ts';
import { library } from '../library.ts';
import { itemsOf } from '../scenario.ts';
import { prepareSandbox, prepareSession, writeProfile } from './codex.ts';
import { connectController } from './controller.ts';
import { normalizeTurn, readsIn, receiptsFrom, relativePath } from './normalize.ts';
import { preflight, runAttempt, runBatch } from './run.ts';
import type { BatchOptions } from './run.ts';
import type { Scenario } from '../scenario.ts';
import { checkoutRoot, freePort, newToken, startService } from './service.ts';
import { createServer } from 'node:net';

const scratch = realpathSync(mkdtempSync('/private/tmp/wf-behave-test-'));
const clientState = syntheticClientState(scratch);
const sandboxAvailable = spawnSync('which', ['sandbox-exec']).status === 0;
const fakeCodex = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
// The service refuses databases under temporary directories or inside a repository; tests keep theirs in Caches.
const caches = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(caches, { recursive: true, mode: 0o700 });
const records = realpathSync(mkdtempSync(join(caches, 'run-')));
chmodSync(records, 0o700);
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });

describe('preflight', () => {
  test('refuses what this runner cannot do, before anything runs', () => {
    const { refusals } = preflight({ batchId: 'T1', scenarios: ['S5', 'S6', 'S10', 'W5', 'S7', 'P1'], count: 1, ceiling: 4 });
    expect(refusals.join('\n')).not.toMatch(/S6|W5/);
    expect(refusals.join('\n')).toMatch(/P1: no such Scenario/);
    expect(refusals.join('\n')).not.toMatch(/S7/);
  });
  test('refuses raw output inside the checkout before starting a service or client', async () => {
    const out = join(checkoutRoot, 'tests/behaviour/must-not-create');
    const options: BatchOptions = { batchId: 'T', scenarios: ['S0b'], count: 1, ceiling: 1, out, scratchRoot: scratch, ...clientState,
      codex: { model: 'fake-model', effort: 'low', bin: fakeCodex, sandbox: false, timeoutMs: 1000 } };
    expect((await runBatch(options)).refusals).toEqual(['raw records must stay outside repositories']);
    expect(existsSync(out)).toBe(false);
  });
  test('plans count Attempts per Scenario', () => {
    const { plan, refusals } = preflight({ batchId: 'T1', scenarios: ['S0b', 'F11'], count: 2, ceiling: 4 });
    expect(refusals).toEqual([]);
    expect(plan.map(p => p.attemptId)).toEqual(['S0b-1', 'S0b-2', 'F11-1', 'F11-2']);
  });
});

describe('seeds against the real service', () => {
  const seeded = library.filter(s => s.seed.maps.length);
  test.each(seeded.map(s => [s.id, s] as const))('%s rebuilds its visible state', async (_id, s) => {
    const controller = { clientId: 'Behaviour-Controller', token: newToken() };
    const service = await startService(mkdtempSync(join(records, `seed-${s.id}-`)), controller, []);
    try {
      const ctl = await connectController(service.port, controller.token);
      for (const map of s.seed.maps) await ctl.seed(map);
      const catalog = await ctl.exportCatalog();
      await ctl.close();
      for (const map of s.seed.maps) {
        const state = catalog.find(m => m.mapId === map.mapId)!.history.at(-1)!.state;
        expect([state.title, state.destination, state.notes]).toEqual([map.title, map.destination, map.notes]);
        expect(state.tickets.map(t => [t.id, t.type, t.question, [...t.prerequisites].sort(), t.status, t.claim, t.settlement?.outcome ?? null]))
          .toEqual(map.tickets.map(t => [t.id, t.type, t.question, [...(t.prerequisites ?? [])].sort(), t.settlement ? 'settled' : 'open', t.claim ?? null, t.settlement?.outcome ?? null]));
        expect(state.fog.map(c => c.id)).toEqual((map.fog ?? []).map(c => c.id));
        expect(state.scopeExclusions.map(c => c.id)).toEqual((map.scopeExclusions ?? []).map(c => c.id));
      }
    } finally { await service.stop(); }
  }, 30_000);
});

describe('sandbox', () => {
  test.skipIf(!sandboxAvailable)('reads nothing in the home directory or other scratch, writes only its own, cannot reach blocked ports', async () => {
    const own = mkdtempSync(join(scratch, 'own-'));
    const other = mkdtempSync('/private/tmp/wf-behave-other-');
    writeFileSync(join(other, 'secret.txt'), 'x');
    const listener = createServer(socket => socket.end('hi'));
    const port = await freePort();
    await new Promise<void>(resolve => listener.listen(port, '127.0.0.1', resolve));
    const { controlDir } = prepareSandbox(own);
    const session = prepareSession(own, 'A', 'synthetic', clientState.loginSource);
    const work = join(own, 'work'); mkdirSync(work);
    const profile = writeProfile(controlDir, session, work, '/bin/sh').path;
    const q = JSON.stringify;
    const run = (cmd: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', cmd], { encoding: 'utf8' }).status;
    try {
      expect(run(`cat ${q(join(homedir(), 'workspace/AGENTS.md'))}`)).not.toBe(0);
      expect(run(`cat ${q(join(homedir(), '.zshrc'))} || cat ${q(join(homedir(), '.gitconfig'))}`)).not.toBe(0);
      expect(run(`ls ${q(join(homedir(), 'Library/Application Support/Wayfinder'))}`)).not.toBe(0);
      expect(run(`cat ${q(join(other, 'secret.txt'))}`)).not.toBe(0);
      expect(run(`touch ${q(join(homedir(), '.wf-behave-probe'))}`)).not.toBe(0);
      expect(run('touch /opt/homebrew/.wf-behave-probe || touch /usr/local/.wf-behave-probe')).not.toBe(0);
      expect(existsSync(join(homedir(), '.wf-behave-probe'))).toBe(false);
      expect(run(`echo ok > ${q(join(work, 'probe.txt'))} && cat ${q(join(work, 'probe.txt'))}`)).toBe(0);
      expect(run(`node -e 1`)).toBe(0);
      expect(run(`node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"`)).not.toBe(0);
    } finally { listener.close(); rmSync(other, { recursive: true, force: true }); }
  });
});

describe('normalizer', () => {
  const resourcePayload = { server: 'wayfinder', uri: 'wayfinder://workflow/exploration',
    contents: [{ uri: 'wayfinder://workflow/exploration', text: 'version: 9.9.9\nSynthetic rules' }] };
  const resourceResult = { content: [{ type: 'text', text: JSON.stringify(resourcePayload) }], structured_content: null };
  test('a completed text-only Resource result retains its native payload', () => {
    const { events } = normalizeTurn([{ type: 'item.completed', item: { id: 'resource', type: 'mcp_tool_call', server: 'wayfinder',
      tool: 'read_mcp_resource', arguments: { uri: resourcePayload.uri }, status: 'completed', result: resourceResult } }], 'A', 0, 'go', '', 0, '/w');
    expect(events.find(e => e.kind === 'tool-call')).toMatchObject({ result: { known: true, value: resourcePayload }, failed: false });
    expect(events.find(e => e.kind === 'resource-read')).toMatchObject({ ok: true, uri: resourcePayload.uri });
  });
  test('a text Resource result stays present when it is not JSON', () => {
    const content = [{ type: 'text', text: 'version: 9.9.9\nSynthetic text or truncated payload' }];
    const { events } = normalizeTurn([{ type: 'item.completed', item: { id: 'resource', type: 'mcp_tool_call', server: 'wayfinder',
      tool: 'read_mcp_resource', status: 'completed', result: { content, structured_content: null } } }], 'A', 0, 'go', '', 0, '/w');
    expect(events.find(e => e.kind === 'tool-call')).toMatchObject({ result: { known: true, value: { content } } });
  });
  test.each([
    { name: 'failed status', status: 'failed', result: resourceResult },
    { name: 'native error', status: 'completed', result: resourceResult, error: { message: 'Synthetic failure' } },
    { name: 'MCP error flag', status: 'completed', result: { ...resourceResult, is_error: true } },
    { name: 'protocol camelCase error flag', status: 'completed', result: { ...resourceResult, isError: true } },
    { name: 'absent result', status: 'completed', result: null },
    { name: 'empty result', status: 'completed', result: { content: [], structured_content: null } },
  ])('an unsuccessful or absent Resource result stays unknown: $name', row => {
    const { events } = normalizeTurn([{ type: 'item.completed', item: { id: 'resource', type: 'mcp_tool_call', server: 'wayfinder',
      tool: 'read_mcp_resource', arguments: { uri: resourcePayload.uri }, ...row } }], 'A', 0, 'go', '', 0, '/w');
    expect(events.find(e => e.kind === 'tool-call')).toMatchObject({ result: { known: false } });
    expect(events.find(e => e.kind === 'resource-read')).toMatchObject({ ok: false });
  });
  test('Resource text fallback never manufactures a Map write receipt', () => {
    const { events } = normalizeTurn([{ type: 'item.completed', item: { id: 'write', type: 'mcp_tool_call', server: 'wayfinder',
      tool: 'map_apply', arguments: { mapId: 'M' }, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'committed', mapId: 'M', revision: 1 }) }] } } }], 'A', 0, 'go', '', 0, '/w');
    expect(receiptsFrom(events)[0]!.outcome.kind).toBe('unknown');
  });
  test('the repository synthetic McpToolCall result keeps its protocol field names', () => {
    // B08 format fixture only, never a real session log; adapt its envelope to exec's item.completed.
    const rows = readFileSync(fileURLToPath(new URL('../fixtures/scan/codex-mcp-0.164.jsonl', import.meta.url)), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const item = rows.find(r => r.payload?.item?.id === 'read').payload.item;
    const { events } = normalizeTurn([{ type: 'item.completed', item: { ...item, type: 'mcp_tool_call' } }], 'A', 0, 'go', '', 0, '/w');
    expect(events.find(e => e.kind === 'tool-call')).toMatchObject({ result: { known: true, value: item.result.structuredContent } });
  });
  test('paths are workdir-relative; reads come from common read commands', () => {
    expect(relativePath('/private/tmp/w/work/src/a.js', '/private/tmp/w/work')).toBe('src/a.js');
    expect(relativePath('/Users/someone/secret/x', '/private/tmp/w/work')).toBe('<outside>/secret/x');
    expect(readsIn("/bin/zsh -lc 'sed -n 1,80p src/ask-card.js && cat README.md'", '/w')).toEqual(['src/ask-card.js', 'README.md']);
    expect(readsIn('/bin/zsh -lc "node --version"', '/w')).toEqual([]);
  });
  test('a call still running when the turn ends leaves an unknown receipt', () => {
    const lines = [{ type: 'turn.started' }, { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'wayfinder', tool: 'map_apply', arguments: { mapId: 'M' } } }];
    const { events } = normalizeTurn(lines, 'A', 0, 'go', '', 0, '/w');
    expect(receiptsFrom(events).map(r => r.outcome)).toEqual([{ kind: 'unknown', reason: 'the turn ended before the call completed' }]);
  });
});

describe('one Attempt end to end, without a model', () => {
  test('S0b with the Codex stand-in: isolated, recorded, attributed, cleaned up', async () => {
    const out = join(records, 'runs', 'T-fake');
    const options: BatchOptions = { batchId: 'T-fake', scenarios: ['S0b'], count: 1, ceiling: 1, out,
      codex: { model: 'fake-model', effort: 'low', bin: fakeCodex, sandbox: false, timeoutMs: 60_000 }, scratchRoot: scratch, ...clientState };
    const { outcomes, refusals } = await runBatch(options);
    expect(refusals).toEqual([]);
    expect(outcomes.map(o => [o.attemptId, o.completeness])).toEqual([['S0b-1', 'complete']]);
    const text = readFileSync(join(out, 'S0b-1', 'attempt.json'), 'utf8');
    const record = JSON.parse(text) as AttemptRecord & { isolation: { attribution: Record<string, unknown> } & Record<string, unknown> };
    expect(record.combination.visibleModel).toEqual({ known: true, value: 'fake-model' });
    expect(record.given[0]!.instructions.known).toBe(true);
    expect(record.receipts.map(r => [r.tool, r.turn, r.outcome.kind])).toEqual([['map_create', 1, 'committed'], ['map_apply', 1, 'committed']]);
    expect(record.isolation).toMatchObject({ sandbox: false, servedOwnDatabase: true, scratchRemoved: true });
    expect(record.isolation.touchedEverydayDatabase).not.toEqual({ known: true, value: true });
    expect(record.isolation.attribution).toEqual({ agentRevisions: 2, committedReceipts: 2, mismatched: [], unplaced: [] });
    expect(record.missing).toEqual([]);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    const s0b = library.find(s => s.id === 'S0b')!;
    const results = Object.fromEntries(itemsOf(s0b).flatMap(i => i.judge === 'script' ? [[i.id, i.check(record).status]] : []));
    expect(results).toEqual({ 'created-in-turn-0': 'holds', 'settled-on-blanket': 'holds', 'paged-and-created-once': 'holds', 'route-published': 'holds' });
    const batch = JSON.parse(readFileSync(join(out, 'batch.json'), 'utf8')) as { isolation: { unchanged: boolean } };
    expect(batch.isolation.unchanged).toBe(true);
    expect((await runBatch(options)).refusals.join()).toMatch(/already exists/);
  }, 60_000);
});

describe('every planned Attempt gets a result', () => {
  const options = (out: string, timeoutMs = 60_000): BatchOptions => ({ batchId: 'T-fail', scenarios: [], count: 1, ceiling: 1,
    out, codex: { model: 'fake-model', effort: 'low', bin: fakeCodex, sandbox: false, timeoutMs }, scratchRoot: scratch, ...clientState });
  const drill = (say: string): Scenario => ({ ...library.find(s => s.id === 'S12')!, id: 'Drill', turns: [{ session: 'A', kind: 'opening', say }] });
  const attempt = async (say: string, timeoutMs?: number, cancelled = () => false) => {
    const out = join(records, `fail-${Math.random().toString(36).slice(2)}`);
    const outcome = await runAttempt(options(out, timeoutMs), { attemptId: 'D-1', scenario: drill(say) }, cancelled, () => undefined);
    return { outcome, record: JSON.parse(readFileSync(join(out, 'D-1', 'attempt.json'), 'utf8')) as AttemptRecord };
  };

  test('a client that never starts is a launch failure, still recorded with the Map evidence', async () => {
    const { outcome, record } = await attempt('FAKE-CRASH');
    expect(outcome.completeness).toBe('launch-failed');
    expect(record.run.completeness).toBe('launch-failed');
    expect(record.missing).not.toContain('maps');
  }, 30_000);

  test('a turn past its limit is a timeout', async () => {
    expect((await attempt('FAKE-SLEEP', 2_000)).outcome.completeness).toBe('timeout');
  }, 30_000);

  test('cancellation stops before the next turn', async () => {
    expect((await attempt('hello', undefined, () => true)).outcome.completeness).toBe('cancelled');
  }, 30_000);

  test('Attempts past the ceiling are listed as not run', async () => {
    const out = join(records, 'runs', 'T-ceiling');
    const { outcomes } = await runBatch({ ...options(out), batchId: 'T-ceiling', scenarios: ['S12'], count: 2, ceiling: 1 });
    expect(outcomes.map(o => [o.attemptId, o.completeness])).toEqual([['S12-1', 'complete'], ['S12-2', 'not-run']]);
  }, 60_000);
});

describe('inside the sandbox', () => {
  test.skipIf(!sandboxAvailable)('the client reads and writes its fixture directory, cannot read the workspace, and its record is complete', async () => {
    // The stand-in lives in the workspace, which the sandbox hides; run a copy from its own directory.
    mkdirSync(join(scratch, 'client'), { recursive: true });
    const fake = join(scratch, 'client', 'fake-codex.mjs');
    copyFileSync(fakeCodex, fake);
    chmodSync(fake, 0o755);
    const out = join(records, 'sandboxed');
    const s15 = library.find(s => s.id === 'S15')!;
    const drill: Scenario = { ...s15, id: 'Drill', turns: [s15.turns[0]!] };
    const outcome = await runAttempt({ batchId: 'T-sandbox', scenarios: [], count: 1, ceiling: 1, out,
      codex: { model: 'fake-model', effort: 'low', bin: fake, sandbox: true, timeoutMs: 60_000 }, scratchRoot: scratch, ...clientState }, { attemptId: 'D-1', scenario: drill }, () => false, () => undefined);
    expect(outcome.completeness).toBe('complete');
    const record = JSON.parse(readFileSync(join(out, 'D-1', 'attempt.json'), 'utf8')) as AttemptRecord;
    const commands = record.events.flatMap(e => e.kind === 'command' ? [[e.command.replace(homedir(), '~'), e.exitCode]] : []);
    expect(commands).toEqual([["/bin/zsh -lc 'cat README.md'", 0], ["/bin/zsh -lc 'cat ~/workspace/AGENTS.md'", 1], ["/bin/zsh -lc 'echo note > fake-note.txt'", 0]]);
    expect(readFileSync(join(out, 'D-1', 'raw', 'work', 'fake-note.txt'), 'utf8')).toBe('note\n');
    expect(existsSync(join(out, 'D-1', 'raw', 'work', 'src', 'ask-card.js'))).toBe(true);
    for (const field of requiredFields) {
      const value = field.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], record);
      expect(value === undefined ? field : null, field).toBeNull();
    }
  }, 60_000);
});
