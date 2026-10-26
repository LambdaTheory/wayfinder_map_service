import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../evidence.ts';
import { abilities, assess } from './acceptance.ts';
import type { Assessment } from './acceptance.ts';
import { importAttempt, localFile, main } from './cli.ts';
import { launcher } from './host.ts';
import { normalizeNative } from './native.ts';
import type { InteractiveClient } from './native.ts';

const fixtures = fileURLToPath(new URL('../fixtures/interactive/', import.meta.url));
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'b09b-fixture-')); dirs.push(dir); return dir; }
function fixture(client: InteractiveClient, kind = 'supported') {
  const assessment = JSON.parse(read(`${client}-assessment.json`)) as Assessment;
  const native = normalizeNative(client, read(`${client}-${kind}.jsonl`), `${client}-${kind}.jsonl`, `synthetic-${client}-credential`);
  const record = { ...JSON.parse(read(`${client}-capture.json`)), events: native.events, sessions: [native.session],
    client: { version: native.version, surface: { known: true, value: 'interactive-cli' } }, missing: native.missing } as AttemptRecord;
  const probes = new Set([assessment.confirmations['async-question'].probe!.sha256]);
  return { assessment, record, probes, native };
}
const outcomes = (value: ReturnType<typeof assess>) => value.verdicts.map(v => v.verdict.outcome);

