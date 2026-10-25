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
import { sandboxProfile } from './codex.ts';
import { connectController } from './controller.ts';
import { readsIn, relativePath } from './normalize.ts';
import { preflight, runAttempt, runBatch } from './run.ts';
import type { BatchOptions } from './run.ts';
import type { Scenario } from '../scenario.ts';
import { newToken, startService } from './service.ts';

const scratch = realpathSync(mkdtempSync('/private/tmp/wf-behave-test-'));
// The service refuses databases under temporary directories or inside a repository; tests keep theirs in Caches.
const caches = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(caches, { recursive: true, mode: 0o700 });
const records = realpathSync(mkdtempSync(join(caches, 'run-')));
chmodSync(records, 0o700);
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });

describe('preflight', () => {
  test('refuses what this runner cannot do, before anything runs', () => {
    const { refusals } = preflight({ batchId: 'T1', scenarios: ['S6', 'W5', 'S7', 'P1'], count: 1, ceiling: 4 });
    expect(refusals.join('\n')).toMatch(/S6: Controller actions \(conflicting-write\)/);
    expect(refusals.join('\n')).toMatch(/W5: Controller actions \(cut-agent-route\)/);
    expect(refusals.join('\n')).toMatch(/P1: no such Scenario/);
    expect(refusals.join('\n')).not.toMatch(/S7/);
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
  const available = spawnSync('which', ['sandbox-exec']).status === 0;
  test.skipIf(!available)('hides the workspace and personal configuration, allows the run scratch', () => {
    const profile = join(scratch, 'probe.sb');
    writeFileSync(profile, sandboxProfile());
    const run = (cmd: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', cmd], { encoding: 'utf8' }).status;
    expect(run(`cat ${JSON.stringify(join(homedir(), 'workspace/AGENTS.md'))}`)).not.toBe(0);
    expect(run(`ls ${JSON.stringify(join(homedir(), 'Library/Application Support/Wayfinder'))}`)).not.toBe(0);
    expect(run(`touch ${JSON.stringify(join(homedir(), '.wf-behave-probe'))}`)).not.toBe(0);
    expect(existsSync(join(homedir(), '.wf-behave-probe'))).toBe(false);
    expect(run(`echo ok > ${JSON.stringify(join(scratch, 'probe.txt'))} && cat ${JSON.stringify(join(scratch, 'probe.txt'))}`)).toBe(0);
  });
});

describe('normalizer', () => {
  test('paths are workdir-relative; reads come from common read commands', () => {
    expect(relativePath('/private/tmp/w/work/src/a.js', '/private/tmp/w/work')).toBe('src/a.js');
    expect(relativePath('/Users/someone/secret/x', '/private/tmp/w/work')).toBe('<outside>/secret/x');
    expect(readsIn("/bin/zsh -lc 'sed -n 1,80p src/ask-card.js && cat README.md'", '/w')).toEqual(['src/ask-card.js', 'README.md']);
    expect(readsIn('/bin/zsh -lc "node --version"', '/w')).toEqual([]);
  });
});

describe('one Attempt end to end, without a model', () => {
  test('S0b with the Codex stand-in: isolated, recorded, attributed, cleaned up', async () => {
    const out = join(records, 'runs', 'T-fake');
    const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
    const options = { batchId: 'T-fake', scenarios: ['S0b'], count: 1, ceiling: 1, model: 'fake-model', effort: 'low', out,
      codex: { bin: fake, sandbox: false, timeoutMs: 60_000 }, scratchRoot: scratch };
    const { outcomes, refusals } = await runBatch(options);
    expect(refusals).toEqual([]);
    expect(outcomes.map(o => [o.attemptId, o.completeness])).toEqual([['S0b-1', 'complete']]);
    const text = readFileSync(join(out, 'S0b-1', 'attempt.json'), 'utf8');
    const record = JSON.parse(text) as AttemptRecord & { isolation: Record<string, unknown> };
    expect(record.combination.visibleModel).toEqual({ known: true, value: 'fake-model' });
    expect(record.given[0]!.instructions.known).toBe(true);
    expect(record.receipts.map(r => [r.tool, r.turn, r.outcome.kind])).toEqual([['map_create', 1, 'committed'], ['map_apply', 1, 'committed']]);
    expect(record.isolation).toMatchObject({ servedOwnDatabase: true, touchedRealDatabase: false, scratchRemoved: true });
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
  const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
  const options = (out: string, timeoutMs = 60_000): BatchOptions => ({ batchId: 'T-fail', scenarios: [], count: 1, ceiling: 1, model: 'fake-model', effort: 'low',
    out, codex: { bin: fake, sandbox: false, timeoutMs }, scratchRoot: scratch });
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
  const available = spawnSync('which', ['sandbox-exec']).status === 0;
  test.skipIf(!available)('the client reads and writes its fixture directory, cannot read the workspace, and its record is complete', async () => {
    // The stand-in lives in the workspace, which the sandbox hides; run a copy from the scratch directory.
    const fake = join(scratch, 'fake-codex.mjs');
    copyFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), fake);
    chmodSync(fake, 0o755);
    const out = join(records, 'sandboxed');
    const s15 = library.find(s => s.id === 'S15')!;
    const drill: Scenario = { ...s15, id: 'Drill', turns: [s15.turns[0]!] };
    const outcome = await runAttempt({ batchId: 'T-sandbox', scenarios: [], count: 1, ceiling: 1, model: 'fake-model', effort: 'low', out,
      codex: { bin: fake, sandbox: true, timeoutMs: 60_000 }, scratchRoot: scratch }, { attemptId: 'D-1', scenario: drill }, () => false, () => undefined);
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

