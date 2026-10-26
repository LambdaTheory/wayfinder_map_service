import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from './analyze.ts';
import { batchStatus, finish, openLedger, plannedInvocations, proposeBatch, reserve } from './batch.ts';
import { privateJson, scanCommand } from './cli.ts';
import { digest, loadInputs, nativeSessions } from './read.ts';
import { ScanError, scanFailure } from './errors.ts';
import { requestIdHash } from '../../../src/call-metadata.ts';
import type { Inputs, Manifest, Review } from './types.ts';

const fixtures = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(fixtures, 'input.json'), 'utf8')) as Manifest;
const inputs = () => loadInputs(manifest, fixtures);
const temporary: string[] = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), 'wayfinder-scan-')); temporary.push(path); return path; }
afterEach(() => { temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('native usage inventory and conservative correlation', () => {
  it('does not invent Claude sessions for summary and file-history rows', () => {
    const rows = [
      { ref: 'claude#1', value: { type: 'summary', summary: 'synthetic summary' } },
      { ref: 'claude#2', value: { type: 'user', sessionId: 'real', message: { content: 'Hello' } } },
      { ref: 'claude#3', value: { type: 'file-history-snapshot', snapshot: {} } },
    ];
    expect(nativeSessions(rows, 'claude', 'claude')).toHaveLength(1);
  });

  it('exports no unrelated dialogue in any scan artifact', () => {
    const root = scratch(); const log = join(root, 'native.jsonl');
    const sentinel = 'UNRELATED-PRIVATE-CONTENT-SENTINEL';
    writeFileSync(log, [
      { type: 'session_meta', payload: { id: 'unrelated' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: sentinel }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    const input = join(root, 'input.json');
    writeFileSync(input, JSON.stringify({ schema: 'wayfinder-usage-input/1', sources: [{ id: 'native', kind: 'codex', path: log }] }));
    const out = join(root, 'scan'); scanCommand(['--input', input, '--out', out]);
    for (const file of readdirSync(out)) expect(readFileSync(join(out, file), 'utf8')).not.toContain(sentinel);
  });
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
    expect(hash).toBe(requestIdHash('unsafe request'));
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

  it('does not treat injected client context, maintenance reads or negated mentions as human Skill use', () => {
    const codex = nativeSessions([
      { ref: 'injected#1', value: { type: 'session_meta', payload: { id: 'injected' } } },
      ...['# AGENTS.md instructions\n@wayfinder', '<environment_context>@wayfinder</environment_context>', "Do not use the wayfinder skill"].map((text, i) =>
        ({ ref: `injected#${i+2}`, value: { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text }] } } })),
      { ref: 'injected#5', value: { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat wayfinder/SKILL.md"}' } } },
    ], 'codex', 'injected')[0]!;
    expect(codex.skill).toEqual([]);
    expect(codex.fragments).toHaveLength(1);
    const claude = nativeSessions([
      { ref: 'meta#1', value: { type: 'user', sessionId: 'meta', isMeta: true, message: { content: 'Injected approval' } } },
      { ref: 'meta#2', value: { type: 'user', sessionId: 'meta', message: { content: '<local-command-stdout>Injected output</local-command-stdout>' } } },
      { ref: 'meta#3', value: { type: 'assistant', sessionId: 'meta', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'wayfinder/SKILL.md' } }] } } },
    ], 'claude', 'meta')[0]!;
    expect(claude.fragments).toEqual([]); expect(claude.skill).toEqual([]);
    const slash = nativeSessions([{ ref: 'slash#1', value: { type: 'user', sessionId: 'slash', message: { content: '<command-message>wayfinder is running…</command-message>\n<command-name>/wayfinder</command-name>' } } }], 'claude', 'slash')[0]!;
    expect(slash.skill).toEqual(['slash#1']);
  });

  it.each(['codex', 'claude'] as const)('does not accept %s injected instructions or compaction as human evidence', harness => {
    const text = harness === 'codex' ? '<user_instructions>Injected approval</user_instructions>' : 'This session is being continued from a previous conversation. Injected approval.';
    const rows = harness === 'codex' ? [
      { type: 'session_meta', payload: { id: 'injected-only' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'write', name: 'mcp__wayfinder__map_apply', arguments: '{}' } },
    ] : [
      { type: 'user', sessionId: 'injected-only', isCompactSummary: true, message: { content: text } },
      { type: 'assistant', sessionId: 'injected-only', message: { content: [{ type: 'tool_use', id: 'write', name: 'mcp__wayfinder__map_apply', input: {} }] } },
    ];
    const sessions = nativeSessions(rows.map((value, index) => ({ value, ref: `injected-only#${index}` })), harness, 'injected-only');
    const report = analyze({ sessions, calls: [], launches: [], gaps: [], sources: [] }, manifest);
    const lead = report.leads.find(l => l.kind === 'write')!;
    expect(lead.hasHumanWords).toBe(false);
    expect(lead.evidenceRefs.some(e => e.role === 'user')).toBe(false);
    expect(sessions[0]!.fragments.some(f => f.text.includes('Injected approval'))).toBe(false);
  });

  it('states the fresh-launch gap instead of inventing a native-session association', () => {
    const freshManifest = { ...manifest, sources: manifest.sources.map(s => s.kind === 'launches' ? { ...s, path: 'launches-fresh.jsonl' } : s) };
    const data = loadInputs(freshManifest, fixtures); const launch = data.launches.find(l => l.credentialFingerprint === '3'.repeat(64))!;
    const report = analyze(data, manifest);
    const native = report.inventory.find(s => s.key === 'codex:question-write')!;
    const fresh = report.inventory.find(s => s.key === `launch:${launch.credentialFingerprint}`)!;
    expect(native.serviceCalls).toEqual([]); expect(native.usage).toBe('unknown');
    expect(fresh.matchingBasis.join(' ')).toContain('launch-only row');
    expect(fresh.matchingBasis.join(' ')).not.toContain('native session ID');
    expect(report.inventory.find(s => s.key === 'codex:read-b')!.matchingBasis.join(' ')).toContain('native session ID read-b + harness codex');
  });
});