for (const client of ['codex', 'claude'] as const) describe(client, () => {
  it('imports intermediate messages, completed work, input and explicit native turns', () => {
    const { native } = fixture(client);
    expect(native.session.turns).toHaveLength(1);
    expect(native.events.map(e => e.turn)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(native.locations[2]).toMatch(/supported.jsonl:\d+$/);
    expect(native.events[2]).toMatchObject({ kind: 'tool-call', result: { known: true }, at: '2026-01-01T02:00:06.000Z' });
  });
  it('passes all four only after substantive native evidence and content review', () => {
    const { record, assessment, probes } = fixture(client);
    expect(outcomes(assess(record, assessment, probes))).toEqual(abilities.map(() => 'pass'));
    assessment.reviews = [];
    expect(outcomes(assess(record, assessment, probes))).toEqual(abilities.map(() => 'insufficient-evidence'));
  });
  it.each(abilities)('%s: missing evidence and negative content cannot pass', ability => {
    const { record, assessment, probes } = fixture(client);
    record.events = record.events.filter(e => e.seq !== assessment.selection.answer);
    expect(assess(record, assessment, probes).verdicts.find(v => v.ability === ability)?.verdict.outcome).toBe('insufficient-evidence');
    const complete = fixture(client);
    complete.assessment.reviews.filter(r => r.itemId === `${ability}.content`).forEach(r => { r.status = 'violated'; });
    expect(assess(complete.record, complete.assessment, complete.probes).verdicts.find(v => v.ability === ability)?.verdict.outcome).toBe('fail');
  });
  it.each(abilities)('%s: unsupported is not applicable, with its own coverage gap', ability => {
    const { record, assessment, probes } = fixture(client);
    assessment.confirmations[ability].status = 'unsupported';
    const verdict = assess(record, assessment, probes).verdicts.find(v => v.ability === ability)!.verdict;
    expect(verdict.outcome).toBe('not-applicable'); expect(verdict.gaps[0]).toContain(ability);
    assessment.confirmations[ability].status = 'unverified';
    expect(assess(record, assessment, probes).verdicts.find(v => v.ability === ability)!.verdict.outcome).toBe('insufficient-evidence');
  });
  it('rejects confirmation made after evidence, for a different version/surface, or without retained probe', () => {
    for (const change of ['time', 'version', 'surface', 'probe']) {
      const { record, assessment, probes } = fixture(client);
      for (const c of Object.values(assessment.confirmations)) {
        if (change === 'time') c.checkedAt = record.run.endedAt;
        if (change === 'version') c.clientVersion = 'different';
        if (change === 'surface') c.surface = 'headless';
        if (change === 'probe') delete c.probe;
      }
      expect(outcomes(assess(record, assessment, probes))).toEqual(abilities.map(() => 'insufficient-evidence'));
    }
  });
  it.each(['faster-only', 'delegation-only'])('%s is never success by itself', kind => {
    const { record, assessment, probes } = fixture(client, kind);
    assessment.reviews = [];
    expect(outcomes(assess(record, assessment, probes))).not.toContain('pass');
    if (kind === 'delegation-only') {
      // Even positive content reviews cannot replace the absent completed preparation.
      assessment.reviews = fixture(client).assessment.reviews;
      expect(outcomes(assess(record, assessment, probes)).slice(0, 2)).toEqual(['insufficient-evidence', 'insufficient-evidence']);
    }
  });
  it('allows W1 continuation in the answer turn but rejects needing another turn or nudge', () => {
    const { record, assessment, probes } = fixture(client, 'faster-only');
    assessment.selection = { question: 1, answer: 2, revisedRecommendation: 3, continuation: 4 };
    expect(assess(record, assessment, probes).verdicts[3]!.verdict.outcome).toBe('pass');
    record.events.at(-1)!.turn = 2;
    expect(assess(record, assessment, probes).verdicts[3]!.verdict.outcome).toBe('fail');
  });
  it('keeps malformed, compacted and truncated records unknown', () => {
    const { record, assessment, probes } = fixture(client);
    for (const text of [read(`${client}-supported.jsonl`) + '{broken\n', read(`${client}-supported.jsonl`).split('\n').slice(0, -2).join('\n')]) {
      const native = normalizeNative(client, text, 'partial.jsonl', 'fake');
      expect(outcomes(assess({ ...record, events: native.events, missing: native.missing }, assessment, probes))).not.toContain('pass');
    }
  });
  it('preserves incomplete run outcome separately from observed temporal violation', () => {
    const { record, assessment, probes } = fixture(client);
    record.run.completeness = 'timeout';
    expect(outcomes(assess(record, assessment, probes))).toEqual(abilities.map(() => 'incomplete'));
  });
  it('imports offline with hashes and writes fresh B01 artifacts; never overwrites', () => {
    const dir = temporary(); cpSync(fixtures, dir, { recursive: true });
    writeFileSync(join(dir, 'capture.json'), read(`${client}-capture.json`));
    const assessment = JSON.parse(read(`${client}-assessment.json`)) as Assessment;
    const imported = importAttempt(dir, `${client}-supported.jsonl`, assessment);
    expect(outcomes(imported)).toEqual(abilities.map(() => 'pass'));
    main([dir, `${client}-supported.jsonl`, `${client}-assessment.json`, join(dir, 'judged')]);
    const record = JSON.parse(readFileSync(join(dir, 'judged/async-question.attempt.json'), 'utf8')) as AttemptRecord;
    expect(record.subject.id).toBe('B09Async'); expect(record.events).toHaveLength(6);
    expect(() => main([dir, `${client}-supported.jsonl`, `${client}-assessment.json`, join(dir, 'judged')])).toThrow();
    assessment.confirmations['async-question'].probe!.sha256 = createHash('sha256').update('wrong').digest('hex');
    expect(() => importAttempt(dir, `${client}-supported.jsonl`, assessment)).toThrow('hash mismatch');
    expect(() => localFile(dir, '../elsewhere')).toThrow();
  });
});

it('a tool started before the answer but completed afterwards is not preparation while waiting', () => {
  const f = fixture('codex');
  const text = read('codex-supported.jsonl').split('\n');
  const output = text.splice(6, 1)[0]!;
  const row = JSON.parse(output); row.timestamp = '2026-01-01T02:00:07.500Z';
  text.splice(7, 0, JSON.stringify(row));
  const native = normalizeNative('codex', text.join('\n'), 'late.jsonl', 'fake');
  const prep = native.events.find(e => e.kind === 'tool-call')!;
  const answer = native.events.find(e => e.kind === 'message' && e.role === 'user' && e.text.startsWith('Yes'))!;
  f.assessment.selection.preparation = prep.seq; f.assessment.selection.answer = answer.seq;
  const result = assess({ ...f.record, events: native.events, missing: native.missing }, f.assessment, f.probes);
  expect(outcomes(result).slice(0, 2)).not.toContain('pass');
});

it('manual launchers isolate HOME/configuration, use their own credential and contain no model execution until invoked', () => {
  for (const client of ['codex', 'claude'] as const) {
    const dir = temporary();
    const script = launcher(dir, client, process.execPath, 23456, 'synthetic-token', 'synthetic-model', 'high');
    expect(script).toContain('env -i'); expect(script).toContain('/usr/bin/sandbox-exec');
    expect(script).toContain(`HOME=${dir}/home`); expect(script).toContain('WAYFINDER_TOKEN=synthetic-token');
    expect(script).not.toContain('18766/mcp');
    expect(script).toContain(client === 'codex' ? '--ignore-user-config' : '--strict-mcp-config');
    expect(readFileSync(join(dir, 'sandbox.sb'), 'utf8')).toContain('localhost:18766');
  }
});

it('the manual host seeds and stops only a fresh cached service without executing a client', async () => {
  const { spawn } = await import('node:child_process');
  const { cacheRoot } = await import('./host.ts');
  const attempt = `fixture-${process.pid}-${Date.now()}`;
  const dir = join(cacheRoot(), `B09Fixture-${attempt}`); dirs.push(dir);
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./host.ts', import.meta.url)), 'B09Fixture', attempt,
      'codex', 'synthetic-model', 'high', 'W7', process.execPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let answered = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(output)); }, 20_000);
    child.stdout.on('data', data => { output += data; if (!answered && output.includes('Client exited; enter')) { answered = true; child.stdin.write('complete\n'); } });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(result, result.output).toMatchObject({ code: 0 });
  const isolation = JSON.parse(readFileSync(join(dir, 'isolation.json'), 'utf8'));
  expect(isolation).toMatchObject({ serviceStopped: true, scratchRemoved: true, credentialsRemoved: true });
  expect([18765, 18766]).not.toContain(isolation.port);
  expect(isolation.database).toContain(`${dir}/db/`);
  const capture = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')) as AttemptRecord;
  expect(capture.maps).toHaveLength(1); expect(capture.missing).toContain('events');
}, 30_000);

