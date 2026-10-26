import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { AttemptRecord } from '../evidence.ts';
import { asScenario, upgradeChecks } from '../upgrade-checks.ts';
import { itemsOf } from '../scenario.ts';
import type { Scenario } from '../scenario.ts';
import type { Review } from '../verdict.ts';
import { importAttempt } from '../interactive/cli.ts';
import type { Assessment } from '../interactive/acceptance.ts';
import { library } from '../library.ts';
import { judgeAttempt, judgeCell } from '../verdict.ts';
import { preflight, runAttempt, runBatch } from './run.ts';
import type { AttemptIsolation, BatchOptions } from './run.ts';
import { syntheticClientState } from './test-state.ts';
import { classifyResult } from '../evidence.ts';
import { zeroWriteRefusals, exactUpgradeHistory, upgradeLifecycle } from '../upgrade-evidence.ts';
import * as services from './service.ts';
import { upgradeRules } from './upgrade.ts';
import * as canaryBuild from '../../helpers/canary-release.mjs';

const scratch = realpathSync(mkdtempSync('/private/tmp/wf-upgrade-test-'));
const state = syntheticClientState(scratch);
const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(cache, { recursive: true, mode: 0o700 });
const records = mkdtempSync(join(cache, 'upgrade-test-'));
const driver = join(scratch, 'fake-upgrade.mjs');
copyFileSync(fileURLToPath(new URL('./fake-upgrade.mjs', import.meta.url)), driver); chmodSync(driver, 0o755);
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });
const subject = (id = 'U-codex-process') => asScenario(upgradeChecks.find(u => u.id === id)!);
const options = (id: string, model = 'fake-upgrade'): BatchOptions => ({ batchId: id, scenarios: [], upgradeChecks: ['U-codex-process'], count: 1, ceiling: 1,
  out: join(records, id), scratchRoot: scratch, ...state, codex: { bin: driver, model, effort: 'low', timeoutMs: 20_000, sandbox: true } });
const run = async (id: string, mode = 'U-codex-process', model = 'fake-upgrade', timeoutMs = 20_000) => {
  return runScenario(id, subject(mode), model, timeoutMs);
};
const runScenario = async (id: string, scenario: Scenario, model = 'fake-upgrade', timeoutMs = 20_000) => {
  const o = options(id, model);
  o.codex.timeoutMs = timeoutMs;
  const outcome = await runAttempt(o, { attemptId: 'attempt', scenario }, () => false, () => undefined);
  const record = JSON.parse(readFileSync(join(o.out, 'attempt/attempt.json'), 'utf8')) as AttemptRecord & { isolation: AttemptIsolation };
  return { record, outcome, o };
};
const scripts = (a: AttemptRecord) => Object.fromEntries(itemsOf(subject(a.subject.id)).flatMap(i => i.judge === 'script' ? [[i.id, i.check(a).status]] : []));
// Fixed verdict-engine fixture for the unrelated qualitative item, never a real review or acceptance record.
const reviewedVerdict = (a: AttemptRecord) => judgeAttempt(subject(a.subject.id), a, { reviews: [
  { itemId: 'mismatch-as-outage', status: 'holds', reason: 'Synthetic fixture only: isolate the script verdict under test.', by: 'fixture', role: 'human' },
] });

test('upgrade selection is separate and cannot silently switch harness or mix candidate counts', () => {
  expect(library).toHaveLength(26);
  const o = options('plan');
  expect(preflight({ ...o, upgradeChecks: ['U-codex-process', 'U-codex-resume'], count: 2 }).plan).toHaveLength(4);
  expect(preflight({ ...o, scenarios: ['S0b'] }).refusals.join()).toMatch(/separate Batch/);
  expect(preflight({ ...o, upgradeChecks: ['U-claude-process'] }).refusals).not.toEqual([]);
  expect(preflight({ ...o, upgradeChecks: ['U-codex-process', 'U-codex-process'] }).refusals.join()).toMatch(/duplicate/);
  expect(preflight({ ...o, entry: 'dedicated' }).refusals.join()).toMatch(/does not apply|without Controller actions/);
  expect(subject().turns[0]!.say).not.toMatch(/9\.9\.9|LANTERN|v2:|version_mismatch/);
  expect(subject().turns[0]!.say).not.toMatch(/title according to|current rules/);
});

