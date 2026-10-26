import { syntheticClientState } from './test-state.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { findRollout, prepareSession, runTurn, verifyProfile, writeProfile } from './codex.ts';
import { isolationSnapshot, personalConfigNamesRun } from './run.ts';
import { cleanupServiceDirectory } from './service.ts';
import { startRoute } from './relay.ts';

const root = realpathSync(mkdtempSync('/private/tmp/wf-behave-isolation-'));
const clientState = syntheticClientState(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const attack = test.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0);
const shell = (profile: string, command: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', command], { encoding: 'utf8' });

attack('a session cannot read or overwrite another native HOME, including its predecessor', () => {
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const a = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const b = prepareSession(scratch, 'B', 'synthetic', clientState.loginSource);
  const transcript = join(a.codexHome, 'rollout.jsonl');
  writeFileSync(transcript, 'original');
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const profile = writeProfile(control, b, work, '/bin/sh').path;
  expect(shell(profile, `cat '${transcript}'`).status).not.toBe(0);
  expect(shell(profile, `echo forged > '${transcript}'`).status).not.toBe(0);
  expect(shell(profile, `mkdir '${scratch}/home-A-turn-2'`).status).not.toBe(0);
  expect(readFileSync(transcript, 'utf8')).toBe('original');
  expect(b.home).not.toBe(a.home);
  const fresh = prepareSession(scratch, 'A-turn-2', 'synthetic', clientState.loginSource);
  expect(shell(writeProfile(control, fresh, work, '/bin/sh').path, `cat '${transcript}'`).status).not.toBe(0);
});

test('prepareSession refuses a HOME pre-created by an earlier process', () => {
  const scratch = mkdtempSync(join(root, 'precreated-'));
  mkdirSync(join(scratch, 'home-A-turn-2'));
  expect(() => prepareSession(scratch, 'A-turn-2', 'synthetic', clientState.loginSource)).toThrow();
});

attack('a client cannot replace the sandbox control file between turns', () => {
  const scratch = mkdtempSync(join(root, 'control-'));
  const session = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const profile = writeProfile(control, session, work, '/bin/sh').path;
  const original = readFileSync(profile, 'utf8');
  expect(shell(profile, `printf '(version 1) (allow default)' > '${profile}'`).status).not.toBe(0);
  expect(readFileSync(profile, 'utf8')).toBe(original);
  const other = join(scratch, 'other-session-secret'); writeFileSync(other, 'private');
  // A second sandbox-exec rereads the same control file: the attempted first-turn escape did not persist.
  expect(shell(profile, `cat '${other}'`).status).not.toBe(0);
  expect(shell(profile, `mv '${control}' '${control}-replaced'`).status).not.toBe(0);
});

test('personal configuration naming the new database directory is detected', () => {
  expect(personalConfigNamesRun('database=/Users/test/Library/Caches/wayfinder-behaviour-tests/attempt-1/db/maps.sqlite')).toBe(true);
});

test('the relay outage tells the client only a neutral gateway failure', async () => {
  const route = await startRoute(1, 'synthetic', () => undefined);
  try {
    route.cut();
    const response = await fetch(`http://127.0.0.1:${route.port}/mcp`, { method: 'POST', body: JSON.stringify({ method: 'tools/call' }) });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service Unavailable');
    const batch = await fetch(`http://127.0.0.1:${route.port}/mcp`, { method: 'POST', body: JSON.stringify([{ method: 'tools/call' }]) });
    expect(batch.status).toBe(503);
  } finally { await route.close(); }
});

// A trusted-process mutation simulates defense failure: the runner must still refuse the next launch.
test('a changed control hash prevents the next client launch', async () => {
  const scratch = mkdtempSync(join(root, 'hash-'));
  const session = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const profile = writeProfile(control, session, work, '/bin/echo');
  expect(verifyProfile(profile)).toBeNull();
  writeFileSync(profile.path, '(version 1) (allow default)');
  const result = await runTurn({ options: { model: 'fake', effort: 'low', bin: '/bin/echo', sandbox: true, timeoutMs: 1000 },
    session, port: 1, workdir: work, prompt: 'should never start', profile });
  expect(result.isolationFailure).toMatch(/control files changed/);
  expect(result.stdout).toBe('');
  expect(result.turnStarted).toBe(false);
});

attack('shared profile API allows read-only roots and appends root and literal write denies', () => {
  const scratch = mkdtempSync(join(root, 'api-'));
  const session = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const skill = join(work, 'skill'); mkdirSync(skill); writeFileSync(join(skill, 'SKILL.md'), 'fixed');
  const state = join(session.home, 'state'); mkdirSync(state);
  const denied = join(work, 'denied'); mkdirSync(denied);
  const alias = join(work, 'denied-alias'); symlinkSync(denied, alias);
  const stateAlias = join(work, 'state-alias'); symlinkSync(state, stateAlias);
  const profile = writeProfile(control, session, work, '/bin/sh', { readOnlyRoots: [skill], denyWriteRoots: [alias], denyWritePaths: [stateAlias] });
  expect(shell(profile.path, `cat '${skill}/SKILL.md'`).status).toBe(0);
  expect(shell(profile.path, `echo allowed > '${state}/log'`).status).toBe(0);
  expect(shell(profile.path, `mv '${state}' '${state}-moved'`).status).not.toBe(0);
  expect(shell(profile.path, `echo changed > '${skill}/SKILL.md'`).status).not.toBe(0);
  expect(shell(profile.path, `echo changed > '${denied}/file'`).status).not.toBe(0);
  writeFileSync(join(skill, 'SKILL.md'), 'changed by trusted test');
  expect(verifyProfile(profile)).toMatch(/changed/);
});

test('failed history export preserves the database but removes temporary credential configuration', () => {
  const dir = mkdtempSync(join(root, 'failed-export-'));
  mkdirSync(join(dir, 'db')); writeFileSync(join(dir, 'db/maps.sqlite'), 'history');
  writeFileSync(join(dir, 'credentials.json'), 'synthetic');
  const result = cleanupServiceDirectory(dir, false);
  expect(result.removed).toBe(false);
  expect(readFileSync(result.retained!, 'utf8')).toBe('history');
  expect(() => readFileSync(join(dir, 'credentials.json'))).toThrow();
  expect(cleanupServiceDirectory(dir, true).removed).toBe(true);
});

test('the runner never follows a symlinked native rollout into private evidence', () => {
  const scratch = mkdtempSync(join(root, 'rollout-'));
  const session = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  session.thread = 'fixed-thread';
  const sessions = join(session.codexHome, 'sessions'); mkdirSync(sessions);
  const privateFile = join(scratch, 'runner-evidence'); writeFileSync(privateFile, 'synthetic');
  symlinkSync(privateFile, join(sessions, 'rollout-fixed-thread.jsonl'));
  expect(findRollout(session)).toBeNull();
});

test('session preparation and Batch snapshots use synthetic login state without real credential access', () => {
  const scratch = mkdtempSync(join(root, 'login-source-'));
  const state = syntheticClientState(scratch);
  const session = prepareSession(scratch, 'A', 'synthetic', state.loginSource);
  expect(readFileSync(join(session.codexHome, 'auth.json'), 'utf8')).toBe(readFileSync(state.loginSource, 'utf8'));
  const snapshot = isolationSnapshot(state.personalConfigRoot);
  expect(Object.keys(snapshot.files).every(path => path.startsWith(state.personalConfigRoot))).toBe(true);
});

attack('a mutable read-only file permits trusted content refresh but no client write, sibling read or replacement', () => {
  const scratch = mkdtempSync(join(root, 'mutable-'));
  const session = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const source = join(scratch, 'source'); mkdirSync(source);
  const auth = join(source, 'auth.json'); writeFileSync(auth, 'synthetic-first');
  const sibling = join(source, 'private'); writeFileSync(sibling, 'synthetic-private');
  const profile = writeProfile(control, session, work, '/bin/sh', { mutableReadOnlyFiles: [auth] });
  expect(shell(profile.path, `cat '${auth}'`).stdout).toBe('synthetic-first');
  expect(shell(profile.path, `cat '${sibling}'`).status).not.toBe(0);
  expect(shell(profile.path, `echo forged > '${auth}'`).status).not.toBe(0);
  expect(shell(profile.path, `mv '${source}' '${source}-moved'`).status).not.toBe(0);
  writeFileSync(auth, 'synthetic-refreshed');
  expect(verifyProfile(profile)).toBeNull();
  expect(shell(profile.path, `cat '${auth}'`).stdout).toBe('synthetic-refreshed');
  renameSync(auth, auth + '-original'); writeFileSync(auth, 'synthetic-replacement');
  expect(verifyProfile(profile)).toMatch(/isolation failure/);
});

attack('mutable read-only entries reject directories and another session file through a symlink', () => {
  const scratch = mkdtempSync(join(root, 'mutable-refusal-'));
  const a = prepareSession(scratch, 'A', 'synthetic', clientState.loginSource);
  const b = prepareSession(scratch, 'B', 'synthetic', clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const other = join(b.home, 'token'); writeFileSync(other, 'synthetic');
  const alias = join(work, 'alias'); symlinkSync(other, alias);
  for (const file of [scratch, alias]) expect(() => writeProfile(control, a, work, '/bin/sh', { mutableReadOnlyFiles: [file] })).toThrow();
  expect(shell(writeProfile(control, a, work, '/bin/sh').path, `cat '${alias}'`).status).not.toBe(0);
});
