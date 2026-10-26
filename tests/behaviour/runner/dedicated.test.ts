import { captureArtifacts } from './artifacts.ts';
import { syntheticClientState } from './test-state.ts';
// Model-free onboarding evidence for the Dedicated Entry; real-model onboarding still needs an approved Batch.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test, vi } from 'vitest';
import { clientProfiles, supportsFor } from '../clients.ts';
import type { AttemptRecord } from '../evidence.ts';
import { library } from '../library.ts';
import { judgeAttempt, judgeCell } from '../verdict.ts';
import { prepareClient, prepareSandbox, prepareSession } from './codex.ts';
import { dedicatedContext, dedicatedLauncher, dedicatedServiceDirectory, prepareDedicated, runDedicatedTurn } from './dedicated.ts';
import { isolationSnapshot, preflight, runAttempt, runBatch } from './run.ts';
import { newToken, startService } from './service.ts';
import * as services from './service.ts';
import * as controllers from './controller.ts';

const scratch = realpathSync(mkdtempSync('/private/tmp/wf-dedicated-test-'));
const caches = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(caches, { recursive: true, mode: 0o700 });
const records = realpathSync(mkdtempSync(join(caches, 'b02d-tests-')));
const fake = join(scratch, 'fake-codex.mjs');
copyFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), fake);
chmodSync(fake, 0o700);
const auth = join(scratch, 'synthetic-auth.json');
writeFileSync(auth, '{}', { mode: 0o600 });
const sandbox = spawnSync('which', ['sandbox-exec']).status === 0;
const clientState = syntheticClientState(scratch);
const options = { model: 'fake-model', effort: 'low', bin: fake, sandbox, timeoutMs: 60_000 };
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });

test('Dedicated planning uses the approved B02d-onboarding-20261026 evidence (#68)', () => {
  expect(preflight({ entry: 'dedicated', batchId: 'D', scenarios: ['S0b', 'F11'], count: 2, ceiling: 4 }).refusals).toEqual([]);
  expect(clientProfiles.codex.onboarded).toContain('dedicated');
  expect(supportsFor('codex', 'dedicated')['multi-turn']).toBe(true);
  expect(supportsFor('codex', 'mcp-only')['multi-turn']).toBe(true);
  expect(supportsFor('codex', 'matt')['multi-turn']).toBe('unverified');
});

test.each(['mcp-only', 'dedicated'] as const)('%s preserves a service start failure through catalog export', async entry => {
  const start = vi.spyOn(services, 'startService').mockRejectedValueOnce(new Error('synthetic service startup failure'));
  const out = join(records, `service-failure-${entry}`);
  try {
    const outcome = await runAttempt({ entry, batchId: 'ServiceFailure', scenarios: [], count: 1, ceiling: 1, out,
      codex: { ...options, sandbox: true }, scratchRoot: scratch, ...clientState },
    { attemptId: 'S0b-1', scenario: library.find(s => s.id === 'S0b')! }, () => false, () => undefined);
    expect(start).toHaveBeenCalledOnce();
    expect(outcome.completeness, outcome.detail).toBe('service-failed');
    const record = JSON.parse(readFileSync(join(out, 'S0b-1/attempt.json'), 'utf8')) as AttemptRecord;
    expect(record.run.completeness).toBe('service-failed');
    expect(record.missing).toContain('maps');
    expect(record.sessions.every(s => s.turns.length === 0)).toBe(true);
  } finally { start.mockRestore(); }
});