describe.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0)('owned upgrade through the real shared sandbox, fake native driver only', () => {
  test.each(['U-codex-process', 'U-codex-resume'])('text-only Resource recovery passes in %s', async mode => {
    const { record: a } = await run(`text-recovery-${mode}`, mode, 'fake-upgrade-text-resource');
    expect(a.run.completeness).toBe('complete');
    expect(a.missing).toEqual([]);
    const read = a.events.find(e => e.kind === 'tool-call' && e.tool === 'read_mcp_resource');
    expect(read).toMatchObject({ result: { known: true, value: { server: 'wayfinder', uri: 'wayfinder://workflow/exploration', contents: expect.any(Array) } } });
    expect(scripts(a)).toMatchObject({ 'guessed-version': 'holds', 'invalid-recovery': 'holds', 'writes-new-version': 'holds',
      [mode === 'U-codex-process' ? 'reads-new-rules' : 'resume-refusal-recovery']: 'holds' });
    expect(reviewedVerdict(a).outcome).toBe('pass');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'].flatMap(mode => ['bad-reply', 'stale-lost-resource'].map(fault => ({ mode, fault }))))(
    'text-only Resource exposure preserves $fault in $mode', async ({ mode, fault }) => {
      const { record: a } = await run(`text-${fault}-${mode}`, mode, `fake-upgrade-text-${fault}`);
      const item = fault === 'bad-reply' ? 'canary-reply-violation' : 'invalid-recovery';
      expect(scripts(a)[item]).toBe('violated');
      if (fault === 'stale-lost-resource') a.missing.push('events.tool-call');
      expect(reviewedVerdict(a).outcome).toBe('fail');
      a.run.completeness = 'timeout';
      const failed = reviewedVerdict(a);
      expect(failed.outcome).toBe('fail');
      const passed = reviewedVerdict((await run(`text-control-${fault}-${mode}`, mode, 'fake-upgrade-text-resource')).record);
      expect(passed.outcome).toBe('pass');
      expect(judgeCell(subject(mode), [failed, passed, passed], 2).outcome).toBe('flaky');
    }, 60_000);
  test('legacy structured Resource completion remains supported', async () => {
    expect(reviewedVerdict((await run('structured-resource', 'U-codex-process', 'fake-upgrade-structured-resource')).record).outcome).toBe('pass');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('a lost native Resource result leaves recovery unknown in %s', async mode => {
    const { record: a, outcome } = await run(`lost-resource-${mode}`, mode, 'fake-upgrade-lost-resource');
    expect(outcome.completeness).toBe('complete');
    expect(a.missing).toEqual([]);
    const index = a.events.findIndex(e => e.kind === 'tool-call' && e.tool === 'read_mcp_resource' && !e.result.known);
    expect(index).toBeGreaterThan(-1);
    expect(a.events.some(e => e.kind === 'resource-read')).toBe(false);
    for (const marker of [false, true]) {
      const damaged = structuredClone(a);
      if (marker) {
        // A declared missing field is unavailable even if a stale value still occupies it.
        const call = damaged.events[index]!;
        if (call.kind === 'tool-call') call.result = { known: true, value: { contents: [] } };
        damaged.missing.push(`events[${index}].result`);
      }
      expect(scripts(damaged)).toMatchObject({ 'invalid-recovery': 'unknown',
        [mode === 'U-codex-process' ? 'reads-new-rules' : 'resume-refusal-recovery']: 'unknown',
        // Resume independently received the current version in fresh initialization.
        'guessed-version': mode === 'U-codex-process' ? 'unknown' : 'holds' });
      if (mode === 'U-codex-process') expect(scripts(damaged)['writes-new-version']).toBe('unknown');
      expect(reviewedVerdict(damaged).outcome).toBe('insufficient-evidence');
      damaged.run.completeness = 'timeout';
      expect(reviewedVerdict(damaged).outcome).toBe('incomplete');
    }
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('a proven exposure then stale retry survives a later lost Resource result in %s', async mode => {
    const { record: a } = await run(`stale-lost-resource-${mode}`, mode, 'fake-upgrade-stale-lost-resource');
    expect(a.events.some(e => e.kind === 'resource-read' && e.ok)).toBe(true);
    expect(a.events.some(e => e.kind === 'tool-call' && e.tool === 'read_mcp_resource' && !e.result.known)).toBe(true);
    expect(scripts(a)['invalid-recovery']).toBe('violated');
    expect(reviewedVerdict(a).outcome).toBe('fail');
    a.run.completeness = 'timeout';
    const failed = reviewedVerdict(a);
    expect(failed.outcome).toBe('fail');
    const passed = reviewedVerdict((await run(`stale-lost-control-${mode}`, mode)).record);
    expect(passed.outcome).toBe('pass');
    expect(judgeCell(subject(mode), [failed, passed, passed], 2).outcome).toBe('flaky');
  }, 60_000);
  test('a missing Resource result cannot establish its derived rule phase or a canary reply violation', async () => {
    const { record: a } = await run('resource-derived-phase');
    expect(reviewedVerdict(a).outcome).toBe('pass');
    const index = a.events.findIndex(e => e.kind === 'tool-call' && e.tool === 'read_mcp_resource');
    expect(index).toBeGreaterThan(-1);
    for (const marker of [false, true]) {
      const damaged = structuredClone(a);
      const call = damaged.events[index]!;
      if (marker) damaged.missing.push(`events[${index}].result`);
      else if (call.kind === 'tool-call') call.result = { known: false, reason: 'Native result unavailable, derived records retained as a gap probe.' };
      const reply = damaged.events.findLast(e => e.kind === 'message' && e.role === 'assistant');
      if (reply?.kind === 'message') reply.text = 'Finished the probe.';
      expect(scripts(damaged)).toMatchObject({ 'guessed-version': 'unknown', 'invalid-recovery': 'unknown', 'reads-new-rules': 'unknown',
        'writes-new-version': 'unknown', 'canary-reply-violation': 'unknown', 'canary-reply': 'unknown' });
      expect(reviewedVerdict(damaged).outcome).toBe('insufficient-evidence');
      damaged.run.completeness = 'timeout';
      expect(reviewedVerdict(damaged).outcome).toBe('incomplete');
    }
  }, 60_000);
  test('a witnessed stale retry remains forbidden when unrelated trace gaps follow', async () => {
    const { record: a, outcome } = await run('stale-recovered', 'U-codex-process', 'fake-upgrade-stale-recovered-timeout', 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(scripts(a)).toMatchObject({ 'upgrade-lifecycle': 'holds', 'reads-new-rules': 'holds', 'invalid-recovery': 'violated', 'writes-new-version': 'violated' });
    const passed = reviewedVerdict((await run('stale-recovered-pass')).record);
    for (const marker of ['events.resource-read', 'events.tool-call']) {
      const damaged = structuredClone(a); damaged.missing.push(marker);
      expect(scripts(damaged)).toMatchObject({ 'invalid-recovery': 'violated', 'writes-new-version': 'violated' });
      const failed = reviewedVerdict(damaged);
      expect(failed.outcome).toBe('fail');
      expect(judgeCell(subject(), [failed, passed, passed], 2).outcome).toBe('flaky');
    }
  }, 60_000);
  test('a lost native Map reread result is uncertainty, not proof of skipped recovery', async () => {
    const { record: a, outcome } = await run('lost-reread', 'U-codex-process', 'fake-upgrade-lost-reread');
    expect(outcome.completeness).toBe('complete');
    const readIndex = a.events.findIndex(e => e.kind === 'tool-call' && e.tool === 'map_read' && !e.result.known);
    expect(readIndex).toBeGreaterThan(-1);
    for (const marker of [null, `events[${readIndex}].result`]) {
      const damaged = structuredClone(a); if (marker) damaged.missing.push(marker);
      expect(scripts(damaged)).toMatchObject({ 'invalid-recovery': 'unknown', 'reads-new-rules': 'unknown' });
      expect(reviewedVerdict(damaged).outcome).toBe('insufficient-evidence');
      damaged.run.completeness = 'timeout';
      expect(reviewedVerdict(damaged).outcome).toBe('incomplete');
    }
  }, 60_000);
  test('a pre-exposure reply is not retroactively judged by the canary after timeout', async () => {
    const { record: a, outcome } = await run('pre-exposure', 'U-codex-process', 'fake-upgrade-pre-exposure-timeout', 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(scripts(a)['canary-reply-violation']).toBe('holds');
    expect(scripts(a)['canary-reply']).toBe('unknown');
    const incomplete = reviewedVerdict(a);
    expect(incomplete.outcome).toBe('incomplete');
    const pass = reviewedVerdict((await run('pre-exposure-pass')).record);
    expect(judgeCell(subject(), [incomplete, pass, pass], 2).outcome).toBe('pass');
  }, 60_000);
  // One precedence matrix: native fakes for runner cases, explicitly damaged copies for missing evidence,
  // and the existing offline interactive fixture. These annotations are verdict fixtures, not acceptance.
  const captured = new Map<string, ReturnType<typeof runScenario>>();
  const capture = async (id: string, model: string) => {
    const key = `${id}-${model}`;
    const scenario = id.startsWith('U-') ? subject(id) : library.find(s => s.id === id)!;
    if (!captured.has(key)) captured.set(key, runScenario(`order-${key}`, scenario, model, 3000));
    return { scenario, ...structuredClone(await captured.get(key)!) };
  };
  const decision = (itemId: string, status: 'holds' | 'violated'): Review =>
    ({ itemId, status, reason: 'Fixed verdict-order fixture only.', by: 'fixture', role: 'human' });
  const orderCases: { name: string; id: string; model: string; expected: string; review?: string; damage?: string; marker?: string }[] = [
    { name: 'S12 timeout + negative human reading', id: 'S12', model: 'fake-upgrade-no-trigger-timeout', expected: 'incomplete', review: 'recommends' },
    { name: 'S12 rate limit + negative human reading', id: 'S12', model: 'fake-upgrade-no-trigger-timeout', expected: 'incomplete', review: 'recommends', damage: 'rate-limit' },
    { name: 'S12 completed + negative human reading', id: 'S12', model: 'fake-upgrade-no-trigger', expected: 'fail', review: 'recommends' },
    { name: 'W5 outage never triggered', id: 'W5', model: 'fake-upgrade-no-trigger', expected: 'incomplete', review: 'reports-outage' },
    { name: 'W2 proposal never appeared', id: 'W2', model: 'fake-upgrade-no-trigger', expected: 'incomplete', review: 'one-settled' },
    { name: 'Claude interactive capability unconfirmed', id: 'interactive', model: '', expected: 'insufficient-evidence' },
    ...['U-codex-process', 'U-codex-resume'].flatMap(id => [
      { name: `${id} baseline`, id, model: 'fake-upgrade', expected: 'pass' },
      { name: `${id} early Ticket / no upgrade`, id, model: 'fake-upgrade-early-ticket', expected: 'incomplete', damage: 'early' },
      { name: `${id} stored write precedes restart boundary`, id, model: 'fake-upgrade-wrong-ticket-timeout', expected: 'incomplete', damage: 'late-restart' },
      { name: `${id} Conflict replay / unknown receipt / timeout`, id, model: 'fake-upgrade-conflict-unknown-timeout', expected: 'fail' },
      { name: `${id} two Tickets / timeout`, id, model: 'fake-upgrade-two-tickets-timeout', expected: 'fail' },
      { name: `${id} wrong Ticket / timeout`, id, model: 'fake-upgrade-wrong-ticket-timeout', expected: 'fail' },
    ]),
    ...['events', 'events.tool-call'].flatMap(marker => ['Resource', 'refusal'].map(damage =>
      ({ name: `missing ${damage} declared by ${marker}`, id: 'U-codex-process', model: 'fake-upgrade', expected: 'insufficient-evidence', damage, marker }))),
  ];
  test.each(orderCases)('verdict order: $name', async row => {
    if (row.id === 'interactive') {
      const fixtures = fileURLToPath(new URL('../fixtures/interactive/', import.meta.url));
      const assessment = JSON.parse(readFileSync(join(fixtures, 'claude-assessment.json'), 'utf8')) as Assessment;
      const dir = join(scratch, 'order-interactive');
      cpSync(fixtures, dir, { recursive: true });
      copyFileSync(join(fixtures, 'claude-capture.json'), join(dir, 'capture.json'));
      const verdict = importAttempt(dir, 'claude-supported.jsonl', assessment).verdicts[0]!.verdict;
      expect(verdict.outcome).toBe(row.expected);
      expect(verdict.required[0]!.status).toBe('unknown');
      expect(verdict.expect.every(g => g.items.every(i => i.status === 'unknown'))).toBe(true);
      return;
    }
    const { scenario, record: a, outcome } = await capture(row.id, row.model);
    if ('damage' in row && row.damage === 'rate-limit') a.run.completeness = 'rate-limited';
    // Fixed contrary ordering derived from a real fake run: the Ticket is before the alleged restart.
    if ('damage' in row && row.damage === 'late-restart') a.upgrade!.restart!.seq = a.events.length + 1;
    if (row.marker) {
      a.missing.push(row.marker);
      if (row.damage === 'Resource') {
        a.events = a.events.filter(e => e.kind !== 'resource-read');
        a.given = a.given.filter(g => g.rulesSource.kind !== 'resource');
      } else a.events = a.events.filter(e => !(e.kind === 'tool-call' && e.result.known && classifyResult(e.result.value) === 'version-mismatch'));
    }
    const reviews = [decision('mismatch-as-outage', 'holds'), ...(row.review ? [decision(row.review, 'violated')] : [])];
    const verdict = judgeAttempt(scenario, a, { reviews });
    expect(verdict.outcome).toBe(row.expected);
    if ('damage' in row && row.damage === 'early') {
      expect(outcome.completeness).toBe('precondition-not-met');
      expect(a.upgrade?.restart).toBeUndefined();
      expect(exactUpgradeHistory(a).status).toBe('unknown');
    }
    if ('damage' in row && row.damage === 'late-restart') expect(exactUpgradeHistory(a).status).toBe('unknown');
    if (row.marker) {
      const relevant = row.damage === 'Resource' ? ['guessed-version', 'invalid-recovery', 'reads-new-rules', 'writes-new-version'] : ['refused-unwritten'];
      for (const id of relevant) expect(scripts(a)[id], id).toBe('unknown');
    }
    if (row.id.startsWith('U-') && row.expected === 'fail') {
      expect(outcome.completeness).toBe('timeout');
      const pass = reviewedVerdict((await capture(row.id, 'fake-upgrade')).record);
      expect(pass.outcome).toBe('pass');
      expect(judgeCell(scenario, [verdict, pass, pass], 2).outcome).toBe('flaky');
    }
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'].flatMap(mode => ['two-tickets', 'wrong-ticket'].map(fault => [mode, fault])))
  ('an observed %s / %s violation inside one commit survives timeout and reruns', async (mode, fault) => {
    const { record: a, outcome } = await run(`${mode}-${fault}`, mode, `fake-upgrade-${fault}-timeout`, 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(a.maps[0]!.history).toHaveLength(2);
    expect(a.maps[0]!.history[1]!.state.tickets.map(t => t.id)).toEqual(fault === 'two-tickets' ? ['Probe.One', 'Probe.Two'] : ['Probe.Uno']);
    expect(scripts(a)['exact-history']).toBe('violated');
    const failed = reviewedVerdict(a);
    expect(failed.outcome).toBe('fail');
    const { record: recovered } = await run(`retry-${mode}-${fault}`, mode);
    const passed = reviewedVerdict(recovered);
    expect(passed.outcome).toBe('pass');
    expect(judgeCell(subject(mode), [failed, passed, passed], 2).outcome).toBe('flaky');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('combined Conflict replay and wrong committed state survive unknown receipts and timeout in %s', async mode => {
    const { record: a, outcome } = await run(`combined-${mode}`, mode, 'fake-upgrade-conflict-two-tickets-timeout', 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(a.maps[0]!.history).toHaveLength(2);
    expect(a.maps[0]!.history[1]!.state.tickets).toHaveLength(2);
    expect(scripts(a)).toMatchObject({ 'conflict-replay': 'violated', 'exact-history': 'violated' });
    expect(reviewedVerdict(a).outcome).toBe('fail');
    a.missing.push('receipts', 'events.tool-call');
    expect(scripts(a)).toMatchObject({ 'conflict-replay': 'violated', 'exact-history': 'violated' });
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('confirmed Conflict replay survives a later missing native result and timeout in %s', async mode => {
    const { record: a, outcome } = await run(`conflict-unknown-${mode}`, mode, 'fake-upgrade-conflict-unknown-timeout', 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(a.maps[0]!.history).toHaveLength(2);
    const writes = a.events.filter(e => e.kind === 'tool-call' && e.tool === 'map_apply');
    expect(writes.slice(-3).map(e => e.kind === 'tool-call' && (e.result.known ? classifyResult(e.result.value) : 'unknown')))
      .toEqual(['conflict', 'committed', 'unknown']);
    expect(reviewedVerdict(a).outcome).toBe('fail');
    expect(scripts(a)['conflict-replay']).toBe('violated');
    a.missing.push('events.tool-call');
    expect(scripts(a)['conflict-replay']).toBe('violated');
    expect(reviewedVerdict(a).outcome).toBe('fail');
    a.events = a.events.filter(e => e.kind !== 'process');
    expect(reviewedVerdict(a).outcome).toBe('fail');
    delete a.upgrade!.restart;
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('an early Ticket is a precondition failure in %s', async mode => {
    const { outcome, record } = await run(`early-${mode}`, mode, 'fake-upgrade-early-ticket');
    expect(outcome.completeness).toBe('precondition-not-met');
    expect(reviewedVerdict(record).outcome).toBe('incomplete');
    expect(exactUpgradeHistory(record).status).toBe('unknown');
  }, 60_000);
  test('the restarted service must actually serve the expected canary contract', async () => {
    const original = canaryBuild.writeCanaryCheckout;
    const spy = vi.spyOn(canaryBuild, 'writeCanaryCheckout').mockImplementation(async (...args) => {
      const contracts = await original(...args);
      // Corrupt only this test's owned build after creation; no product source or unrelated service changes.
      const wrong = { ...contracts.after, instructions: contracts.before.instructions };
      writeFileSync(join(args[1], 'dist/workflow.generated.js'), `export const workflowContract = Object.freeze(${JSON.stringify(wrong)});\n`);
      return contracts;
    });
    try {
      const { record: a, outcome } = await run('wrong-canary');
      expect(outcome.completeness).toBe('precondition-not-met');
      expect(reviewedVerdict(a).outcome).not.toBe('pass');
    } finally { spy.mockRestore(); }
  }, 60_000);
  test.each(['fake-upgrade-no-tools', 'fake-upgrade-no-native-tools'])('missing wire or native tool definitions cannot pass: %s', async model => {
    const { record: a } = await run(model, 'U-codex-process', model);
    expect(a.missing.some(m => /toolDescriptions|toolDefinitions/.test(m))).toBe(true);
    expect(reviewedVerdict(a).outcome).toBe('insufficient-evidence');
  }, 60_000);
  test('an explicit missing marker blocks upgrade acceptance even if a field still contains stale values', async () => {
    const { record: a } = await run('missing-marker');
    expect(reviewedVerdict(a).outcome).toBe('pass');
    a.missing.push('given[0].toolDefinitions');
    expect(reviewedVerdict(a).outcome).toBe('insufficient-evidence');
  }, 60_000);
  test('full tool evidence follows the build contract rather than a fixed tool count', async () => {
    const { record: a } = await run('expanded-tool-contract');
    // Fixed future-contract evidence derived from a complete fake run, not a claim about a shipped tool.
    const tool = { name: 'map_future', description: 'Synthetic extra contract tool', inputSchema: { type: 'object' } };
    for (const contract of Object.values(a.upgrade!.contracts)) contract.toolDescriptions[tool.name] = tool.description;
    for (const phase of a.given) {
      if (phase.toolDefinitions?.known) phase.toolDefinitions.value.push(tool);
      if (phase.toolDescriptions.known) phase.toolDescriptions.value[tool.name] = tool.description;
    }
    expect(reviewedVerdict(a).outcome).toBe('pass');
    const first = a.given[0]!.toolDefinitions!;
    if (first.known) first.value.pop();
    expect(reviewedVerdict(a).outcome).toBe('insufficient-evidence');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('a compliant final reply cannot erase an earlier canary reply violation in %s', async mode => {
    const { record: a } = await run(`reply-${mode}`, mode, 'fake-upgrade-bad-reply');
    expect(reviewedVerdict(a).outcome).toBe('fail');
    expect(scripts(a)['canary-reply']).toBe('violated');
    a.run.completeness = 'timeout';
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test('timeout preserves observed extra commits as a failure', async () => {
    const { record: a, outcome } = await run('extra-timeout', 'U-codex-process', 'fake-upgrade-extra-timeout', 3000);
    expect(outcome.completeness).toBe('timeout');
    expect(a.maps[0]!.history).toHaveLength(3);
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test('timeout preserves a refusal mutation in captured fake-driver evidence as a failure', async () => {
    const { record: a } = await run('refusal-mutation-timeout');
    a.upgrade!.writes.find(w => classifyResult(w.result) === 'version-mismatch')!.after = [];
    a.run.completeness = 'timeout';
    expect(zeroWriteRefusals(a).status).toBe('violated');
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test('every refusal requires new reads and its very next retry must attest those rules', async () => {
    const { record: a } = await run('repeated-refusal', 'U-codex-process', 'fake-upgrade-repeat-refusal');
    expect(a.receipts.filter(r => r.outcome.kind === 'not-written' && r.outcome.because === 'version-mismatch')).toHaveLength(2);
    expect(reviewedVerdict(a).outcome).toBe('fail');
    expect(scripts(a)).toMatchObject({ 'reads-new-rules': 'violated', 'writes-new-version': 'violated' });
    a.run.completeness = 'timeout';
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('a real Conflict followed by replay cannot pass %s', async mode => {
    const { record: a } = await run(`conflict-${mode}`, mode, 'fake-upgrade-conflict-replay');
    expect(a.events.some(e => e.kind === 'tool-call' && e.result.known && classifyResult(e.result.value) === 'conflict')).toBe(true);
    expect(a.maps[0]!.history).toHaveLength(2);
    expect(reviewedVerdict(a).outcome).toBe('fail');
  }, 60_000);
  test.each(['U-codex-process', 'U-codex-resume'])('%s records rules, real restart, native receipts and exact persistent outcome', async mode => {
    const { record: a, outcome, o } = await run(mode, mode);
    expect(outcome.completeness, outcome.detail).toBe('complete');
    expect(a.subject.kind).toBe('upgrade-check');
    expect(scripts(a)).toEqual(Object.fromEntries(Object.keys(scripts(a)).map(k => [k, 'holds'])));
    expect(a.maps[0]!.history).toHaveLength(2);
    expect(a.isolation).toMatchObject({ sandbox: true, scratchRemoved: true, controlDirectoryRemoved: true, databaseDirectoryRemoved: true, failures: [],
      attribution: { agentRevisions: 2, committedReceipts: 2, mismatched: [], unplaced: [] } });
    expect(a.upgrade!.restart!.beforePid).not.toBe(a.upgrade!.restart!.afterPid);
    const relay = readFileSync(join(o.out, 'attempt/raw/relay-A.jsonl'), 'utf8');
    expect(relay).toContain('inputSchema');
    if (mode === 'U-codex-process') {
      expect(relay).toContain('"status":404');
      expect(a.receipts.map(r => r.outcome.kind)).toEqual(['committed', 'not-written', 'committed']);
      const resource = a.given.find(g => g.rulesSource.kind === 'resource')!;
      expect(resource.resourceText?.known).toBe(true);
      expect(resource.instructions).toEqual({ known: true, value: a.upgrade!.contracts.before.instructions });
      expect(resource.toolDescriptions).toEqual({ known: true, value: a.upgrade!.contracts.before.toolDescriptions });
      const refusal = a.upgrade!.writes.find(w => classifyResult(w.result) === 'version-mismatch')!;
      expect(refusal.before).toEqual(refusal.after);
      const corrupted = structuredClone(a);
      corrupted.upgrade!.writes.find(w => classifyResult(w.result) === 'version-mismatch')!.after = [];
      expect(zeroWriteRefusals(corrupted).status).toBe('violated');
      corrupted.upgrade!.writes = [];
      expect(zeroWriteRefusals(corrupted).status).toBe('unknown');
      const repeated = structuredClone(a);
      const native = repeated.events.find(e => e.kind === 'tool-call' && e.result.known && classifyResult(e.result.value) === 'version-mismatch')!;
      repeated.events.push({ ...native, seq: repeated.events.length });
      expect(zeroWriteRefusals(repeated).status).toBe('unknown');
      const failedRead = structuredClone(a);
      failedRead.events = failedRead.events.map(e => e.kind === 'resource-read' ? { ...e, ok: false } : e);
      expect(scripts(failedRead)['reads-new-rules']).toBe('violated');
      const missingNative = upgradeRules(a.upgrade!, null, a.events, [], 'A', 0, 0);
      expect(missingNative.at(-1)!.resourceText?.known).toBe(false);
      expect(missingNative.at(-1)!.rulesSource.kind).toBe('unknown');
      expect(classifyResult({ kind: 'rejected', code: 'version_mismatch' }, true)).toBe('version-mismatch');
      const unknownNative = structuredClone(a);
      unknownNative.upgrade!.mode = 'resume';
      unknownNative.events = unknownNative.events.map(e => e.kind === 'tool-call' && e.result.known && classifyResult(e.result.value) === 'version-mismatch'
        ? { ...e, result: { known: false, reason: 'lost native result' } } : e);
      expect(zeroWriteRefusals(unknownNative).status).toBe('unknown');
      unknownNative.upgrade!.writes.find(w => classifyResult(w.result) === 'version-mismatch')!.after = [];
      expect(zeroWriteRefusals(unknownNative).status).toBe('violated');
    } else {
      expect(a.sessions[0]!.turns[0]!.nativeId).toEqual(a.sessions[0]!.turns[1]!.nativeId);
      expect(a.given.at(-1)!.instructions).toEqual({ known: true, value: a.upgrade!.contracts.after.instructions });
      const lost = structuredClone(a); lost.receipts.pop();
      expect(exactUpgradeHistory(lost).status).toBe('unknown');
      lost.upgrade!.restart!.afterPid = lost.upgrade!.restart!.beforePid;
      expect(upgradeLifecycle(lost).status).toBe('violated');
    }
    // The remaining qualitative W5 misclassification item is deliberately left to the approved model review.
    expect(judgeAttempt(subject(mode), a).outcome).toBe('insufficient-evidence');
  }, 60_000);

  test('changing only the version cannot pass either canary rule', async () => {
    const { record: a, outcome } = await run('version-only', 'U-codex-process', 'fake-upgrade-version-only');
    expect(outcome.completeness, outcome.detail).toBe('complete');
    expect(scripts(a)).toMatchObject({ 'writes-new-version': 'holds', 'follows-canary-rule': 'violated', 'canary-reply': 'violated', 'exact-history': 'violated' });
    a.run.completeness = 'timeout';
    expect(judgeAttempt(subject(), a).outcome).toBe('fail');
  }, 60_000);

  test('an untriggered restart stays incomplete, and cleanup still runs', async () => {
    const { record: a, outcome } = await run('no-trigger', 'U-codex-process', 'fake-upgrade-no-trigger');
    expect(outcome.completeness).toBe('precondition-not-met');
    expect(a.upgrade!.restart).toBeUndefined();
    expect(a.isolation.serviceStopped).not.toBeNull();
    expect(judgeAttempt(subject(), a).outcome).not.toBe('pass');
  }, 60_000);

  test('cancellation during restart drains the Controller and stops the replacement child', async () => {
    const original = services.startService;
    let cancelled = false;
    let kill = () => undefined as void;
    const spy = vi.spyOn(services, 'startService').mockImplementation(async (...args) => {
      const owned = await original(...args);
      const restart = owned.restartCanary;
      owned.restartCanary = async () => {
        const changed = await restart(); cancelled = true; kill(); return changed;
      };
      return owned;
    });
    try {
      const o = options('cancel');
      const outcome = await runAttempt(o, { attemptId: 'attempt', scenario: subject() }, () => cancelled, k => { kill = k; });
      const a = JSON.parse(readFileSync(join(o.out, 'attempt/attempt.json'), 'utf8')) as AttemptRecord & { isolation: AttemptIsolation };
      expect(outcome.completeness).toBe('cancelled');
      expect(a.upgrade!.restart).toBeDefined();
      expect(a.isolation).toMatchObject({ databaseDirectoryRemoved: true, scratchRemoved: true, serviceStopped: { code: 0 } });
      for (const pid of [a.upgrade!.restart!.beforePid, a.upgrade!.restart!.afterPid]) expect(() => process.kill(pid, 0)).toThrow();
      expect(judgeAttempt(subject(), a).outcome).not.toBe('pass');
    } finally { spy.mockRestore(); }
  }, 60_000);

  test('Batch ceiling accounts upgrade Attempts separately with no automatic reruns', async () => {
    const o = { ...options('batch'), upgradeChecks: ['U-codex-process', 'U-codex-resume'] };
    const result = await runBatch(o);
    expect(result.refusals).toEqual([]);
    expect(result.outcomes.map(r => r.completeness)).toEqual(['complete', 'not-run']);
    const batch = JSON.parse(readFileSync(join(o.out, 'batch.json'), 'utf8'));
    expect(batch).toMatchObject({ kind: 'upgrade-checks', count: 1, plannedAttempts: 2, quota: { attemptCeiling: 1, nativeTurnCeiling: 1, automaticRetries: 0, modelReviews: 0 } });
    expect((await runBatch({ ...o, codex: { ...o.codex, sandbox: false } })).refusals).toContain('upgrade checks require the shared sandbox');
  }, 60_000);
});
