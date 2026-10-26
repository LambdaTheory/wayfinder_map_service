import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { prepareSession, runTurn, verifyProfile, writeProfile } from './codex.ts';
import { cleanupServiceDirectory, personalConfigNamesRun } from './run.ts';
import { startRoute } from './relay.ts';
import { callFailed } from '../checks.ts';
import type { AttemptRecord, EventRecord } from '../evidence.ts';

const root = realpathSync(mkdtempSync('/private/tmp/wf-behave-isolation-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const shell = (profile: string, command: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', command], { encoding: 'utf8' });

test('a session cannot read or overwrite another native HOME, including its predecessor', () => {
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const a = prepareSession(scratch, 'A', 'synthetic');
  const b = prepareSession(scratch, 'B', 'synthetic');
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
});

test('prepareSession refuses a HOME pre-created by an earlier process', () => {
  const scratch = mkdtempSync(join(root, 'precreated-'));
  mkdirSync(join(scratch, 'home-A-turn-2'));
  expect(() => prepareSession(scratch, 'A-turn-2', 'synthetic')).toThrow();
});

test('a client cannot replace the sandbox control file between turns', () => {
  const scratch = mkdtempSync(join(root, 'control-'));
  const session = prepareSession(scratch, 'A', 'synthetic');
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
  const route = await startRoute(1, () => undefined);
  try {
    route.cut();
    const response = await fetch(`http://127.0.0.1:${route.port}/mcp`, { method: 'POST', body: JSON.stringify({ method: 'tools/call' }) });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service Unavailable');
  } finally { await route.close(); }
});

test('a structured service error is not evidence that the relay prevented arrival', () => {
  const event: EventRecord = { seq: 0, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'tool-call', callId: 'A:1:0',
    server: 'wayfinder', tool: 'map_read', arguments: {}, failed: true, result: { known: true, value: { kind: 'infrastructure_error' } }, requestId: { known: false, reason: 'unreported' } };
  expect(callFailed('route cut', { turn: 1 })({ events: [event], missing: [] } as unknown as AttemptRecord).status).toBe('violated');
});

// A trusted-process mutation simulates defense failure: the runner must still refuse the next launch.
test('a changed control hash prevents the next client launch', async () => {
  const scratch = mkdtempSync(join(root, 'hash-'));
  const session = prepareSession(scratch, 'A', 'synthetic');
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

test('shared profile API allows read-only roots and appends root and literal write denies', () => {
  const scratch = mkdtempSync(join(root, 'api-'));
  const session = prepareSession(scratch, 'A', 'synthetic');
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'runner-'));
  const skill = join(work, 'skill'); mkdirSync(skill); writeFileSync(join(skill, 'SKILL.md'), 'fixed');
  const state = join(session.home, 'state'); mkdirSync(state);
  const denied = join(work, 'denied'); mkdirSync(denied);
  const profile = writeProfile(control, session, work, '/bin/sh', { readOnlyRoots: [skill], denyWriteRoots: [denied], denyWritePaths: [state] });
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
