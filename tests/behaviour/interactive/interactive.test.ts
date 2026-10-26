import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../evidence.ts';
import { abilities, assess as assessAttempt } from './acceptance.ts';
import { reviewInput, verifyReviews } from './reviews.ts';
import type { ReviewArtifact } from './reviews.ts';
import type { Assessment } from './acceptance.ts';
import { importAttempt, localFile, main } from './cli.ts';
import { launcher as createLauncher } from './host.ts';
import type { LaunchOptions } from './host.ts';
import { readManifest } from './launch.ts';
import { normalizeNative } from './native.ts';
import type { InteractiveClient } from './native.ts';

const fixtures = fileURLToPath(new URL('../fixtures/interactive/', import.meta.url));
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'b09b-fixture-')); dirs.push(dir); return dir; }
function subscription() { const dir = temporary(); mkdirSync(join(dir, '.codex')); writeFileSync(join(dir, '.codex/auth.json'), 'synthetic-login'); return dir; }
function launcher(options: LaunchOptions) { const prepared = createLauncher(options); dirs.push(prepared.controlDir); return { ...prepared, manifest: readManifest(prepared.manifestPath, prepared.manifestHash) }; }
function fixture(client: InteractiveClient, kind = 'supported') {
  const assessment = JSON.parse(read(`${client}-assessment.json`)) as Assessment;
  assessment.reviews = abilities.flatMap(a => [1, 2].map(i => ({ itemId: `${a}.content`, role: 'review' as const, by: `synthetic-reader-${i}`, status: 'holds' as const, reason: 'Synthetic review for a unit test.' })));
  const native = normalizeNative(client, read(`${client}-${kind}.jsonl`), `${client}-${kind}.jsonl`, `synthetic-${client}-credential`);
  let record = { ...JSON.parse(read(`${client}-capture.json`)), combination: { harness: client, requestedModel: 'synthetic-model', visibleModel: native.model, effort: native.effort }, events: native.events, sessions: [native.session],
    client: { version: native.version, surface: { known: true, value: 'interactive-cli' } }, missing: native.missing } as AttemptRecord;
  // Judge unit tests explicitly assume confirmed support. This B01 fixture is not native-adapter evidence.
  if (client === 'claude') {
    assessment.confirmations['async-question'].status = 'supported';
  }
  if (kind === 'supported') record = JSON.parse(read(`${client}-same-turn-unit.json`)) as AttemptRecord;
  const probes = new Set([assessment.confirmations['async-question'].probe!.sha256]);
  return { assessment, record, probes, native };
}
// Synthetic reviewers are built in tests, never shipped as copyable approved assessments.
function artifactsFor(record: AttemptRecord, assessment: Assessment): ReviewArtifact[] {
  return assessment.reviews.map((r, i) => {
    const ability = abilities.find(a => r.itemId === `${a}.content`);
    if (!ability || r.role === 'human') throw new Error('untrusted override');
    const names = ability === 'async-question' ? ['question', 'preparation', 'answer'] : ability === 'prepare-while-waiting'
      ? ['question', 'preparation', 'answer', 'revisedRecommendation'] : ability === 'adjust-recommendation' ? ['question', 'answer', 'revisedRecommendation'] : ['question', 'answer', 'continuation'];
    const evidence = [...new Set([...names, 'preparation', 'revisedRecommendation'])].flatMap(n => { const seq = assessment.selection[n as keyof Assessment['selection']]; const e = record.events.find(e => e.seq === seq);
      return e ? [{ seq: e.seq, explanation: `This synthetic observation supports ${ability}.`, quote: e.kind === 'message' ? e.text.slice(0, 20) : e.kind === 'tool-call' && e.result.known ? (typeof e.result.value === 'string' ? e.result.value : JSON.stringify(e.result.value)).slice(0, 20) : e.kind }] : []; });
    return { ability, role: r.role, reviewer: r.by, sessionId: r.by, vendor: record.combination.harness === 'claude' ? 'openai' : 'anthropic',
      model: record.combination.harness === 'claude' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', input: reviewInput(record, assessment),
      output: JSON.stringify({ status: r.status, reason: `${r.reason} Independent synthetic reading ${i}.`, evidence }) };
  });
}
function assess(record: AttemptRecord, assessment: Assessment, probes: Set<string>) {
  try { return assessAttempt(record, assessment, probes, verifyReviews(record, assessment, artifactsFor(record, assessment))); }
  catch { return assessAttempt(record, assessment, probes); }
}
const outcomes = (value: ReturnType<typeof assess>) => value.verdicts.map(v => v.verdict.outcome);