test.skipIf(!sandbox)('Dedicated catalog export failure preserves an unmet precondition without a completed verdict', async () => {
  const realConnect = controllers.connectController;
  const exportCatalog = vi.fn(async () => { throw new Error('synthetic catalog export failure'); });
  const connect = vi.spyOn(controllers, 'connectController').mockImplementationOnce(async (...args) => ({
    ...await realConnect(...args), exportCatalog,
  }));
  const out = join(records, 'precondition-export-failure');
  const scenario = library.find(s => s.id === 'S0b')!;
  try {
    const outcome = await runAttempt({ entry: 'dedicated', batchId: 'PreconditionExportFailure', scenarios: [], count: 1, ceiling: 1,
      out, codex: options, scratchRoot: scratch, ...clientState },
    // With no earlier proposal, the reply gate stops before a fake client turn can start.
    { attemptId: 'S0b-1', scenario: { ...scenario, turns: [scenario.turns[1]!] } }, () => false, () => undefined);
    expect(exportCatalog).toHaveBeenCalledOnce();
    expect(outcome.completeness, outcome.detail).toBe('precondition-not-met');
    expect(outcome.detail).toContain('catalog export failed');
    const record = JSON.parse(readFileSync(join(out, 'S0b-1/attempt.json'), 'utf8')) as AttemptRecord;
    expect(record.run.completeness).toBe('precondition-not-met');
    expect(record.missing).toContain('maps');
    expect(record.sessions.every(s => s.turns.length === 0)).toBe(true);
    const verdict = judgeAttempt(scenario, record);
    expect(verdict.outcome).toBe('incomplete');
    expect(verdict.expect.flatMap(group => group.items).every(item => item.status === 'unknown')).toBe(true);
    const cell = judgeCell(scenario, [verdict], 1);
    expect(cell.outcome).toBe('incomplete');
    expect(cell.counts).toMatchObject({ pass: 0, fail: 0, incomplete: 1 });
  } finally { connect.mockRestore(); }
}, 30_000);

test.skipIf(!sandbox)('real launcher runs and resumes inside the allowlist, records its context and never reaches everyday state', async () => {
  const before = isolationSnapshot(clientState.personalConfigRoot);
  const out = join(records, 'run');
  const scenario = library.find(s => s.id === 'S0b')!;
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'DedicatedFake', scenarios: [], count: 1, ceiling: 1, out,
    codex: options, scratchRoot: scratch, ...clientState }, { attemptId: 'S0b-1', scenario: { ...scenario, seed: { ...scenario.seed, fixtures: ['ask-card'] } } }, () => false, () => undefined);
  expect(outcome.completeness, outcome.detail).toBe('complete');
  const path = join(out, 'S0b-1');
  const record = JSON.parse(readFileSync(join(path, 'attempt.json'), 'utf8')) as AttemptRecord & { isolation: Record<string, unknown> };
  expect(record.entry).toBe('dedicated');
  expect(record.sessions).toHaveLength(1);
  expect(record.sessions[0]!.turns).toHaveLength(2);
  expect(record.sessions[0]!.nativeId.known).toBe(true);
  expect(record.sessions[0]!.clientId).toBe('Codex:fake-model:low');
  expect(record.receipts.map(r => r.outcome.kind)).toEqual(['committed', 'committed']);
  expect(record.isolation).toMatchObject({ sandbox: true, servedOwnDatabase: true, scratchRemoved: true,
    dedicatedServiceRemoved: true, launcherInvocations: 2, serviceStopped: { code: 0 },
    attribution: { mismatched: [], unplaced: [] } });
  expect(record.isolation.touchedEverydayDatabase).not.toEqual({ known: true, value: true });
  const context = JSON.parse(readFileSync(join(path, 'raw/entry-context.json'), 'utf8'));
  expect(context.launcher).toBe('scripts/wayfinder-agent/wayfinder');
  expect(context.context.map((c: { installed: boolean }) => c.installed)).toEqual([true, true, true, true]);
  expect(context.context.slice(0, 2).map((c: { shownToModel: boolean }) => c.shownToModel)).toEqual([false, false]);
  expect(record.given[0]!.extraContext.join()).toContain('.agents/skills/wayfinder/SKILL.md');
  const first = context.launches[0]; const second = context.launches[1];
  expect(first.argv).not.toContain('--ignore-user-config');
  expect(first.argv).toContain('--no-daemon');
  expect(first.argv[first.argv.indexOf('-m') + 1]).toBe('fake-model');
  expect(first.argv).toContain('model_reasoning_effort="low"');
  expect(second.argv.slice(-2)).toEqual([record.sessions[0]!.nativeId.known ? record.sessions[0]!.nativeId.value : '', '-']);
  expect(first.overrides.WAYFINDER_AGENT_STATE_ROOT).toContain('/wf-behave-S0b-1-');
  expect(first.overrides.WAYFINDER_AGENT_DATABASE).toMatch(/^~\/Library\/Caches\/wayfinder-behaviour-tests\/dedicated-[^/]+\/db\/maps.sqlite$/);
  expect(first.overrides.WAYFINDER_AGENT_SERVICE_DIR).toBe(first.overrides.WAYFINDER_AGENT_DATABASE.replace('/db/maps.sqlite', ''));
  expect(first.overrides.WAYFINDER_AGENT_OUTPUTS).toContain('/wf-behave-S0b-1-');
  expect(['18765', '18766']).not.toContain(first.overrides.WAYFINDER_AGENT_PORT);
  expect(first.argv.join(' ')).toContain(`http://127.0.0.1:${first.overrides.WAYFINDER_AGENT_PORT}/mcp`);
  expect(first.argv.join(' ')).not.toMatch(/:(18765|18766)\//);
  const probe = JSON.parse(readFileSync(join(path, 'raw/work/entry-probe.json'), 'utf8'));
  expect(probe.privateHome).toBe(first.home);
  expect(probe.authTarget).toMatch(/\/read-only-[^/]+\/launcher-home\/\.codex\/auth.json$/);
  expect(probe.instructionsAvailable && probe.skillAvailable && probe.authReadable).toBe(true);
  expect(probe.bootstrapKeys).toEqual([]);
  expect(probe.resumed).toBe(true);
  expect(readFileSync(join(path, 'raw/work/fake-note.txt'), 'utf8')).toBe('note\n');
  expect(existsSync(join(path, 'raw/work/src/ask-card.js'))).toBe(true);
  const commands = record.events.filter(e => e.kind === 'command');
  expect(commands.map(e => e.kind === 'command' && e.exitCode)).toEqual([0, 1, 0, 0, 1, 0]);
  expect(isolationSnapshot(clientState.personalConfigRoot)).toEqual(before);
}, 60_000);

