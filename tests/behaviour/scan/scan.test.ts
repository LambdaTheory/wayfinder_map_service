import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from './analyze.ts';
import { batchStatus, finish, openLedger, plannedInvocations, proposeBatch, reserve } from './batch.ts';
import { privateJson, scanCommand } from './cli.ts';
import { digest, loadInputs, nativeSessions } from './read.ts';
import type { Inputs, Manifest, Review } from './types.ts';

const fixtures = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(fixtures, 'input.json'), 'utf8')) as Manifest;
const inputs = () => loadInputs(manifest, fixtures);
const temporary: string[] = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), 'wayfinder-scan-')); temporary.push(path); return path; }
afterEach(() => { temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('native usage inventory and conservative correlation', () => {
  it('covers the fixed R7 sample inventory with exact evidence and visible gaps', () => {
    const report = analyze(inputs(), manifest);
    const session = (id: string) => report.inventory.find(s => s.nativeId === id)!;
    expect(session('skill-only').activity).toBe('skill-only-observed');
    expect(session('read-a')).toMatchObject({ usage: 'test', activity: 'mcp' });
    expect(session('read-b')).toMatchObject({ usage: 'normal', model: 'synthetic-model' });
    expect(session('research')).toMatchObject({ usage: 'research', activity: 'skill-only-observed' });
    expect(report.inventory.find(s => s.subagent)).toMatchObject({ usage: 'unknown', activity: 'mcp', serviceCalls: [] });
    expect(report.matches.find(m => m.call.mcpSessionId === 'mcp-read-a')).toMatchObject({ session: 'codex:read-a', nativeCall: 'attempt/attempt.json/events/1' });
    expect(report.matches.find(m => m.call.mcpSessionId === 'mcp-read-b')).toMatchObject({ session: 'codex:read-b', nativeCall: null });
    expect(report.leads.some(l => l.kind === 'refusal')).toBe(true);
    expect(report.leads.some(l => l.kind === 'conflict')).toBe(true);
    expect(report.leads.some(l => l.kind === 'write' && l.session === 'codex:question-write')).toBe(true);
    expect(session('missing-log').gaps.join(' ')).toContain('Native conversation unavailable');
    expect(report.gaps.join(' ')).toContain('missing service observations');
    expect(report.gaps.join(' ')).toContain('missing: missing or unreadable');
    expect(report.summary.newFailures).toBe(0);
    expect(report.inventory.every(s => s.authorization === 'not-assessed')).toBe(true);
  });

  it('never joins the same Combination by Client ID, timestamp, tool-use ID or request ID alone', () => {
    const data = inputs();
    data.launches = [];
    data.sessions = data.sessions.filter(s => !s.sources.includes('attempt/attempt.json'));
    const report = analyze(data, manifest);
    for (const match of report.matches) {
      expect(match.session).toMatch(/^service:/);
      expect(match.nativeCall).toBeNull();
      expect(match.basis).toEqual([]);
    }
  });

  it('refuses ambiguous joins and conflicting credential/session evidence', () => {
    const data = inputs();
    const attempt = data.sessions.find(s => s.mcpSessionIds.length)!;
    attempt.mcpSessionIds.push('mcp-read-b');
    const report = analyze(data, manifest);
    expect(report.matches.find(m => m.call.mcpSessionId === 'mcp-read-b')!.gaps).toContain('Ambiguous session/fingerprint join');
    const second = inputs();
    second.calls.find(c => c.mcpSessionId === 'mcp-read-a')!.credentialFingerprint = 'different-fingerprint';
    expect(analyze(second, manifest).matches[0]!.gaps).toContain('MCP session and credential fingerprint disagree');
  });

  it('keeps numeric/string request collisions unknown and supports the B07 hashed request key', () => {
    const data = inputs();
    const call = data.calls[0]!;
    data.calls.push({ ...call, ref: 'duplicate#L1', sequence: 99, requestIdType: 'string' });
    expect(analyze(data, manifest).matches[0]!.nativeCall).toBeNull();
    const hashed = inputs();
    hashed.calls[0]!.requestId = null;
    // Compute exactly B07 SHA-256(domain + NUL + ID), not the scanner's JSON digest.
    const hash = createHash('sha256').update('wayfinder-call-request/1\0unsafe request').digest('hex');
    hashed.calls[0]!.requestIdHash = hash;
    hashed.sessions.find(s => s.mcpSessionIds.length)!.calls[0]!.requestId = 'unsafe request';
    expect(analyze(hashed, manifest).matches[0]!.nativeCall).not.toBeNull();
  });

  it('reports malformed, unknown, empty, absent and symlink sources without guessing data', () => {
    const root = scratch();
    writeFileSync(join(root, 'bad.jsonl'), '{"schema":"future/1"}\n{"truncated":');
    symlinkSync(join(root, 'bad.jsonl'), join(root, 'link.jsonl'));
    const m: Manifest = { schema: 'wayfinder-usage-input/1', sources: [{ id: 'bad', kind: 'calls', path: root }, { id: 'absent', kind: 'codex', path: join(root, 'absent') }] };
    const data = loadInputs(m, root);
    expect(data.calls).toEqual([]);
    expect(data.gaps.join(' ')).toMatch(/malformed or truncated/);
    expect(data.gaps.join(' ')).toMatch(/unsupported or invalid/);
    expect(data.gaps.join(' ')).toMatch(/skipped unsafe/);
    expect(analyze(data, m).summary).toMatchObject({ newFailures: 0, confirmed: 0, modelsStarted: 0 });
  });

  it('does not mistake a Skill catalog or a Claude child session for direct use', () => {
    const rows = [
      { ref: 'catalog#1', value: { type: 'session_meta', payload: { id: 'catalog' } } },
      { ref: 'catalog#2', value: { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Available: @wayfinder at wayfinder/SKILL.md' }] } } },
    ];
    expect(nativeSessions(rows, 'codex', 'catalog')[0]!.skill).toEqual([]);
    const s = inputs().sessions.find(s => s.subagent)!;
    expect(s.key).toBe('claude:normal-write/subagent/sub-1');
    expect(s.usage).toBe('unknown');
    const labeled = { ...manifest, labels: [{ harness: 'claude' as const, nativeId: 'normal-write', agentId: 'sub-1', usage: 'research' as const, basis: 'Synthetic assignment: read-only research' }] };
    expect(analyze(inputs(), labeled).inventory.find(s => s.subagent)!.usage).toBe('research');
    expect(analyze(inputs(), labeled).inventory.find(s => s.key === 'claude:normal-write')!.usage).toBe('normal');
  });

  it('keeps changed model/effort assignments unknown rather than crediting the last model', () => {
    const sessions = nativeSessions([
      { ref: 'settings#1', value: { type: 'session_meta', payload: { id: 'changes' } } },
      ...['first', 'second', 'third'].map((model, i) => ({ ref: `settings#${i + 2}`, value: { type: 'turn_context', payload: { model, effort: model } } })),
    ], 'codex', 'settings');
    expect(sessions[0]).toMatchObject({ model: null, effort: null });
    expect(sessions[0]!.gaps.join(' ')).toContain('Multiple model values');
  });
});

function decision(report: ReturnType<typeof analyze>, session: string, disposition: Review['disposition']): Review {
  const lead = report.leads.find(l => l.session === session && l.kind === 'write')!;
  return { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition, by: 'synthetic-human-reviewer',
    basis: 'Synthetic accepted rule: ask before a scope change; the verdict was read in context', reason: 'Synthetic context review',
    quotes: lead.fragments.filter(f => f.role === 'user' || f.role === 'tool').map(f => ({ ref: f.ref, quote: f.text })) };
}

describe('screening, evidence-bound verdicts and B04 intake', () => {
  it('metadata alone cannot confirm a violation, even with a claimed review', () => {
    const data: Inputs = { ...inputs(), sessions: [] };
    const first = analyze(data, manifest);
    const lead = first.leads.find(l => l.kind === 'write')!;
    const r: Review = { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition: 'confirmed', by: 'claimed-reviewer', basis: 'metadata', reason: 'write observed', quotes: [{ ref: lead.refs[0]!, quote: 'committed' }] };
    const report = analyze(data, manifest, undefined, [r]);
    expect(report.summary).toMatchObject({ confirmed: 0, newFailures: 0, reminders: 0 });
    expect(report.gaps.join(' ')).toContain('verdict needs original human words');
  });

  it('a normal HITL write is never an automatic failure and can be dismissed only with original context', () => {
    const data = inputs(); const first = analyze(data, manifest);
    expect(first.summary.newFailures).toBe(0);
    const review = decision(first, 'claude:normal-write', 'dismissed');
    const report = analyze(data, manifest, undefined, [review]);
    expect(report.leads.find(l => l.id === review.leadId)!.status).toBe('dismissed');
    expect(report.captureDrafts.some(d => d.leadId === review.leadId)).toBe(false);
    expect(report.summary.newFailures).toBe(0);
  });

  it('requires exact original words and native action evidence, rejects stale reviews, and never calls unknown a failure', () => {
    const data = inputs(); const first = analyze(data, manifest);
    const good = decision(first, 'codex:question-write', 'confirmed');
    for (const bad of [{ ...good, quotes: [] }, { ...good, evidenceHash: 'stale' }, { ...good, quotes: [good.quotes[0]!] },
      { ...good, quotes: good.quotes.map(q => ({ ...q, quote: 'invented words' })) }]) {
      expect(analyze(data, manifest, undefined, [bad]).summary.newFailures).toBe(0);
    }
    const report = analyze(data, manifest, undefined, [good]);
    expect(report.summary).toMatchObject({ newFailures: 1, confirmed: 1, reminders: 1 });
    expect(report.reviews).toEqual([good]);
    expect(report.leads.filter(l => l.kind === 'missing-evidence').every(l => l.status === 'pending' && !l.reminder)).toBe(true);
    expect(report.captureDrafts.find(d => d.leadId === good.leadId)).toMatchObject({ ready: false, input: { revision: null, claims: null, humanWords: null, verdict: null, reproductions: [] } });
  });

  it('reminds one lead once across weekly scans and retains confirmed findings', () => {
    const data = inputs(); const first = analyze(data, manifest);
    const review = decision(first, 'codex:question-write', 'confirmed');
    const once = analyze(data, manifest, undefined, [review]);
    const next = analyze(data, manifest, once.state, [review]);
    expect(next.summary).toMatchObject({ confirmed: 1, newFailures: 0, reminders: 0 });
    expect(next.state).toEqual(once.state);
  });

  it('requests ChatGPT words only after a screened verdict need, not for every metadata write', () => {
    const data = inputs(); const first = analyze(data, manifest);
    expect(first.leads.every(l => !l.requestHumanWords)).toBe(true);
    const s = first.inventory.find(s => s.harness === 'chatgpt')!;
    const lead = first.leads.find(l => l.session === s.key && l.kind === 'write')!;
    const review: Review = { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition: 'needs-human-words', by: 'synthetic-human',
      basis: 'Specific scope-change report needs the preceding verdict', reason: 'Screened before asking for words', quotes: [] };
    const report = analyze(data, manifest, undefined, [review]);
    expect(report.leads.find(l => l.id === lead.id)).toMatchObject({ status: 'screened', requestHumanWords: true });
    expect(report.summary.newFailures).toBe(0);
  });
});

describe('quota-free scan and bounded approved work accounting', () => {
  it('lists model work and preserves full results and remaining work at the approved ceiling', () => {
    const { plan } = proposeBatch(analyze(inputs(), manifest));
    expect(plan.work.some(w => w.kind === 'arbitration')).toBe(true);
    expect(plan.work.filter(w => w.kind === 'reading').every(w => w.repetitions === 2)).toBe(true);
    plan.ceiling = 2;
    const invocations = plannedInvocations(plan);
    expect(() => openLedger(plan, { planHash: '', by: '', reference: '' })).toThrow(/approval/);
    let ledger = openLedger(plan, { planHash: digest(plan), by: 'synthetic-user', reference: 'synthetic-approval#1' });
    expect(() => reserve(plan, ledger, 'unplanned')).toThrow(/Unplanned/);
    let fakeCalls = 0;
    for (const item of invocations.slice(0,2)) {
      ledger = reserve(plan, ledger, item.id);
      fakeCalls++;
      ledger = finish(plan, ledger, item.id, fakeCalls === 1 ? 'failed' : 'complete', { stdout: `complete synthetic result ${fakeCalls}`, stderr: 'retained', attempts: [fakeCalls] });
    }
    expect(() => reserve(plan, ledger, invocations[2]!.id)).toThrow(/ceiling/);
    expect(fakeCalls).toBe(2);
    expect(batchStatus(plan, ledger)).toMatchObject({ stoppedAtCeiling: true, slotsLeft: 0, remaining: invocations.slice(2) });
    expect(batchStatus(plan, ledger).results[0]!.result).toEqual({ stdout: 'complete synthetic result 1', stderr: 'retained', attempts: [1] });
    expect(() => finish(plan, ledger, invocations[0]!.id, 'complete', { replaced: true })).toThrow(/reserved/);
    expect(() => reserve({ ...plan, ceiling: 3 }, ledger, invocations[2]!.id)).toThrow(/approval/);
  });

  it('counts reserved/crashed work and extra reviews against the cap across serialization', () => {
    const plan = proposeBatch(analyze(inputs(), manifest)).plan;
    plan.work = [plan.work[0]!]; plan.work[0]!.extraReviews = 2; plan.ceiling = 1;
    const item = plannedInvocations(plan)[0]!;
    const reserved = reserve(plan, openLedger(plan, { planHash: digest(plan), by: 'synthetic-user', reference: 'synthetic-approval' }), item.id);
    const saved = JSON.parse(JSON.stringify(reserved));
    expect(batchStatus(plan, saved)).toMatchObject({ stoppedAtCeiling: true, unresolved: [item.id], remaining: plannedInvocations(plan).slice(1) });
    expect(() => reserve(plan, saved, plannedInvocations(plan)[1]!.id)).toThrow(/ceiling/);
  });

  it('runs the manual CLI with no executable search path, writes private outputs and refuses overwrite', () => {
    const root = scratch(); const out = join(root, 'scan');
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const child = spawnSync(process.execPath, [cli, '--input', join(fixtures, 'input.json'), '--out', out], {
      env: { PATH: '', HOME: root }, encoding: 'utf8', timeout: 10_000 });
    expect(child.stderr).toBe(''); expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ modelsStarted: 0, newFailures: 0, batchApproved: false });
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, 'inventory.json')).mode & 0o777).toBe(0o600);
    expect(() => scanCommand(['--input', join(fixtures, 'input.json'), '--out', out])).toThrow();
    expect(() => scanCommand(['--input', join(fixtures, 'input.json'), '--out', resolve('tests/behaviour/scan/do-not-create')])).toThrow(/outside/);
    expect(() => scanCommand(['--input', join(fixtures, 'input.json'), '--out', join(root, 'other'), '--approve'])).toThrow();
  });

  it('redacts credentials consistently without copying literal secret lists or authorizing anything', () => {
    const secret = 'synthetic-private-token';
    const value = privateJson({ words: `Bearer ${secret}`, again: secret, api: 'sk-ant-syntheticlongcredential' }, [secret]);
    expect(value).not.toContain(secret);
    expect(value).not.toContain('sk-ant-syntheticlongcredential');
    expect(JSON.parse(value).again).toMatch(/^<secret-/);
  });
});