for (const client of ['codex', 'claude'] as const) describe(client, () => {
  it('imports intermediate messages, completed work, input and explicit native turns', () => {
    const { native } = fixture(client);
    expect(native.session.turns).toHaveLength(client === 'codex' ? 1 : 2);
    expect(native.events.map(e => e.turn)).toEqual(client === 'codex' ? [0, 0, 0, 0, 0, 0] : [0, 0, 0, 1, 1, 1]);
    expect(native.locations[2]).toMatch(/supported.jsonl:\d+$/);
    expect(native.events[2]).toMatchObject({ kind: 'tool-call', result: { known: true }, at: '2026-01-01T02:00:06.000Z' });
  });
  it('passes all four only with explicit B01 evidence and content review', () => {
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
    const { record, assessment, probes } = fixture(client);
    record.events.filter(e => e.seq >= assessment.selection.answer!).forEach(e => { e.turn = 1; });
    record.sessions[0]!.turns.push({ index: 1, input: 'Synthetic contrary answer', startedAt: '2026-01-01T02:00:07.000Z', endedAt: '2026-01-01T02:00:09.000Z', durationMs: 2000 });
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
    expect(outcomes(imported)).toEqual(abilities.map(() => 'insufficient-evidence'));
    main([dir, `${client}-supported.jsonl`, `${client}-assessment.json`, join(dir, 'judged')]);
    const record = JSON.parse(readFileSync(join(dir, 'judged/async-question.attempt.json'), 'utf8')) as AttemptRecord;
    expect(record.subject.id).toBe('B09Async'); expect(record.events).toHaveLength(6);
    expect(() => main([dir, `${client}-supported.jsonl`, `${client}-assessment.json`, join(dir, 'judged')])).toThrow();
    assessment.confirmations['prepare-while-waiting'].probe!.sha256 = createHash('sha256').update('wrong').digest('hex');
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
    const script = launcher({ scratch: dir, client, bin: process.execPath, port: 23456, model: 'synthetic-model', effort: 'high', subscriptionHome: subscription() });
    expect(script.manifest.env.HOME).toBe(`${realpathSync(dir)}/home`);
    expect(script.manifest.env).not.toHaveProperty('WAYFINDER_TOKEN');
    expect(script.command).toContain(script.manifestHash);
    expect(JSON.stringify(script.manifest)).not.toContain('18766/mcp');
    expect(script.manifest.args).toContain(client === 'codex' ? '--no-daemon' : '--strict-mcp-config');
    expect(readFileSync(script.profile.path, 'utf8')).toContain('localhost:18766');
  }
});

it.each(['', 'refresh', 'failure', 'cancel', 'no-open-files', 'claude-proxy', 'codex-settings', 'codex-malformed-settings', 'codex-terminal', 'claude-settings', 'claude-terminal', 'native-link', 'control-tamper', 'exit-nonzero', 'exit-signal', 'launch-failure', 'no-start', 'exit-without-start', 'missing-exit', 'no-start-precondition-not-met', 'no-start-rate-limited', 'no-start-timeout', 'no-start-cancelled', 'repeat-launch', 'duplicate-start', 'reported-precondition-not-met', 'reported-rate-limited', 'reported-timeout', 'reported-cancelled'])('the manual host stops only its own service and preserves subscription state (%s)', async mode => {
  const { spawn } = await import('node:child_process');
  const { cacheRoot } = await import('./host.ts');
  const attempt = `fixture-${process.pid}-${Date.now()}`;
  const dir = join(cacheRoot(), `B09Fixture-${attempt}`); dirs.push(dir);
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/interactive/fake-host.mjs', import.meta.url)), 'B09Fixture', attempt,
      (mode.startsWith('claude-') || mode === 'launch-failure') ? 'claude' : 'codex', 'synthetic-model', 'high', 'W7', process.execPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, B09_SYNTHETIC_REFRESH: mode } });
    let output = ''; let answered = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(output)); }, 20_000);
    child.stdout.on('data', data => { output += data; if (!answered && output.includes('Client exited; enter')) { answered = true; if (mode === 'cancel') child.stdin.end(); else child.stdin.write((mode.startsWith('no-start-') ? mode.slice('no-start-'.length) : mode.startsWith('reported-') ? mode.slice('reported-'.length) : 'complete') + '\n'); } });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(result, result.output).toMatchObject({ code: ['failure', 'cancel'].includes(mode) ? 1 : 0 });
  const isolation = JSON.parse(readFileSync(join(dir, 'isolation.json'), 'utf8'));
  expect(isolation).toMatchObject({ serviceStopped: { known: true }, scratchRemoved: !['failure', 'cancel'].includes(mode), credentialsRemoved: true });
  expect(isolation.codexLoginSync.status).toBe((mode.startsWith('claude-') || mode === 'launch-failure') ? 'not-applicable' : mode === 'cancel' ? 'deferred' : mode === 'failure' ? 'failed' : mode === 'refresh' ? 'synced' : 'linked');
  if (mode === 'failure' || mode === 'cancel') {
    const retained = isolation.codexLoginSync.retainedScratch; dirs.push(retained, isolation.retainedControlDirectory);
    expect(readFileSync(join(retained, 'home/.codex/auth.json'), 'utf8')).toBe('synthetic-refreshed-login');
  }
  expect(isolation.controlIntegrity).toEqual({ known: true, value: mode !== 'control-tamper' });
  expect(isolation.controlDirectoryRemoved).toBe(!['failure', 'cancel'].includes(mode));
  expect(isolation.measurements).toHaveProperty('before');
  expect(isolation.measurements).toHaveProperty('after');
  const opened = isolation.measurements.servedOwnDatabase;
  if (mode === 'no-open-files') expect(opened.known).toBe(false);
  // lsof visibility is environment-dependent. An observation must match; absence must remain unknown.
  expect(opened).toEqual(opened.known ? { known: true, value: true }
    : { known: false, reason: 'own service open database not observed' });
  expect(isolation).not.toHaveProperty('scope');
  expect([18765, 18766]).not.toContain(isolation.port);
  expect(isolation.database).toContain(`/B09Fixture-${attempt}/db/`);
  const capture = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')) as AttemptRecord;
  expect(capture.maps).toHaveLength(1);
  if (['native-link', 'control-tamper', 'missing-exit', 'duplicate-start'].includes(mode)) expect(capture.run.completeness).toBe('driver-failed');
  if (mode === 'native-link') expect(capture.raw.files).toEqual(['raw/launch.jsonl']);
  if (mode.startsWith('no-start') || ['launch-failure', 'exit-without-start'].includes(mode)) expect(capture.run.completeness).toBe('launch-failed');
  if (mode.startsWith('reported-')) expect(capture.run.completeness).toBe(mode.slice('reported-'.length));
  if (['exit-nonzero', 'exit-signal', 'repeat-launch'].includes(mode)) expect(capture.run.completeness).toBe('complete');
  if (!mode.startsWith('no-start')) {
    expect(capture.raw.files).toContain('raw/launch.jsonl');
    const log = readFileSync(join(dir, 'raw/launch.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (mode === 'launch-failure') expect(log.at(-1)).toMatchObject({ phase: 'refused', launched: false, launchFailure: 'client launch failed' });
    else {
      if (mode !== 'exit-without-start') expect(log[0]).toMatchObject({ phase: 'started', launched: true });
      if (mode === 'repeat-launch') expect(log.at(-1)).toMatchObject({ phase: 'refused', launched: false, duplicateLaunch: true });
      if (mode !== 'missing-exit') expect(log.find(row => row.phase === 'exited')).toMatchObject({ phase: 'exited', code: mode === 'exit-signal' ? null : mode === 'exit-nonzero' ? 7 : 0,
        signal: mode === 'exit-signal' ? 'SIGTERM' : null });
    }
  }
  if (mode === 'claude-proxy') {
    const native = readFileSync(join(dir, 'raw/native-0.jsonl'), 'utf8');
    expect(native).toContain('http://127.0.0.1:23456/mcp'); expect(native).toContain('http://localhost:23456/mcp');
    expect(native).not.toContain('synthetic-password'); expect(native).not.toContain('synthetic-user'); expect(native).toContain('<proxy-HTTPS_PROXY');
  } else expect(capture.missing).toContain('events');
}, 30_000);