test.skipIf(!sandbox)('Dedicated Batch metadata, ceilings and directory refusal preserve the Entry', async () => {
  const out = join(records, 'batch');
  const batch = { entry: 'dedicated' as const, batchId: 'DedicatedBatch', scenarios: ['S0b'], count: 2, ceiling: 1,
    out, codex: options, scratchRoot: scratch, ...clientState };
  const result = await runBatch(batch);
  expect(result.refusals).toEqual([]);
  expect(result.outcomes.map(o => o.completeness)).toEqual(['complete', 'not-run']);
  const metadata = JSON.parse(readFileSync(join(out, 'batch.json'), 'utf8'));
  expect(metadata.entry).toBe('dedicated');
  expect(metadata.isolation.personalConfigNamingThisRun).toEqual([]);
  expect((await runBatch(batch)).refusals.join()).toContain('already exists');
  expect((await runBatch({ ...batch, codex: { ...options, sandbox: false } })).refusals.join()).toContain('requires the allowlist sandbox');
}, 60_000);

test.skipIf(!sandbox)('Dedicated timeouts retain evidence and clean up the owned service', async () => {
  const scenario = library.find(s => s.id === 'S12')!;
  const out = join(records, 'timeout');
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'DedicatedTimeout', scenarios: [], count: 1, ceiling: 1,
    out, codex: { ...options, timeoutMs: 1_500 }, scratchRoot: scratch, ...clientState },
  { attemptId: 'D-1', scenario: { ...scenario, turns: [{ session: 'A', kind: 'opening', say: 'FAKE-SLEEP' }] } }, () => false, () => undefined);
  expect(outcome.completeness).toBe('timeout');
  const record = JSON.parse(readFileSync(join(out, 'D-1/attempt.json'), 'utf8'));
  expect(record.entry).toBe('dedicated');
  expect(record.isolation).toMatchObject({ dedicatedServiceRemoved: true, scratchRemoved: true, serviceStopped: { code: 0 } });
}, 30_000);

