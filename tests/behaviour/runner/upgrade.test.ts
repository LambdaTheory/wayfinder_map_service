import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { AttemptRecord } from '../evidence.ts';
import { asScenario, upgradeChecks } from '../upgrade-checks.ts';
import { itemsOf } from '../scenario.ts';
import { library } from '../library.ts';
import { judgeAttempt } from '../verdict.ts';
import { preflight, runAttempt, runBatch } from './run.ts';
import type { AttemptIsolation, BatchOptions } from './run.ts';
import { syntheticClientState } from './test-state.ts';
import { classifyResult } from '../evidence.ts';
import { zeroWriteRefusals, exactUpgradeHistory, upgradeLifecycle } from '../upgrade-evidence.ts';
import * as services from './service.ts';
import { upgradeRules } from './upgrade.ts';

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
const run = async (id: string, mode = 'U-codex-process', model = 'fake-upgrade') => {
  const o = options(id, model);
  const outcome = await runAttempt(o, { attemptId: 'attempt', scenario: subject(mode) }, () => false, () => undefined);
  const record = JSON.parse(readFileSync(join(o.out, 'attempt/attempt.json'), 'utf8')) as AttemptRecord & { isolation: AttemptIsolation };
  return { record, outcome, o };
};
const scripts = (a: AttemptRecord) => Object.fromEntries(itemsOf(subject(a.subject.id)).flatMap(i => i.judge === 'script' ? [[i.id, i.check(a).status]] : []));

test('upgrade selection is separate and cannot silently switch harness or mix candidate counts', () => {
  expect(library).toHaveLength(26);
  const o = options('plan');
  expect(preflight({ ...o, upgradeChecks: ['U-codex-process', 'U-codex-resume'], count: 2 }).plan).toHaveLength(4);
  expect(preflight({ ...o, scenarios: ['S0b'] }).refusals.join()).toMatch(/separate Batch/);
  expect(preflight({ ...o, upgradeChecks: ['U-claude-process'] }).refusals).not.toEqual([]);
  expect(preflight({ ...o, upgradeChecks: ['U-codex-process', 'U-codex-process'] }).refusals.join()).toMatch(/duplicate/);
  expect(subject().turns[0]!.say).not.toMatch(/9\.9\.9|LANTERN|v2:|version_mismatch/);
});

describe.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0)('owned upgrade through the real shared sandbox, fake native driver only', () => {
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