it('all-unsupported preflight produces four gaps without opening any native file', () => {
  const f = fixture('codex'); const dir = temporary();
  f.assessment.confirmations['async-question'].status = 'unsupported';
  for (const c of Object.values(f.assessment.confirmations)) { c.status = 'unsupported'; delete c.probe; }
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(f.record));
  const result = importAttempt(dir, '-', f.assessment);
  expect(outcomes(result)).toEqual(abilities.map(() => 'not-applicable'));
  expect(result.verdicts.every(v => v.verdict.gaps.length === 1)).toBe(true);
  f.assessment.confirmations['continue-same-turn'].status = 'unverified';
  expect(() => importAttempt(dir, '-', f.assessment)).toThrow('unless every capability is unsupported');
});

it('a different verdict version cannot silently re-judge earlier evidence', () => {
  const f = fixture('codex'); f.assessment.verdictVersion = 2;
  expect(outcomes(assess(f.record, f.assessment, f.probes))).toEqual(abilities.map(() => 'insufficient-evidence'));
});

it('a missing or unrecognized write result stays unknown, not a non-write', () => {
  const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-01-01T02:00:00Z', type, payload });
  const text = [row('session_meta', { id: 'synthetic' }), row('event_msg', { type: 'task_started', turn_id: 'one' }),
    row('response_item', { type: 'function_call', call_id: 'write', name: 'mcp__wayfinder__map_apply', arguments: '{}' }),
    row('response_item', { type: 'function_call_output', call_id: 'write', output: 'unrecognized output' }),
    row('event_msg', { type: 'task_complete', turn_id: 'one' })].join('\n');
  const native = normalizeNative('codex', text, 'unknown-write.jsonl', 'fake');
  expect(native.events[0]).toMatchObject({ kind: 'tool-call', result: { known: false } });
});

it('invalid support values and missing capture times cannot bypass the capability precondition', () => {
  const f = fixture('codex');
  for (const c of Object.values(f.assessment.confirmations)) Object.assign(c, { status: 'typo', probe: undefined });
  expect(outcomes(assess(f.record, f.assessment, f.probes))).not.toContain('pass');
  const valid = fixture('codex'); valid.record.run.startedAt = 'unknown';
  expect(outcomes(assess(valid.record, valid.assessment, valid.probes))).not.toContain('pass');
});