test('a stopped run service cannot make the launcher spawn an untracked replacement', async () => {
  const dir = dedicatedServiceDirectory();
  const own = mkdtempSync(join(scratch, 'lost-service-'));
  const controller = { clientId: 'Behaviour-Controller', token: newToken() };
  const service = await startService(dir, controller, []);
  try {
    const session = prepareSession(own, 'A', newToken(), { contents: '{}' });
    const layout = prepareSandbox(own);
  const workdir = join(own, 'work'); mkdirSync(workdir);
  const nativeOptions = { ...options, bin: prepareClient(layout.controlDir, options.bin) };
  const setup = prepareDedicated(session, service, controller, nativeOptions, layout, workdir);
    await service.stop();
    const result = spawnSync('/usr/bin/python3', ['-I', setup.launcher, '--harness', 'codex', '--method', 'mcp', '--', 'exec', '--json', '-'],
      { cwd: own, env: { ...setup.env, WAYFINDER_AGENT_DRY_RUN: '1' }, input: 'never run', encoding: 'utf8', timeout: 15_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('npm run build');
    expect(existsSync(join(dir, 'service.pid'))).toBe(false);
    expect(existsSync(setup.capturePath)).toBe(false);
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('artifact capture redacts credentials without corrupting other bytes or following links', () => {
  const source = mkdtempSync(join(scratch, 'artifacts-'));
  const target = join(records, 'artifacts');
  const token = 'synthetic-secret';
  writeFileSync(join(source, 'binary'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(token), Buffer.from([128, 0])]));
  writeFileSync(join(source, 'text.json'), '{"text":"\\u4f60\\u597d 🧭 synthetic-secret","seq":1}');
  symlinkSync(auth, join(source, 'auth-link'));
  captureArtifacts(source, target, { credential: token });
  expect(readFileSync(join(target, 'binary'))).toEqual(Buffer.concat([Buffer.from([0, 255]), Buffer.from('<credential>'), Buffer.from([128, 0])]));
  expect(existsSync(join(target, 'auth-link'))).toBe(false);
  expect(JSON.parse(readFileSync(join(target, 'text.json'), 'utf8'))).toEqual({ text: '你好 🧭 <credential>', seq: 1 });
});

async function launcherFixture() {
  const dir = dedicatedServiceDirectory();
  const own = mkdtempSync(join(scratch, 'cross-turn-'));
  const controller = { clientId: 'Behaviour-Controller', token: newToken() };
  const service = await startService(dir, controller, []);
  const session = prepareSession(own, 'A', newToken(), { contents: '{}' });
  const layout = prepareSandbox(own);
  const workdir = join(own, 'work'); mkdirSync(workdir);
  const nativeOptions = { ...options, bin: prepareClient(layout.controlDir, options.bin) };
  const setup = prepareDedicated(session, service, controller, nativeOptions, layout, workdir);
  session.codexHome = setup.codexHome;
  const request = { options: nativeOptions, session, port: service.port, workdir, profile: setup.profile, prompt: 'start' };
  return { dir, own, setup, session, service, request,
    sandboxed: (code: string) => spawnSync('/usr/bin/sandbox-exec', ['-f', setup.profile.path, process.execPath, '-e', code],
      { cwd: workdir, env: { PATH: process.env.PATH, HOME: join(setup.state, 'home'), CODEX_HOME: setup.state }, encoding: 'utf8', timeout: 10_000 }),
    close: async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); rmSync(layout.controlDir, { recursive: true, force: true }); } };
}

// These are actual client-permission writes between two real launcher invocations, not string checks.
test.skipIf(!sandbox).each(['codex', 'python3', 'service-build', 'profile'])('cross-turn %s planting is denied before the next launcher can execute it', async kind => {
  const f = await launcherFixture();
  const marker = join(records, `escaped-${kind}`);
  try {
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    const target = kind === 'service-build' ? join(f.setup.checkout, 'dist/mcp-start.js')
      : kind === 'profile' ? f.setup.profile.path : join(f.setup.shimDir, kind);
    const payload = kind === 'profile' ? '(version 1)\n(allow default)\n'
      : kind === 'service-build' ? `require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')`
      : `#!/bin/sh\nprintf escaped > '${marker}'\nexit 0\n`;
    const attack = f.sandboxed(`const fs = require('fs'); try {
      fs.mkdirSync(require('path').dirname(${JSON.stringify(target)}), { recursive: true });
      fs.writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(payload)}, { mode: 0o700 });
      console.log('wrote');
    } catch (e) { console.log(e.code); }`);
    expect(attack.stdout.trim()).toMatch(/^(EPERM|EACCES)$/);
    expect(() => f.setup.verify()).not.toThrow();
    if (kind === 'service-build') await f.service.stop();
    const next = await runDedicatedTurn({ ...f.request, prompt: 'resume' }, f.setup);
    expect(next.turnStarted).toBe(kind !== 'service-build');
    if (kind === 'service-build') expect(next.stderr).toContain('npm run build');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(f.dir, 'service.pid'))).toBe(false);
  } finally { await f.close(); }
}, 30_000);