it('all-unsupported preflight produces four gaps without opening any native file', () => {
  const f = fixture('codex'); const dir = temporary();
  f.assessment.confirmations['async-question'].status = 'unsupported';
  for (const c of Object.values(f.assessment.confirmations)) { c.status = 'unsupported'; delete c.probe; }
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(f.record));
  f.assessment.reviews = [];
  const result = importAttempt(dir, '-', f.assessment);
  expect(outcomes(result)).toEqual(abilities.map(() => 'not-applicable'));
  expect(result.verdicts.every(v => v.verdict.gaps.length === 1)).toBe(true);
  f.assessment.confirmations['continue-same-turn'].status = 'unverified';
  expect(() => importAttempt(dir, '-', f.assessment)).toThrow('unless every capability is unsupported');
});

it('a different verdict version cannot silently re-judge earlier evidence', () => {
  const f = fixture('codex'); f.assessment.verdictVersion = 1;
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

it('uses subscription authentication and clears API-key billing routes', () => {
  const dir = temporary();
  const codex = launcher({ scratch: dir, client: 'codex', bin: process.execPath, port: 23456, model: 'synthetic-model', effort: 'high', subscriptionHome: subscription() });
  const claude = launcher({ scratch: temporary(), client: 'claude', bin: process.execPath, port: 23456, model: 'synthetic-model', effort: 'high', subscriptionHome: subscription() });
  for (const prepared of [codex, claude]) for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'WAYFINDER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(prepared.manifest.env).not.toHaveProperty(key);
  expect(claude.manifest.client).toBe('claude');
});

it('launches interactive Codex in its own process with supported flags', () => {
  const script = launcher({ scratch: temporary(), client: 'codex', bin: process.execPath, port: 23456, model: 'synthetic-model', effort: 'high', subscriptionHome: subscription() });
  expect(script.manifest.args).toContain('--no-daemon');
  expect(script.manifest.args).not.toContain('--ignore-user-config');
});

it.each(['Agent', 'Task', 'close_agent', 'send_input', 'exec_command'])('does not treat %s launch/control/wait as preparation', tool => {
  const f = fixture('codex'); const event = f.record.events[2]!;
  Object.assign(event, { tool, arguments: tool === 'exec_command' ? { command: 'sleep 30' } : {},
    result: { known: true, value: tool === 'exec_command' ? 'Exit code: 0' : 'Agent launched: fake-agent' } });
  expect(outcomes(assess(f.record, f.assessment, f.probes)).slice(0, 2)).not.toContain('pass');
});

it('asynchronous asking requires the answer before the native turn ends', () => {
  const f = fixture('codex');
  f.record.events.filter(e => e.seq >= f.assessment.selection.answer!).forEach(e => { e.turn = 1; });
  expect(assess(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).not.toBe('pass');
});

it.each(['request_user_input', 'AskUserQuestion'])('%s cannot prove a non-blocking question', tool => {
  const f = fixture('codex');
  Object.assign(f.record.events[1]!, { kind: 'tool-call', tool, actor: 'agent', arguments: { question: 'Mobile?' },
    result: { known: true, value: 'User has answered your questions: mobile only' }, failed: false });
  expect(assess(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).not.toBe('pass');
});

it('a rejected question tool supplies no human answer', () => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  rows.find(r => r.message?.content?.[0]?.type === 'tool_use').message.content = [{ type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: { questions: ['Mobile?'] } }];
  rows.find(r => r.message?.content?.[0]?.type === 'tool_result').message.content = [{ type: 'tool_result', tool_use_id: 'question-1', is_error: true, content: 'User rejected tool use' }];
  const native = normalizeNative('claude', rows.map(r => JSON.stringify(r)).join('\n'), 'rejected.jsonl', 'fake');
  expect(native.events.flatMap(e => e.kind === 'message' && e.role === 'user' ? [e.text] : [])).not.toContain('User rejected tool use');
});

it.each([false, true])('retains user text beside a Claude tool result, including a rejected result (%s)', rejected => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  const result = rows.find(r => r.message?.content?.[0]?.type === 'tool_result');
  result.message.content = [
    { type: 'tool_result', tool_use_id: 'tool-1', content: rejected ? 'User rejected tool use' : 'Synthetic completed read', is_error: rejected },
    ...(rejected ? [{ type: 'text', text: 'User rejected tool use' }] : []),
    { type: 'text', text: 'Keep going: ask me the next Frontier question now.' },
  ];
  const native = normalizeNative('claude', rows.map(r => JSON.stringify(r)).join('\n'), 'mixed.jsonl', 'fake');
  const human = native.events.filter(e => e.kind === 'message' && e.role === 'user');
  expect(human).toContainEqual(expect.objectContaining({ text: 'Keep going: ask me the next Frontier question now.', turn: null }));
  expect(human).not.toContainEqual(expect.objectContaining({ text: 'User rejected tool use' }));
  expect(native.missing.some(m => /^events\[\d+\]\.turn$/.test(m))).toBe(true);
});

it('does not discard additional user words after a rejection notice', () => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  const result = rows.find(r => r.message?.content?.[0]?.type === 'tool_result');
  const text = 'User rejected tool use\nKeep going: ask me the next Frontier question now.';
  result.message.content.push({ type: 'text', text });
  expect(normalizeNative('claude', rows.map(r => JSON.stringify(r)).join('\n'), 'mixed.jsonl', 'fake').events)
    .toContainEqual(expect.objectContaining({ kind: 'message', role: 'user', text }));
});

it.each([
  ['codex', false], ['claude', false], ['claude', true],
] as const)('%s preserves a proved nudge violation despite uncertain turns (mixed result: %s)', (client, mixed) => {
  const f = fixture(client);
  const rows = read(`${client}-supported.jsonl`).trim().split('\n').map(line => JSON.parse(line));
  const text = 'Keep going: ask me the next Frontier question now.';
  const index = rows.findIndex(r => JSON.stringify(r).includes('For task-entry'));
  const at = '2026-01-01T02:00:08.500Z';
  if (client === 'codex') rows.splice(index, 0, { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  else {
    const content: Record<string, unknown>[] = [{ type: 'text', text }];
    if (mixed) {
      rows.splice(index, 0, { ...rows[1], timestamp: '2026-01-01T02:00:08.250Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'extra-read', name: 'Read', input: { file_path: 'facts.txt' } }] } });
      content.unshift({ type: 'tool_result', tool_use_id: 'extra-read', content: 'Synthetic read result' });
    }
    rows.splice(index + Number(mixed), 0, { ...rows[1], timestamp: at, message: { role: 'user', content } });
  }
  const native = normalizeNative(client, rows.map(r => JSON.stringify(r)).join('\n'), 'nudge.jsonl', 'fake');
  const continuation = native.events.find(e => e.kind === 'message' && e.text.startsWith('For task-entry'))!;
  f.assessment.selection.continuation = continuation.seq;
  const record = { ...f.record, events: native.events, sessions: [native.session], missing: native.missing };
  expect(assessAttempt(record, f.assessment, f.probes).verdicts[3]!.verdict.outcome).toBe('fail');
  record.missing.push('native.boundaries');
  expect(assessAttempt(record, f.assessment, f.probes).verdicts[3]!.verdict.outcome).toBe('fail');
  // Corrupted event order cannot prove a nudge, unlike an unknown turn boundary.
  record.missing.push('native.integrity');
  expect(assessAttempt(record, f.assessment, f.probes).verdicts[3]!.verdict.outcome).toBe('insufficient-evidence');
});

it.each(['visibleModel', 'effort'] as const)('unknown %s blocks all passes', field => {
  const f = fixture('codex'); f.record.combination[field] = { known: false, reason: 'not in native record' };
  expect(outcomes(assess(f.record, f.assessment, f.probes))).not.toContain('pass');
});

it('assessment cannot supply human overrides for capability confirmation or a missing answer', () => {
  for (const target of ['confirmed', 'structure']) {
    const f = fixture('codex');
    if (target === 'confirmed') f.assessment.confirmations['async-question'].status = 'unverified';
    else f.record.events = f.record.events.filter(e => e.seq !== f.assessment.selection.answer);
    f.assessment.reviews.push({ itemId: `async-question.${target}`, role: 'human', by: 'Kun', status: 'holds', reason: 'Self-authored approval' });
    expect(assess(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).not.toBe('pass');
  }
});

it('two duplicated reviewer records cannot establish independent content review', () => {
  const f = fixture('codex');
  f.assessment.reviews.forEach(r => { r.by = 'same-reviewer'; });
  expect(outcomes(assess(f.record, f.assessment, f.probes))).not.toContain('pass');
});

it.each(['./codex-supported.jsonl', 'copy.jsonl'])('cannot use acceptance evidence as its own earlier probe: %s', path => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true });
  writeFileSync(join(dir, 'capture.json'), read('codex-capture.json'));
  if (path === 'copy.jsonl') writeFileSync(join(dir, path), read('codex-supported.jsonl'));
  const a = JSON.parse(read('codex-assessment.json')) as Assessment;
  for (const c of Object.values(a.confirmations)) { c.probe!.path = path; c.probe!.sha256 = createHash('sha256').update(read('codex-supported.jsonl')).digest('hex'); }
  expect(() => importAttempt(dir, 'codex-supported.jsonl', a)).toThrow(/probe/);
});

it.each(['version', 'time', 'session', 'malformed'])('reads probe native %s rather than trusting its asserted metadata', field => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true }); writeFileSync(join(dir, 'capture.json'), read('codex-capture.json'));
  let text = read('codex-probe.jsonl');
  if (field === 'version') text = text.replaceAll('synthetic-1', 'different-version');
  if (field === 'time') text = text.replaceAll('T01:', 'T03:');
  if (field === 'session') text = read('codex-supported.jsonl').replaceAll('T02:', 'T01:');
  if (field === 'malformed') text = '{broken';
  writeFileSync(join(dir, 'codex-probe.jsonl'), text);
  const a = JSON.parse(read('codex-assessment.json')) as Assessment;
  for (const c of Object.values(a.confirmations)) c.probe!.sha256 = createHash('sha256').update(text).digest('hex');
  expect(() => importAttempt(dir, 'codex-supported.jsonl', a)).toThrow(/probe/);
});

