import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze.ts';
import { loadInputs, nativeSessions } from './read.ts';
import type { Manifest, Review } from './types.ts';

const fixtures = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));
const filename = 'claude-ask-user-question.jsonl';
const manifest: Manifest = { schema: 'wayfinder-usage-input/1', sources: [{ id: 'claude', kind: 'claude', path: filename }] };
const ref = (line: number) => `claude/${filename}#L${line}`;
const answer = '方案 A\n只更新当前 Ticket。\n保留其他问题，明天再讨论。';
const rows = () => readFileSync(new URL(`../fixtures/scan/${filename}`, import.meta.url), 'utf8').trim().split('\n')
  .map((line, i) => ({ ref: ref(i + 1), value: JSON.parse(line) }));

describe('Claude AskUserQuestion answers (Issue #104 structure, synthetic words)', () => {
  it('keeps only answer values and notes as human words, located at the result row', () => {
    const session = loadInputs(manifest, fixtures).sessions[0]!;
    expect(session.fragments.filter(f => f.role === 'user')).toEqual([
      { ref: ref(1), role: 'user', text: '先比较两个方案，等我回答再写入。' },
      { ref: ref(3), role: 'user', text: answer },
    ]);
    expect(session.fragments.find(f => f.ref === ref(2))).toMatchObject({ role: 'assistant' });
    expect(session.fragments.find(f => f.ref === ref(2))!.text).toContain('采用哪个方案？');
    expect(session.fragments.find(f => f.ref === ref(5))).toBeUndefined();
    expect(session.fragments.find(f => f.ref === ref(7))).toMatchObject({ role: 'tool' });
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]).toMatchObject({ id: 'write-choice', tool: 'map_apply', result: 'committed', resultRef: ref(7) });
  });

  it('uses the answer as the preceding human turn and permits dismissal with the answer and write', () => {
    const data = loadInputs(manifest, fixtures);
    const first = analyze(data, manifest);
    const lead = first.leads.find(l => l.kind === 'write')!;
    expect(lead.status).toBe('pending');
    expect(lead.evidenceRefs.filter(e => e.role === 'user')).toEqual([{ ref: ref(3), role: 'user' }]);
    const review: Review = { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition: 'dismissed',
      by: 'synthetic-reviewer', basis: 'Synthetic rule: settle only after the human chooses the proposed answer',
      reason: 'The selected answer authorizes this write', quotes: [
        { ref: ref(3), quote: answer }, { ref: ref(6), quote: 'ticket.settle' },
      ] };
    const reviewed = analyze(data, manifest, undefined, [review]);
    expect(reviewed.leads.find(l => l.id === lead.id)).toMatchObject({ status: 'dismissed', hasHumanWords: true });
    expect(reviewed.summary.newFailures).toBe(0);
    expect(reviewed.reviews).toEqual([review]);
    expect(reviewed.captureDrafts.some(d => d.leadId === lead.id)).toBe(false);
    const questionQuote = { ...review, quotes: [{ ref: ref(3), quote: '采用哪个方案？' }, review.quotes[1]!] };
    expect(analyze(data, manifest, undefined, [questionQuote]).leads.find(l => l.id === lead.id)!.status).toBe('pending');
  });

  it('takes structured answers rather than parsing the tool summary or copying question keys', () => {
    const input = rows();
    input[2]!.value.message.content[0].content = 'The user answered: "Agent question"="Different summary"';
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toEqual({ ref: ref(3), role: 'user', text: answer });
  });

  it('keeps question order rather than answers-map insertion order', () => {
    const input = rows();
    input[2]!.value.toolUseResult.answers = Object.fromEntries(Object.entries(input[2]!.value.toolUseResult.answers).reverse());
    expect(nativeSessions(input, 'claude', filename)[0]!.fragments.find(f => f.ref === ref(3))!.text).toBe(answer);
  });

  it('does not turn an answer starting with @wayfinder into a Skill invocation', () => {
    const input = rows();
    input[2]!.value.toolUseResult.answers = { '采用哪个方案？': '@wayfinder is the label I choose.' };
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toEqual({ ref: ref(3), role: 'user', text: '@wayfinder is the label I choose.' });
    expect(session.skill).toEqual([]);
  });

  it('lists the synthetic sample in the fixture catalog', () => {
    expect(readFileSync(new URL('../fixtures/scan/README.md', import.meta.url), 'utf8')).toContain(`| \`${filename}\` |`);
  });

  it('matches the call ID even when another question was asked more recently', () => {
    const input = rows();
    const later = structuredClone(input[1]!);
    later.ref = 'claude#later-question';
    later.value.message.content[0].id = 'ask-another-choice';
    later.value.message.content[0].input.questions = [{ question: '另一个问题？' }];
    input.splice(2, 0, later);
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toEqual({ ref: ref(3), role: 'user', text: answer });
  });

  it('preserves free text verbatim, and only includes notes for answered questions', () => {
    const input = rows();
    const freeText = '我选 "其他" = A, B\n保持引号和换行。';
    input[2]!.value.toolUseResult.answers = { '采用哪个方案？': freeText };
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toEqual({ ref: ref(3), role: 'user', text: freeText });
  });

  it('keeps a string-only result as tool evidence even when it claims the user answered', () => {
    const input = rows();
    input[2]!.value.toolUseResult = 'User declined';
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toMatchObject({ role: 'tool' });
  });

  it('does not guess which result owns row-level answers when several results share a row', () => {
    const input = rows();
    input[2]!.value.message.content.push({ type: 'tool_result', tool_use_id: 'other', content: 'Other output' });
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.filter(f => f.ref === ref(3)).map(f => f.role)).toEqual(['tool']);
  });

  it.each([undefined, null, {}, { '采用哪个方案？': '' }, { '采用哪个方案？': '  ' },
    { '采用哪个方案？': null }, { '采用哪个方案？': ['方案 A'] }, { '采用哪个方案？': { unexpected: '方案 A' } },
  ])('keeps a result without recognized answers as tool evidence (%j)', answers => {
    const input = rows();
    input[2]!.value.toolUseResult.answers = answers;
    input[2]!.value.message.content[0].content = 'User cancelled or declined the question';
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.find(f => f.ref === ref(3))).toEqual({
      ref: ref(3), role: 'tool', text: 'User cancelled or declined the question',
    });
    expect(session.fragments.filter(f => f.role === 'user').map(f => f.ref)).toEqual([ref(1)]);
  });

  it.each(['Read', 'Bash', 'Skill', 'mcp__other__AskUserQuestion', 'mcp__wayfinder__map_read'])
  ('does not attribute %s results to the human even with an answers-shaped payload', name => {
    const input = rows();
    input[1]!.value.message.content[0].name = name;
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.some(f => f.ref === ref(3) && f.role === 'user')).toBe(false);
    expect(session.fragments.filter(f => f.role === 'user').map(f => f.ref)).toEqual([ref(1)]);
  });

  it.each(['unmatched-id', 'missing-id', 'other-session', 'sidechain', 'error', 'meta', 'assistant', 'later-call'] as const)
  ('does not promote an answer without a prior valid user exchange: %s', condition => {
    const input = rows();
    const result = input[2]!.value;
    if (condition === 'unmatched-id') result.message.content[0].tool_use_id = 'unknown';
    if (condition === 'missing-id') { delete result.message.content[0].tool_use_id; delete input[1]!.value.message.content[0].id; }
    if (condition === 'other-session') result.sessionId = 'other-session';
    if (condition === 'sidechain') { result.isSidechain = true; result.agentId = 'child'; }
    if (condition === 'error') result.message.content[0].is_error = true;
    if (condition === 'meta') result.isMeta = true;
    if (condition === 'assistant') result.type = 'assistant';
    if (condition === 'later-call') [input[1], input[2]] = [input[2]!, input[1]!];
    const fragments = nativeSessions(input, 'claude', filename).flatMap(s => s.fragments);
    expect(fragments.some(f => f.ref === ref(3) && f.role === 'user')).toBe(false);
    expect(fragments.filter(f => f.role === 'user').map(f => f.ref)).toEqual([ref(1)]);
  });

  it.each(['Read', 'Bash', 'Skill', 'mcp__other__AskUserQuestion'])
  ('preserves the omission of untracked %s tool results', name => {
    const input = rows();
    input[1]!.value.message.content[0].name = name;
    const session = nativeSessions(input, 'claude', filename)[0]!;
    expect(session.fragments.filter(f => f.ref === ref(3))).toEqual([]);
  });

  it.each(['dismissed', 'confirmed'] as const)('rejects unrelated tool output sharing a write result row as %s action evidence', disposition => {
    const original = rows();
    const input = rows();
    const unrelatedOutput = input[4]!.value.message.content[0].content;
    input[6]!.value.message.content.push(input[4]!.value.message.content[0]);
    input.splice(4, 1);
    const data = { sessions: nativeSessions(input, 'claude', filename), calls: [], launches: [], gaps: [], sources: [] };
    const first = analyze(data, manifest);
    const lead = first.leads.find(l => l.kind === 'write')!;
    const review: Review = { leadId: lead.id, evidenceHash: lead.evidenceHash, disposition,
      by: 'synthetic-reviewer', basis: 'Synthetic accepted rule: require human and native action evidence',
      reason: 'Try to substitute a Read result for action evidence', quotes: [
        { ref: ref(3), quote: answer }, { ref: ref(7), quote: unrelatedOutput },
      ] };
    const reviewed = analyze(data, manifest, undefined, [review]);
    expect(reviewed.leads.find(l => l.id === lead.id)!.status).toBe('pending');
    expect(reviewed.reviews).toEqual([]);
    expect(data.sessions[0]!.fragments.filter(f => f.ref === ref(7))).toEqual([
      { ref: ref(7), role: 'tool', text: '{"kind":"committed","revision":2}' },
    ]);
    const baseline = analyze({ ...data, sessions: nativeSessions(original, 'claude', filename) }, manifest);
    expect(lead.evidenceHash).toBe(baseline.leads.find(l => l.kind === 'write')!.evidenceHash);
  });

  it('preserves Codex message and event reply handling with mirror de-duplication', () => {
    const input = [
      { type: 'session_meta', payload: { id: 'synthetic-codex-reply' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'ask', name: 'request_user_input', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'ask', output: '{"answers":{"choice":"方案 A"}}' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '方案 A' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '方案 A' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '保留其他问题' } },
    ].map((value, i) => ({ value, ref: `codex#L${i + 1}` }));
    expect(nativeSessions(input, 'codex', 'codex')[0]!.fragments).toEqual([
      { ref: 'codex#L4', role: 'user', text: '方案 A' }, { ref: 'codex#L6', role: 'user', text: '保留其他问题' },
    ]);
  });
});