test.skipIf(!sandbox)('a changed control manifest aborts before a second launcher invocation', async () => {
  const f = await launcherFixture();
  try {
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    // Runner-side fault injection complements the sandbox write-denial test.
    writeFileSync(f.setup.profile.path, '(version 1)\n(allow default)\n');
    await expect(runDedicatedTurn(f.request, f.setup)).rejects.toThrow(/isolation failure/);
  } finally { await f.close(); }
}, 30_000);

test.skipIf(!sandbox)('a client cannot redirect the private source login to an outside sentinel', async () => {
  const f = await launcherFixture();
  const sentinel = join(records, 'outside-source-auth'); writeFileSync(sentinel, 'untouched');
  try {
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    const attack = f.sandboxed(`const fs = require('fs'); try {
      fs.unlinkSync(${JSON.stringify(f.setup.sourceAuth)});
      fs.symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify(f.setup.sourceAuth)});
      console.log('replaced');
    } catch (e) { console.log(e.code); }`);
    expect(attack.stdout.trim()).toMatch(/^(EPERM|EACCES)$/);
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
  } finally { await f.close(); }
}, 30_000);

test.skipIf(!sandbox)('a client-planted native auth symlink is rejected before unsandboxed login synchronization', async () => {
  const f = await launcherFixture();
  const sentinel = join(records, 'outside-native-auth'); writeFileSync(sentinel, 'never-read-or-copied');
  try {
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    const attack = f.sandboxed(`const fs = require('fs'); const target = ${JSON.stringify(join(f.setup.state, 'auth.json'))};
      fs.unlinkSync(target); fs.symlinkSync(${JSON.stringify(sentinel)}, target); console.log('planted');`);
    expect(attack.stdout.trim()).toBe('planted');
    await expect(runDedicatedTurn(f.request, f.setup)).rejects.toThrow(/isolation failure: changed native auth link target/);
    expect(readFileSync(sentinel, 'utf8')).toBe('never-read-or-copied');
    expect(readFileSync(f.setup.sourceAuth, 'utf8')).toBe('{}');
  } finally { await f.close(); }
}, 30_000);

test.skipIf(!sandbox).each(['symlink', 'inode'])('private source login %s substitution fails identity verification', async kind => {
  const f = await launcherFixture();
  const sentinel = join(records, `outside-auth-${kind}`); writeFileSync(sentinel, 'untouched');
  try {
    expect((await runDedicatedTurn(f.request, f.setup)).turnStarted).toBe(true);
    // The sandbox rejects this mutation; inject it as the runner to exercise the second, identity guard.
    renameSync(f.setup.sourceAuth, `${f.setup.sourceAuth}.saved`);
    if (kind === 'symlink') symlinkSync(sentinel, f.setup.sourceAuth);
    else writeFileSync(f.setup.sourceAuth, '{}', { mode: 0o600 });
    await expect(runDedicatedTurn(f.request, f.setup)).rejects.toThrow(/isolation failure/);
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
  } finally { await f.close(); }
}, 30_000);