it('validates independent retained review inputs, outputs, quotes and Attempt binding', () => {
  const f = fixture('codex'); const artifacts = artifactsFor(f.record, f.assessment);
  const verified = verifyReviews(f.record, f.assessment, artifacts);
  expect(outcomes(assessAttempt(f.record, f.assessment, f.probes, verified))).toEqual(abilities.map(() => 'pass'));
  for (const mutation of ['same-output', 'same-reviewer', 'same-session', 'wrong-input', 'unrelated-quote', 'human']) {
    const bad = structuredClone(artifacts);
    if (mutation === 'same-output') bad[1]!.output = bad[0]!.output;
    if (mutation === 'same-reviewer') bad[1]!.reviewer = bad[0]!.reviewer;
    if (mutation === 'same-session') bad[1]!.sessionId = bad[0]!.sessionId;
    if (mutation === 'wrong-input') bad[0]!.input = bad[0]!.input.replace(f.record.attemptId, 'another-attempt');
    if (mutation === 'unrelated-quote') { const output = JSON.parse(bad[0]!.output); output.evidence[0].quote = 'unrelated words'; bad[0]!.output = JSON.stringify(output); }
    if (mutation === 'human') Object.assign(bad[0]!, { role: 'human', reviewer: 'Kun' });
    expect(() => verifyReviews(f.record, f.assessment, bad), mutation).toThrow();
  }
  f.record.events.pop();
  expect(outcomes(assessAttempt(f.record, f.assessment, f.probes, verified))).not.toContain('pass');
});

it('accepts reviews only through a separate hashed artifact manifest, never assessment.json', () => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true }); writeFileSync(join(dir, 'capture.json'), read('codex-capture.json'));
  const a = JSON.parse(read('codex-assessment.json')) as Assessment;
  const first = importAttempt(dir, 'codex-supported.jsonl', a);
  const f = fixture('codex'); f.assessment.reviews.forEach(r => { r.reason = 'Independent synthetic interpretation of the quoted evidence.'; });
  const artifacts = artifactsFor(first.record, { ...a, reviews: f.assessment.reviews });
  const sources = artifacts.map(({ input, output, ...identity }, index) => {
    const inputPath = `review-${index}.input.json`; const outputPath = `review-${index}.output.json`;
    writeFileSync(join(dir, inputPath), input); writeFileSync(join(dir, outputPath), output);
    return { ...identity, input: { path: inputPath, sha256: createHash('sha256').update(input).digest('hex') }, output: { path: outputPath, sha256: createHash('sha256').update(output).digest('hex') } };
  });
  writeFileSync(join(dir, 'reviews.json'), JSON.stringify({ schema: 'wayfinder-interactive-reviews/1', records: sources }));
  const imported = importAttempt(dir, 'codex-supported.jsonl', a, 'reviews.json');
  expect(outcomes(imported)).toEqual(abilities.map(() => 'insufficient-evidence'));
  expect(imported.reviewIssues.some(issue => issue.reason.includes('missing required evidence'))).toBe(true);
  a.reviews = f.assessment.reviews;
  expect(() => importAttempt(dir, 'codex-supported.jsonl', a, 'reviews.json')).toThrow('invalid interactive assessment');
});