function decision(report: ReturnType<typeof analyze>, session: string, disposition: Review['disposition']): Review {
  const lead = report.leads.find(l => l.session === session && l.kind === 'write')!;
  const original = inputs().sessions.find(s => s.key === session)!;
  return { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition, by: 'synthetic-human-reviewer',
    basis: 'Synthetic accepted rule: ask before a scope change; the verdict was read in context', reason: 'Synthetic context review',
    quotes: original.fragments.filter(f => (f.role === 'user' || f.role === 'tool') && lead.evidenceRefs.some(e => e.ref === f.ref)).map(f => ({ ref: f.ref, quote: f.text })) };
}
function screenedReport() {
  const first = analyze(inputs(), manifest);
  return analyze(inputs(), manifest, undefined, [decision(first, 'codex:question-write', 'screened')]);
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
    expect(next.captureDrafts).toEqual([]);
    expect(proposeBatch(next).plan.work).toEqual([]);
    expect(next.leads.every(l => 'change' in l && l.change === 'seen')).toBe(true);
  });

  it.each(['screened', 'dismissed'] as const)('retains an unchanged %s disposition from state without re-supplying the old review file', status => {
    const data = inputs(); const first = analyze(data, manifest);
    const review = decision(first, 'codex:question-write', status);
    const reviewed = analyze(data, manifest, first.state, [review]);
    const next = analyze(data, manifest, reviewed.state);
    expect(next.leads.find(l => l.id === review.leadId)).toMatchObject({ status, change: 'seen' });
    expect(next.captureDrafts).toEqual([]); expect(proposeBatch(next).plan.work).toEqual([]);
  });

  it('keeps confirmations pinned after resume/missing logs and counts confirmation separately from screening', () => {
    const data = inputs(); const first = analyze(data, manifest);
    const screened = analyze(data, manifest, first.state, [decision(first, 'codex:question-write', 'screened')]);
    const confirmed = analyze(data, manifest, screened.state, [decision(first, 'codex:question-write', 'confirmed')]);
    expect(confirmed.summary).toMatchObject({ newFailures: 1, reminders: 0 });
    data.sessions.find(s => s.key === 'codex:question-write')!.fragments.push({ ref: 'resume#1', role: 'user', text: 'Unrelated later turn' });
    const resumed = analyze(data, manifest, confirmed.state);
    expect(resumed.summary).toMatchObject({ confirmed: 1, newFailures: 0 });
    expect(resumed.captureDrafts).toEqual([]);
    expect(proposeBatch(resumed).plan.work).toEqual([]);
    const session = data.sessions.find(s => s.key === 'codex:question-write')!;
    session.calls.push({ ...session.calls[0]!, id: 'resumed-write', ref: 'resume#3' });
    session.fragments.push({ ref: 'resume#3', role: 'tool', text: 'Another map_apply in the resumed incident' });
    const changed = analyze(data, manifest, confirmed.state);
    const changedLead = changed.leads.find(l => l.kind === 'write' && l.session === session.key)!;
    expect(changedLead.evidenceHash).not.toBe(first.leads.find(l => l.id === changedLead.id)!.evidenceHash);
    expect(changedLead).toMatchObject({ status: 'confirmed', change: 'changed' });
    expect(changedLead.confirmation!.evidenceHash).toBe(first.leads.find(l => l.id === changedLead.id)!.evidenceHash);
    expect(changed.summary.newFailures).toBe(0);
    expect(analyze({ sessions: [], calls: [], launches: [], gaps: ['sources missing'], sources: [] }, manifest, confirmed.state).summary.confirmed).toBe(1);
    expect(confirmed.captureDrafts[0]!.humanQuoteRefs.length).toBeGreaterThan(0);
  });

  it('starts a user Skill signal at its invocation without admitting the earlier unrelated human turn', () => {
    const sessions = nativeSessions([
      { type: 'session_meta', payload: { id: 'skill-context' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'EARLIER-UNRELATED-SKILL-SENTINEL' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Unrelated answer' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '$wayfinder Help plan this' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Wayfinder plan reply' }] } },
    ].map((value, i) => ({ value, ref: `skill-context#${i}` })), 'codex', 'skill-context');
    const data = { sessions, calls: [], launches: [], gaps: [], sources: [] };
    const first = analyze(data, manifest); const lead = first.leads.find(l => l.kind === 'skill-only')!;
    expect(lead.evidenceRefs).not.toContainEqual({ ref: 'skill-context#1', role: 'user' });
    const report = analyze(data, manifest, first.state, [{ leadId: lead.id, evidenceHash: lead.evidenceHash, disposition: 'screened', by: 'synthetic', basis: 'synthetic', reason: 'synthetic',
      quotes: [{ ref: 'skill-context#1', quote: 'EARLIER-UNRELATED-SKILL-SENTINEL' }] }]);
    expect(JSON.stringify(report)).not.toContain('EARLIER-UNRELATED-SKILL-SENTINEL');
  });

  it('exports only selected incident excerpts, including after screening, and rejects unrelated quotes', () => {
    const data = inputs(); const source = data.sessions.find(s => s.key === 'codex:question-write')!;
    const sentinel = 'UNRELATED-IN-A-RELATED-SESSION-SENTINEL';
    source.fragments.unshift({ ref: 'irrelevant-before#1', role: 'user', text: sentinel });
    source.fragments.push({ ref: 'irrelevant-after#1', role: 'user', text: sentinel });
    const first = analyze(data, manifest);
    const review = decision(first, source.key, 'confirmed');
    // Small excerpts are enough to locate the relevant words; never export complete source messages by default.
    review.quotes = [{ ...review.quotes[0]!, quote: 'broader scope' }, { ...review.quotes[1]!, quote: 'map_apply' }];
    const report = analyze(data, manifest, first.state, [review]);
    expect(report.summary.confirmed).toBe(1);
    for (const artifact of [report, report.state, report.captureDrafts, proposeBatch(report)]) expect(JSON.stringify(artifact)).not.toContain(sentinel);
    expect(report.leads.find(l => l.id === review.leadId)!.fragments.map(f => f.text)).toEqual(['broader scope', 'map_apply']);
    const invalid = analyze(data, manifest, first.state, [{ ...review, quotes: [{ ref: 'irrelevant-before#1', quote: sentinel }] }]);
    expect(invalid.summary.confirmed).toBe(0); expect(JSON.stringify(invalid)).not.toContain(sentinel);
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
  it('budgets B03b availability probes as well as two readings and arbitration', () => {
    const first = analyze(inputs(), manifest);
    const lead = first.leads.find(l => l.session === 'codex:question-write' && l.kind === 'write')!;
    const screened = analyze(inputs(), manifest, undefined, [{ ...decision(first, lead.session, 'screened') }]);
    const work = proposeBatch(screened).plan.work.filter(w => w.scope.includes(lead.id));
    expect(work.reduce((n,w) => n + w.repetitions + w.extraReviews, 0)).toBe(5);
  });
  it('lists model work and preserves full results and remaining work at the approved ceiling', () => {
    const { plan } = proposeBatch(screenedReport());
    expect(plan.work.some(w => w.kind === 'arbitration')).toBe(true);
    expect(plan.work.filter(w => w.kind === 'reading').reduce((n,w) => n + w.repetitions, 0)).toBe(2);
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
    const plan = proposeBatch(screenedReport()).plan;
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
    expect(() => scanCommand(['--input', join(fixtures, 'input.json'), '--out', fileURLToPath(new URL('./do-not-create', import.meta.url))])).toThrow(/outside/);
    expect(() => scanCommand(['--input', join(fixtures, 'input.json'), '--out', join(root, 'other'), '--approve'])).toThrow();
  });

  it('redacts credentials consistently without copying literal secret lists or authorizing anything', () => {
    const secret = 'synthetic-private-token';
    const value = privateJson({ words: `Bearer ${secret}`, again: secret, api: 'sk-ant-syntheticlongcredential' }, [secret]);
    expect(value).not.toContain(secret);
    expect(value).not.toContain('sk-ant-syntheticlongcredential');
    expect(JSON.parse(value).again).toMatch(/^<secret-/);
  });

  it('prints useful fixed CLI diagnostics without leaking private exception details', () => {
    expect(scanFailure(new ScanError('node'))).toContain('26.3.0');
    expect(scanFailure(new Error('/private/synthetic-secret.json'))).not.toContain('synthetic-secret');
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const child = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    expect(child.status).toBe(1); expect(child.stderr).toContain('usage: scan/cli.ts');
  });
});