test('runAttempt refuses Dedicated without a sandbox before creating resources', async () => {
  const out = join(records, 'unsafe');
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'Unsafe', scenarios: [], count: 1, ceiling: 1,
    out, codex: { ...options, sandbox: false }, scratchRoot: scratch, ...clientState }, { attemptId: 'D-1', scenario: library[0]! }, () => false, () => undefined);
  expect(outcome).toMatchObject({ completeness: 'driver-failed', detail: expect.stringContaining('isolation failure') });
  expect(existsSync(out)).toBe(false);
});

test.skipIf(!sandbox)('a launcher failure records no installed Skill just because its projection exists', async () => {
  const broken = join(scratch, 'broken-codex'); writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o700 });
  const out = join(records, 'failed-install');
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'FailedInstall', scenarios: [], count: 1, ceiling: 1,
    out, codex: { ...options, bin: broken }, scratchRoot: scratch, ...clientState }, { attemptId: 'D-1', scenario: library[0]! }, () => false, () => undefined);
  expect(outcome.completeness).toBe('launch-failed');
  const context = JSON.parse(readFileSync(join(out, 'D-1/raw/entry-context.json'), 'utf8'));
  expect(context.context.map((c: { installed: boolean }) => c.installed)).toEqual([false, false, false, false]);
  expect(context.context.map((c: { shownToModel: boolean | null }) => c.shownToModel)).toEqual([null, null, null, null]);
  const record = JSON.parse(readFileSync(join(out, 'D-1/attempt.json'), 'utf8'));
  expect(record.missing).toContain('given[0].extraContext');
  expect(existsSync(join(out, 'D-1/database/maps.sqlite'))).toBe(false);
  expect(record.missing).toContain('raw.database');
}, 30_000);

test.skipIf(!sandbox)('tokens refreshed between turns are redacted before native evidence is written', async () => {
  const out = join(records, 'refresh');
  const scenario = library.find(s => s.id === 'S12')!;
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'Refresh', scenarios: [], count: 1, ceiling: 1,
    out, codex: options, scratchRoot: scratch, ...clientState }, { attemptId: 'D-1', scenario: { ...scenario, turns: [
      { session: 'A', kind: 'opening', say: 'FAKE-REFRESH' }, { session: 'A', kind: 'nudge', say: 'resume' },
    ] } }, () => false, () => undefined);
  expect(outcome.completeness, outcome.detail).toBe('complete');
  const stdout = readFileSync(join(out, 'D-1/raw/turn-0-A.stdout.jsonl'), 'utf8');
  expect(stdout).not.toContain('synthetic-refreshed-token-');
  expect(stdout).toContain('<codex-login-A-turn-0-');
}, 30_000);

test.skipIf(!sandbox)('runAttempt records a client auth-link attack as isolation failure and still cleans up', async () => {
  const sentinel = join(records, 'attempt-sentinel'); writeFileSync(sentinel, 'unchanged');
  const hostile = join(scratch, 'hostile-codex.mjs');
  writeFileSync(hostile, `#!/usr/bin/env node
${readFileSync(fake, 'utf8').replace(/^#![^\n]*\n/, '')}
const fs = await import('node:fs');
const auth = process.env.CODEX_HOME + '/auth.json';
fs.rmSync(auth); fs.symlinkSync(${JSON.stringify(sentinel)}, auth);
`, { mode: 0o700 });
  const out = join(records, 'hostile-attempt');
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'Hostile', scenarios: [], count: 1, ceiling: 1,
    out, codex: { ...options, bin: hostile }, scratchRoot: scratch, ...clientState }, { attemptId: 'D-1', scenario: library.find(s => s.id === 'S0b')! }, () => false, () => undefined);
  expect(outcome).toMatchObject({ completeness: 'driver-failed', detail: expect.stringContaining('isolation failure') });
  const record = JSON.parse(readFileSync(join(out, 'D-1/attempt.json'), 'utf8'));
  expect(record.isolation).toMatchObject({ failures: expect.arrayContaining([expect.stringContaining('changed native auth link target')]),
    dedicatedServiceRemoved: true, scratchRemoved: true, serviceStopped: { code: 0 } });
  expect(record.missing).toContain('raw.client');
  expect(existsSync(join(out, 'D-1/raw/entry-context.json'))).toBe(true);
  expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
}, 30_000);