it('accepts two independently produced review bundles covering all four items', () => {
  const f = fixture('claude'); const artifacts = artifactsFor(f.record, f.assessment);
  for (const reviewer of ['synthetic-reader-1', 'synthetic-reader-2']) {
    const own = artifacts.filter(a => a.reviewer === reviewer);
    const bundle = JSON.stringify({ items: own.map(a => ({ ability: a.ability, ...JSON.parse(a.output) })) });
    own.forEach(a => { a.output = bundle; });
  }
  const verified = verifyReviews(f.record, f.assessment, artifacts);
  expect(outcomes(assessAttempt(f.record, f.assessment, f.probes, verified))).toEqual(abilities.map(() => 'pass'));
});

it('imports missing native effort as unknown instead of using the requested setting', () => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true });
  writeFileSync(join(dir, 'capture.json'), read('claude-capture.json'));
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  delete rows[0].effort;
  writeFileSync(join(dir, 'claude-supported.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const result = importAttempt(dir, 'claude-supported.jsonl', JSON.parse(read('claude-assessment.json')));
  expect(result.record.combination.effort.known).toBe(false);
  expect(outcomes(result)).not.toContain('pass');
});

it('measures changed configuration and reports missing isolation observations as unknown', async () => {
  const { mkdirSync } = await import('node:fs');
  const { isolationSnapshot, isolationMeasurements } = await import('./isolation.ts');
  const dir = temporary(); mkdirSync(join(dir, '.codex'));
  const before = isolationSnapshot(['/synthetic/run'], dir, () => ({ known: true, value: '' }));
  writeFileSync(join(dir, '.codex/config.toml'), 'url="/synthetic/run"');
  const after = isolationSnapshot(['/synthetic/run'], dir, () => ({ known: true, value: '' }));
  const result = isolationMeasurements(before, after, { known: false, reason: 'not observed' });
  expect(result.personalConfigurationUnchanged).toEqual({ known: true, value: false });
  expect(result.runPathsInPersonalConfiguration).toEqual({ known: true, value: true });
  expect(result.servedOwnDatabase.known).toBe(false); expect(result.touchedEverydayDatabase.known).toBe(false);
  const unavailable = isolationSnapshot([], dir, () => ({ known: false, reason: 'query failed' }));
  expect(isolationMeasurements(before, unavailable, { known: true, value: [] }).everydaySnapshotUnchanged.known).toBe(false);
});

it('distinguishes observed own, unexpected and unobserved databases without treating WAL-only output as proof', async () => {
  const { openDatabases, isolationMeasurements } = await import('./isolation.ts');
  const snapshot = { configs: {}, everyday: { known: true as const, value: [] } };
  const measure = (output: string) => isolationMeasurements(snapshot, snapshot,
    openDatabases(123, () => ({ known: true, value: output })), '/synthetic/maps.sqlite').servedOwnDatabase;
  expect(measure('p123\nn/synthetic/maps.sqlite\nn/synthetic/maps.sqlite-wal\n')).toEqual({ known: true, value: true });
  expect(measure('p123\nn/synthetic/unexpected.sqlite\n')).toEqual({ known: true, value: false });
  expect(measure('')).toEqual({ known: false, reason: 'own service open database not observed' });
  expect(measure('p123\nn/synthetic/maps.sqlite-wal\n')).toEqual({ known: false, reason: 'own service open database not observed' });
  const unavailable = openDatabases(123, () => ({ known: false, reason: 'synthetic permission denial' }));
  expect(isolationMeasurements(snapshot, snapshot, unavailable, '/synthetic/maps.sqlite').servedOwnDatabase.known).toBe(false);
});

it('links only a staged subscription copy without granting the personal source path', async () => {
  const { lstatSync, readlinkSync, statSync } = await import('node:fs');
  const dir = temporary(); const loginRoot = subscription();
  const prepared = launcher({ scratch: dir, client: 'codex', bin: process.execPath, port: 23456, model: 'synthetic-model', effort: 'high', subscriptionHome: loginRoot });
  const path = join(dir, 'home/.codex/auth.json');
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(path)).toBe(prepared.profile.mutableReadOnlyFiles[0]);
  expect(readFileSync(path, 'utf8')).toBe(''); // Opaque bytes are copied only by the approved launch.
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const profile = readFileSync(prepared.profile.path, 'utf8');
  expect(profile).toContain(`(literal "${readlinkSync(path)}")`);
  expect(profile).not.toContain(loginRoot);
});

it('redacts summaries and recognizable subscription tokens without loading credentials', async () => {
  const { privateText } = await import('./privacy.ts');
  const text = privateText('failure at /synthetic/home/run with controller-secret Bearer sk-ant-oat01-syntheticsecret123456', { controller: 'controller-secret' }, '/synthetic/home');
  expect(text).not.toContain('controller-secret'); expect(text).not.toContain('syntheticsecret'); expect(text).toContain('~/run');
});

