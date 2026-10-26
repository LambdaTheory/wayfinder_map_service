// Model-free onboarding evidence for the Dedicated Entry; real-model onboarding still needs an approved Batch.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { clientProfiles } from '../clients.ts';
import type { AttemptRecord } from '../evidence.ts';
import { library } from '../library.ts';
import { prepareSession, writeProfile } from './codex.ts';
import { captureDedicatedArtifacts, dedicatedLauncher, dedicatedServiceDirectory, prepareDedicated } from './dedicated.ts';
import { isolationSnapshot, preflight, runAttempt, runBatch } from './run.ts';
import { newToken, startService } from './service.ts';

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
const options = { model: 'fake-model', effort: 'low', bin: fake, sandbox, timeoutMs: 60_000, authFile: auth };
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }); });

test('Dedicated planning is explicit, and synthetic evidence does not onboard the Entry', () => {
  expect(preflight({ entry: 'dedicated', batchId: 'D', scenarios: ['S0b', 'F11'], count: 2, ceiling: 4 }).refusals).toEqual([]);
  expect(clientProfiles.codex.onboarded).not.toContain('dedicated');
});

test.skipIf(!sandbox)('real launcher runs and resumes inside the allowlist, records its context and never reaches everyday state', async () => {
  const before = isolationSnapshot();
  const out = join(records, 'run');
  const scenario = library.find(s => s.id === 'S0b')!;
  const outcome = await runAttempt({ entry: 'dedicated', batchId: 'DedicatedFake', scenarios: [], count: 1, ceiling: 1, out,
    codex: options, scratchRoot: scratch }, { attemptId: 'S0b-1', scenario: { ...scenario, seed: { ...scenario.seed, fixtures: ['ask-card'] } } }, () => false, () => undefined);
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
  expect(context.context.slice(0, 2).map((c: { shownToModel: boolean }) => c.shownToModel)).toEqual([true, true]);
  expect(record.given[0]!.extraContext.join()).toContain('.agents/skills/wayfinder/SKILL.md');
  const first = context.launches[0]; const second = context.launches[1];
  expect(first.argv).not.toContain('--ignore-user-config');
  expect(first.argv).toContain('--no-daemon');
  expect(second.argv.slice(-2)).toEqual([record.sessions[0]!.nativeId.known ? record.sessions[0]!.nativeId.value : '', '-']);
  expect(first.overrides.WAYFINDER_AGENT_STATE_ROOT).toContain('/wf-behave-S0b-1-');
  expect(first.overrides.WAYFINDER_AGENT_DATABASE).toMatch(/^~\/Library\/Caches\/wayfinder-behaviour-tests\/dedicated-[^/]+\/db\/maps.sqlite$/);
  expect(first.overrides.WAYFINDER_AGENT_SERVICE_DIR).toBe(first.overrides.WAYFINDER_AGENT_DATABASE.replace('/db/maps.sqlite', ''));
  expect(first.overrides.WAYFINDER_AGENT_OUTPUTS).toContain('/wf-behave-S0b-1-');
  expect(['18765', '18766']).not.toContain(first.overrides.WAYFINDER_AGENT_PORT);
  expect(first.argv.join(' ')).toContain(`http://127.0.0.1:${first.overrides.WAYFINDER_AGENT_PORT}/mcp`);
  expect(first.argv.join(' ')).not.toMatch(/:(18765|18766)\//);
  const probe = JSON.parse(readFileSync(join(path, 'raw/work/entry-probe.json'), 'utf8'));
  expect(probe.bootstrapKeys).toEqual([]);
  expect(probe.resumed).toBe(true);
  expect(readFileSync(join(path, 'raw/work/fake-note.txt'), 'utf8')).toBe('note\n');
  expect(existsSync(join(path, 'raw/work/src/ask-card.js'))).toBe(true);
  const commands = record.events.filter(e => e.kind === 'command');
  expect(commands.map(e => e.kind === 'command' && e.exitCode)).toEqual([0, 1, 0, 0, 1, 0]);
  expect(isolationSnapshot()).toEqual(before);
}, 60_000);

test.skipIf(!sandbox)('Dedicated Batch metadata, ceilings and directory refusal preserve the Entry', async () => {
  const out = join(records, 'batch');
  const batch = { entry: 'dedicated' as const, batchId: 'DedicatedBatch', scenarios: ['S0b'], count: 2, ceiling: 1,
    out, codex: options, scratchRoot: scratch };
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
    out, codex: { ...options, timeoutMs: 1_500 }, scratchRoot: scratch },
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
    const session = prepareSession(own, 'A', newToken(), auth);
    const setup = prepareDedicated(own, session, service, controller, options, writeProfile(own, fake));
    await service.stop();
    const result = spawnSync(dedicatedLauncher, ['--harness', 'codex', '--method', 'mcp', '--', 'exec', '--json', '-'],
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
  symlinkSync(auth, join(source, 'auth-link'));
  captureDedicatedArtifacts(source, target, { credential: token });
  expect(readFileSync(join(target, 'binary'))).toEqual(Buffer.concat([Buffer.from([0, 255]), Buffer.from('<credential>'), Buffer.from([128, 0])]));
  expect(existsSync(join(target, 'auth-link'))).toBe(false);
});
