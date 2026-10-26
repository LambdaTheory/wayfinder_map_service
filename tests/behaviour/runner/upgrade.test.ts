import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const o = options(id, model);
  o.codex.timeoutMs = timeoutMs;
  const outcome = await runAttempt(o, { attemptId: 'attempt', scenario: subject(mode) }, () => false, () => undefined);
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
  expect(subject().turns[0]!.say).not.toMatch(/9\.9\.9|LANTERN|v2:|version_mismatch/);
  expect(subject().turns[0]!.say).not.toMatch(/title according to|current rules/);
});

describe.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0)('owned upgrade through the real shared sandbox, fake native driver only', () => {
  test.each(['U-codex-process', 'U-codex-resume'])('an early Ticket is a precondition failure in %s', async mode => {
    const { outcome } = await run(`early-${mode}`, mode, 'fake-upgrade-early-ticket');
    expect(outcome.completeness).toBe('precondition-not-met');
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