it('retains a proven temporal violation when the run times out', () => {
  const f = fixture('codex'); f.record.run.completeness = 'timeout';
  f.record.events.filter(e => e.seq >= f.assessment.selection.answer!).forEach(e => { e.turn = 1; });
  expect(assess(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).toBe('fail');
});

it('accepts a completed read-only command only with actual output used in the later question', () => {
  const f = fixture('codex'); const event = f.record.events[2]!;
  Object.assign(event, { tool: 'exec_command', arguments: { cmd: 'cat facts.txt' }, result: { known: true, value: { exit_code: 0, output: 'Base supports mobile entry' } } });
  expect(assess(f.record, f.assessment, f.probes).verdicts[1]!.verdict.outcome).toBe('pass');
});

it('only a successful question result with actual answers becomes human input', () => {
  const base = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'synthetic-question', cli_version: 'synthetic-1' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'function_call', call_id: 'q', name: 'request_user_input', arguments: '{}' } },
  ];
  for (const [output, expected] of [[{ answers: { carrier: 'Base' } }, 1], [{ is_error: true, answers: { carrier: 'Base' } }, 0], ['User rejected tool use', 0], ['tool completed', 0]] as const) {
    const text = [...base, { timestamp: '2026-01-01T00:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: JSON.stringify(output) } },
      { timestamp: '2026-01-01T00:00:04Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } }].map(r => JSON.stringify(r)).join('\n');
    expect(normalizeNative('codex', text, 'question.jsonl', 'fake').events.filter(e => e.kind === 'message' && e.actor === 'script-human')).toHaveLength(expected);
  }
});

it('does not count injected context as a human answer or ignore ambiguous queued input', () => {
  const codex = read('codex-supported.jsonl').replace('Resume the synthetic collaboration Map.', '<environment_context>injected</environment_context>');
  expect(normalizeNative('codex', codex, 'meta.jsonl', 'fake').events.filter(e => e.kind === 'message' && e.actor === 'script-human')).toHaveLength(1);
  const rows = read('claude-supported.jsonl').trim().split('\n').map(l => JSON.parse(l));
  rows.find(r => r.type === 'user').isMeta = true;
  const native = normalizeNative('claude', rows.map(r => JSON.stringify(r)).join('\n'), 'meta.jsonl', 'fake');
  expect(native.events.filter(e => e.kind === 'message' && e.actor === 'script-human')).toHaveLength(1);
});

it('keeps one placeholder for the same token in Bearer headers and ordinary references', async () => {
  const { privateText } = await import('./privacy.ts');
  expect(privateText('Authorization: Bearer synthetic-secret and synthetic-secret', { agent: 'synthetic-secret' }))
    .toBe('Authorization: Bearer <agent> and <agent>');
});

it('does not arbitrate two settled agreeing reviews', () => {
  const f = fixture('codex'); const artifacts = artifactsFor(f.record, f.assessment);
  const reviews = artifacts.slice(0, 2);
  reviews.forEach(a => { const value = JSON.parse(a.output); value.status = 'violated'; a.output = JSON.stringify(value); });
  const arbitration: ReviewArtifact = { ...reviews[0]!, role: 'arbitration', reviewer: 'arb', sessionId: 'arb', model: 'claude-opus-5-5',
    basis: reviews.map(a => a.output), output: JSON.stringify({ ...JSON.parse(reviews[0]!.output), status: 'holds', reason: 'Synthetic contrary arbitration.' }) };
  expect(() => verifyReviews(f.record, f.assessment, [...reviews, arbitration])).toThrow(/agree|disagree/);
});

it.each([' .\n', '\u200b', '\u00ad'])('does not count punctuation, whitespace or format controls as an independent review (%j)', suffix => {
  const f = fixture('codex'); const artifacts = artifactsFor(f.record, f.assessment).slice(0, 2);
  const output = JSON.parse(artifacts[0]!.output); output.reason = `  ${output.reason}${suffix}`;
  artifacts[1]!.output = JSON.stringify(output);
  expect(() => verifyReviews(f.record, f.assessment, artifacts)).toThrow(/duplicate/);
});

it('ends the Claude turn on interruption before the next human answer', () => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  rows.splice(5, 0, { ...rows[1], timestamp: '2026-01-01T02:00:06.500Z', uuid: 'interrupt',
    message: { role: 'user', content: '[Request interrupted by user]' } });
  const native = normalizeNative('claude', rows.map(row => JSON.stringify(row)).join('\n'), 'interrupted.jsonl', 'fake');
  const question = native.events.find(e => e.seq === 1)!; const answer = native.events.find(e => e.seq === 3)!;
  expect(answer.turn).not.toBe(question.turn);
});

it.each(['codex', 'claude'] as const)('an assistant question followed by a blocking %s answer is not asynchronous', client => {
  let rows = read(`${client}-supported.jsonl`).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.uuid !== 'prepared-boundary');
  const tool = client === 'codex' ? 'request_user_input' : 'AskUserQuestion';
  if (client === 'codex') {
    rows = rows.flatMap(row => row.payload?.type === 'message' && row.payload?.role === 'user' && JSON.stringify(row).includes('Yes, access')
      ? [{ ...row, payload: { type: 'function_call', call_id: 'question', name: tool, arguments: '{}' } },
        { ...row, payload: { type: 'function_call_output', call_id: 'question', output: JSON.stringify({ answers: { carrier: 'Yes, access must be mobile-only.' } }) } }] : [row]);
  } else {
    rows = rows.flatMap(row => row.uuid === 'id-7'
      ? [{ ...row, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'question', name: tool, input: {} }] } },
        { ...row, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'question', content: 'User has answered your questions: mobile only' }] } }] : [row]);
  }
  const native = normalizeNative(client, rows.map(row => JSON.stringify(row)).join('\n'), 'blocking.jsonl', 'fake');
  const f = fixture(client); f.record.events = native.events; f.record.sessions = [native.session]; f.record.missing = native.missing;
  const answer = native.events.find(e => e.kind === 'message' && e.actor === 'script-human' && (e.text.includes('mobile-only') || e.text.startsWith('User has answered')))!;
  const next = native.events.filter(e => e.kind === 'message' && e.actor === 'agent').slice(-2);
  Object.assign(f.assessment.selection, { answer: answer.seq, revisedRecommendation: next[0]!.seq, continuation: next[1]!.seq });
  expect(assess(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).toBe('fail');
});

it.each(['true', 1, 'yes'])('error flags do not produce synthetic human answers (%j)', flag => {
  const rows = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'function_call', call_id: 'q', name: 'request_user_input', arguments: '{}' } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: JSON.stringify({ is_error: flag, answers: { carrier: 'Base' } }) } },
  ];
  expect(normalizeNative('codex', rows.map(row => JSON.stringify(row)).join('\n'), 'error.jsonl', 'fake').events.filter(e => e.kind === 'message')).toHaveLength(0);
});

it('preserves a newer synthetic Codex refresh and backs up the old login before cleanup', async () => {
  const { mkdirSync, utimesSync, statSync } = await import('node:fs');
  const { syncCodexLogin } = await import('./subscription.ts');
  const scratch = temporary(); const daily = temporary();
  mkdirSync(join(scratch, 'home/.codex'), { recursive: true }); mkdirSync(join(daily, '.codex'));
  const own = join(scratch, 'home/.codex/auth.json'); const destination = join(daily, '.codex/auth.json');
  writeFileSync(destination, 'synthetic-old-login'); writeFileSync(own, 'synthetic-refreshed-login');
  utimesSync(destination, 1, 1); utimesSync(own, 2, 2);
  const result = syncCodexLogin(scratch, daily);
  expect(readFileSync(destination, 'utf8')).toBe('synthetic-refreshed-login');
  expect(result.status).toBe('synced');
  expect(readFileSync(result.backup!, 'utf8')).toBe('synthetic-old-login');
  expect(statSync(destination).mode & 0o777).toBe(0o600); expect(statSync(result.backup!).mode & 0o777).toBe(0o600);
});

it('Claude receives only the six proxy keys, with terminal environment taking precedence', async () => {
  const { mkdirSync } = await import('node:fs'); const { proxyEnvironment } = await import('../proxy.ts');
  const home = temporary(); mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://synthetic-settings:1',
    http_proxy: 'http://synthetic-settings:2', NO_PROXY: 'localhost', ANTHROPIC_API_KEY: 'synthetic-disallowed', OTHER: 'synthetic-disallowed' } }));
  expect(proxyEnvironment(home, { HTTPS_PROXY: 'http://synthetic-terminal:3', CODEX_API_KEY: 'synthetic-disallowed' }))
    .toEqual({ HTTPS_PROXY: 'http://synthetic-terminal:3', http_proxy: 'http://synthetic-settings:2', NO_PROXY: 'localhost' });
});

it.each(['disagree', 'undecided'])('allows bound arbitration only for %s readings', kind => {
  const f = fixture('codex'); const reviews = artifactsFor(f.record, f.assessment).slice(0, 2);
  const changed = JSON.parse(reviews[1]!.output); changed.status = kind === 'disagree' ? 'violated' : 'undecided';
  reviews[1]!.output = JSON.stringify(changed);
  const arb: ReviewArtifact = { ...reviews[0]!, role: 'arbitration', reviewer: 'arb', sessionId: 'arb', model: 'claude-opus-5-5',
    basis: reviews.map(a => a.output), output: JSON.stringify({ ...JSON.parse(reviews[0]!.output), reason: 'Synthetic arbitration with both readings.' }) };
  expect(() => verifyReviews(f.record, f.assessment, [...reviews, arb])).not.toThrow();
});

it('does not follow an unchanged login link or replace a newer daily synthetic login', async () => {
  const { mkdirSync, symlinkSync, unlinkSync, utimesSync, readdirSync } = await import('node:fs');
  const { syncCodexLogin } = await import('./subscription.ts');
  const scratch = temporary(); const daily = temporary();
  mkdirSync(join(scratch, 'home/.codex'), { recursive: true }); mkdirSync(join(daily, '.codex'));
  const own = join(scratch, 'home/.codex/auth.json'); const target = join(daily, '.codex/auth.json');
  symlinkSync(target, own);
  expect(syncCodexLogin(scratch, daily)).toEqual({ status: 'linked' }); // Target deliberately does not exist.
  unlinkSync(own); writeFileSync(own, 'synthetic-old'); writeFileSync(target, 'synthetic-new');
  utimesSync(own, 1, 1); utimesSync(target, 2, 2);
  expect(syncCodexLogin(scratch, daily)).toEqual({ status: 'daily-newer' });
  expect(readFileSync(target, 'utf8')).toBe('synthetic-new'); expect(readdirSync(join(daily, '.codex'))).toEqual(['auth.json']);
});

it('a failed login sync preserves the refreshed synthetic file for recovery', async () => {
  const { mkdirSync } = await import('node:fs'); const { syncCodexLogin } = await import('./subscription.ts');
  const scratch = temporary(); const daily = temporary(); mkdirSync(join(scratch, 'home/.codex'), { recursive: true });
  const own = join(scratch, 'home/.codex/auth.json'); writeFileSync(own, 'synthetic-refresh');
  expect(() => syncCodexLogin(scratch, daily)).toThrow();
  expect(readFileSync(own, 'utf8')).toBe('synthetic-refresh');
});

it('login synchronization refuses a client-created parent symlink before reading outside scratch', async () => {
  const { symlinkSync } = await import('node:fs'); const { syncCodexLogin } = await import('./subscription.ts');
  const scratch = temporary(); const daily = subscription(); const privateRoot = temporary();
  mkdirSync(join(scratch, 'home'));
  writeFileSync(join(privateRoot, 'auth.json'), 'synthetic-private-marker');
  symlinkSync(privateRoot, join(scratch, 'home/.codex'));
  expect(() => syncCodexLogin(scratch, daily)).toThrow(/login directory/);
  expect(readFileSync(join(daily, '.codex/auth.json'), 'utf8')).toBe('synthetic-login');
});

it('the generated Claude launcher preserves the proxy allowlist without arbitrary environment keys', () => {
  const script = launcher({ scratch: temporary(), client: 'claude', bin: process.execPath, port: 23456,
    model: 'synthetic-model', effort: 'high', subscriptionHome: subscription(), proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:23457/', NO_PROXY: 'localhost',
      ANTHROPIC_API_KEY: 'synthetic-excluded', OTHER: 'synthetic-excluded' } });
  expect(script.manifest.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:23457/', NO_PROXY: 'localhost' });
  expect(JSON.stringify(script.manifest)).not.toContain('synthetic-excluded');
});

it('a rejection notice beside a failed Claude tool result is not human input', () => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line));
  const row = rows.find(row => row.uuid === 'id-6'); row.message.content[0].is_error = 'true';
  row.message.content.push({ type: 'text', text: 'User rejected tool use' });
  expect(normalizeNative('claude', rows.map(row => JSON.stringify(row)).join('\n'), 'rejected.jsonl', 'fake').events
    .some(e => e.kind === 'message' && e.text === 'User rejected tool use')).toBe(false);
});

it.each(['sed -i "" s/a/b/w\\ /dev/stdout facts.txt', 'rg --pre ./x.sh mobile', 'tail -f facts.txt'])('does not label an executing or open-ended command as a completed read: %s', cmd => {
  const f = fixture('codex');
  Object.assign(f.record.events[2]!, { tool: 'exec_command', arguments: { cmd }, result: { known: true, value: { exit_code: 0, output: 'Base supports mobile entry' } } });
  expect(outcomes(assess(f.record, f.assessment, f.probes)).slice(0, 2)).not.toContain('pass');
});

it('does not retain personal configuration hashes in the isolation report', async () => {
  const { mkdirSync } = await import('node:fs'); const { isolationSnapshot, isolationMeasurements } = await import('./isolation.ts');
  const dir = temporary(); mkdirSync(join(dir, '.codex')); writeFileSync(join(dir, '.codex/config.toml'), 'synthetic-private-setting');
  const snapshot = isolationSnapshot([], dir, () => ({ known: true, value: '' }));
  const result = isolationMeasurements(snapshot, snapshot, { known: false, reason: 'not observed' });
  expect(result.personalConfigurationUnchanged).toEqual({ known: true, value: true });
  expect(JSON.stringify(result)).not.toContain('sha256'); expect(JSON.stringify(result)).not.toContain('synthetic-private-setting');
});

it('an uncorrelated second Claude user row cannot establish mid-turn delivery', () => {
  const rows = read('claude-supported.jsonl').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.uuid !== 'prepared-boundary');
  const native = normalizeNative('claude', rows.map(row => JSON.stringify(row)).join('\n'), 'uncorrelated.jsonl', 'fake');
  const f = fixture('claude'); f.record.events = native.events; f.record.sessions = [native.session]; f.record.missing = native.missing;
  const result = assess(f.record, f.assessment, f.probes);
  expect([result.verdicts[0]!.verdict.outcome, result.verdicts[3]!.verdict.outcome]).toEqual(['insufficient-evidence', 'insufficient-evidence']);
});

it('scrubs recognizable credentials from every offline output including review input', () => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true });
  const capture = JSON.parse(read('codex-capture.json')); capture.run.detail = 'Bearer sk-ant-oat01-synthetic-secret-1234567890';
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(capture));
  main([dir, 'codex-supported.jsonl', 'codex-assessment.json', 'scrubbed']);
  for (const file of ['result.json', 'attempt.json', 'review-input.json', ...abilities.map(a => `${a}.attempt.json`)]) {
    expect(readFileSync(join(dir, 'scrubbed', file), 'utf8')).not.toContain('synthetic-secret-1234567890');
  }
});

it.each(['model', 'effort'])('retains native %s mismatch as an insufficient-evidence result', field => {
  const dir = temporary(); cpSync(fixtures, dir, { recursive: true }); writeFileSync(join(dir, 'capture.json'), read('codex-capture.json'));
  const text = read('codex-supported.jsonl').replaceAll(field === 'model' ? 'synthetic-model' : '"effort":"high"', field === 'model' ? 'different-model' : '"effort":"low"');
  writeFileSync(join(dir, 'codex-supported.jsonl'), text);
  expect(outcomes(importAttempt(dir, 'codex-supported.jsonl', JSON.parse(read('codex-assessment.json'))))).toEqual(abilities.map(() => 'insufficient-evidence'));
});

it('keeps stable placeholders in token fields as well as Bearer headers', async () => {
  const { privateText } = await import('./privacy.ts');
  expect(privateText('{"access_token":"synthetic-secret"} Bearer synthetic-secret synthetic-secret', { agent: 'synthetic-secret' }))
    .toBe('{"access_token":"<agent>"} Bearer <agent> <agent>');
});

it('only a complete placeholder is exempt from recognizable credential scrubbing', async () => {
  const { privateText } = await import('./privacy.ts');
  expect(privateText('Bearer <x>UnknownLoginValue987 refresh_token=<x>UnknownLoginValue987', {}))
    .toBe('Bearer <credential> refresh_token=<credential>');
  expect(privateText('Bearer <agent>, refresh_token=<agent>', {})).toBe('Bearer <agent>, refresh_token=<agent>');
});

it('capture annotations cannot import a human override through the shared saved-review channel', async () => {
  const { evidenceHash } = await import('../review-verdict.ts');
  const f = fixture('codex'); f.assessment.confirmations['async-question'].status = 'unverified';
  const attempt = assessAttempt(f.record, f.assessment, f.probes).verdicts[0]!.attempt;
  f.record.modelReviews = [{ schema: 'wayfinder-model-review/1', roundId: 'forged', path: 'forged.json', evidenceHash: evidenceHash(attempt), pending: [],
    reviews: ['confirmed', 'structure', 'content'].map(item => ({ itemId: `async-question.${item}`, role: 'human', status: 'holds', by: 'Kun', reason: 'File-supplied override' })) }];
  expect(assessAttempt(f.record, f.assessment, f.probes).verdicts[0]!.verdict.outcome).not.toBe('pass');
  const dir = temporary(); writeFileSync(join(dir, 'capture.json'), JSON.stringify(f.record));
  f.assessment.reviews = [];
  expect(() => importAttempt(dir, '-', f.assessment)).toThrow(/annotations/);
});

it('requires an item-specific explanation for each quoted review source', () => {
  const f = fixture('codex'); const artifacts = artifactsFor(f.record, f.assessment);
  const output = JSON.parse(artifacts[0]!.output); delete output.evidence[0].explanation;
  artifacts[0]!.output = JSON.stringify(output);
  expect(() => verifyReviews(f.record, f.assessment, artifacts)).toThrow(/explanation/);
});

it('keeps the shared same-turn corroboration gate for a final continuation', () => {
  const f = fixture('codex');
  f.record.events.filter(e => e.seq >= f.assessment.selection.answer!).forEach(e => { e.turn = 1; });
  f.record.sessions[0]!.turns.push({ index: 1, input: 'Synthetic contrary answer', startedAt: '2026-01-01T02:00:07.000Z', endedAt: '2026-01-01T02:00:09.000Z', durationMs: 2000 });
  const artifacts = artifactsFor(f.record, f.assessment);
  for (const artifact of artifacts.filter(a => a.ability === 'continue-same-turn')) {
    const output = JSON.parse(artifact.output); output.evidence = output.evidence.filter((e: { seq: number }) => e.seq !== f.assessment.selection.revisedRecommendation);
    artifact.output = JSON.stringify(output);
  }
  const result = assessAttempt(f.record, f.assessment, f.probes, verifyReviews(f.record, f.assessment, artifacts));
  expect(result.verdicts[3]!.verdict.outcome).toBe('insufficient-evidence');
  expect(result.reviewIssues.some(issue => issue.reason.includes('same turn'))).toBe(true);
});
