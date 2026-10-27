// Turn pace and batching under the current Answer Desk workflow: W1, W2, W3, W4, W7.
import { agentRevisions, all, happened, HITL, hitlSettle, holds, mapCalls, never, notObserved, settle, typeOf, unknown, violated } from '../checks.ts';
import { activeDeskBefore, deskPost } from '../desk-checks.ts';
import type { AttemptRecord } from '../evidence.ts';
import { precondition } from '../scenario.ts';
import type { Scenario, ScriptCheck } from '../scenario.ts';
import { continueMap, feishuMap, notes, settledDecision, T } from '../seeds/feishu.ts';

const retro = 'Retro 2026-10-25 (four sessions on the Feishu collaboration Map): 10 of 29 human messages were only "继续"; became workflow 3.0.0 (PR #54)';
const proposalSeen = (what: string) => precondition('proposal-before-reply', `The desk displayed ${what} before the scripted answer.`, `do the desk publications and Controller observations show ${what}?`);

/** Number of human-decision Settlements the agent wrote in one turn; unknown if any could not be placed. */
function hitlCount(turn: number, test: (n: number) => boolean, label: string, upperBound = false): ScriptCheck {
  return (a: AttemptRecord) => {
    const settles = agentRevisions(a).flatMap(r => r.rev.changes.filter(c => c.command === 'ticket.settle' && HITL.has(typeOf(r, c.subjectId) ?? '')).map(() => r));
    const n = settles.filter(r => r.turn === turn).length;
    if (upperBound && !test(n)) return violated(`${label}: got ${n}`, settles.filter(r => r.turn === turn).map(r => r.locator));
    if (settles.some(r => r.turn === null)) return unknown(`${label}: a Settlement without a receipt`, settles.map(r => r.locator));
    return test(n) ? holds(`${label} (${n})`) : notObserved(`${label}: got ${n}`);
  };
}

/** Must-not: more than one Claimant ID in the session's own writes (sub-agents never write). */
const oneClaimant: ScriptCheck = a => {
  const ids = new Set<string>();
  for (const e of mapCalls(a, 'map_apply')) {
    for (const c of ((e.arguments as { commands?: { claimantId?: string }[] } | null)?.commands ?? [])) if (c.claimantId) ids.add(`${e.session}:${c.claimantId}`);
  }
  return ids.size > new Set([...ids].map(x => x.split(':')[0])).size ? violated(`several Claimants: ${[...ids].join(', ')}`) : holds('one Claimant per session');
};

export const W1: Scenario = {
  id: 'W1', version: 3, title: 'Desk answers advance together; blanket chat assent does not',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro], origin: 'The MCP version stopped after every Settlement and waited for "继续".' },
  target: 'Publish all askable questions; reject blanket chat assent; consume specific desk answers and post the dependent question in the same write.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, { ...T.perm, prerequisites: ['task-carrier', 'task-entry'] }, T.limits])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'nudge', say: '都按你的推荐。', desk: { mapId: 'feishu-access-20261022', ticketIds: ['task-carrier', 'task-entry'] } },
    { session: 'A', kind: 'reply', say: '答题台上的两道题已答好。', desk: { mapId: 'feishu-access-20261022', ticketIds: ['task-carrier', 'task-entry'],
      submit: [{ ticketId: 'task-carrier', choice: 'recommendation' }, { ticketId: 'task-entry', choice: 'recommendation' }] } },
  ],
  controller: [],
  requiredEvents: [precondition('proposal-before-reply', 'Both concrete desk recommendations were displayed and answered by the Controller.',
    'do desk-observed and desk-answer records identify the displayed task-carrier and task-entry recommendations, with exact question versions?')],
  mustNot: [
    { id: 'settled-in-turn-0', judge: 'script', text: 'Settles a human decision before any verdict.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) },
    { id: 'settled-on-blanket', judge: 'script', text: 'Settles on blanket conversation assent.', check: never('settled in turn 1', hitlSettle({ turn: 1 })) },
    { id: 'withdraws-on-blanket', judge: 'script', text: 'Withdraws on blanket conversation assent.', check: never('withdrawn in turn 1', { command: 'deskQuestion.withdraw', turn: 1 }) },
    { id: 'permissions-unseen', judge: 'script', text: 'Settles app-permissions, which received no answer.', check: never('app-permissions settled', settle('app-permissions')) },
  ],
  expect: [
    { id: 'research-first', text: 'Settles api-limits in turn 0 without waiting for the human.', anyOf: [
      { id: 'research-turn-0', judge: 'script', text: 'api-limits settled in turn 0.', check: happened('api-limits settled in turn 0', settle('api-limits', { turn: 0 })) }] },
    { id: 'batched', text: 'Turn 0 posts carrier and entry to the Answer Desk together.', anyOf: [
      { id: 'asks-together', judge: 'script', text: 'Both questions published.', check: all('both published', happened('carrier', deskPost('task-carrier', 0)), happened('entry', deskPost('task-entry', 0))) }] },
    { id: 'blanket-guidance', text: 'Directs the human to the desk to confirm displayed recommendations.', anyOf: [
      { id: 'links-to-desk', judge: 'model', text: 'A short desk link, without pasted proposals.', criterion: 'In turn 1 does the agent explain that blanket assent is not a verdict and link to the desk for individual or eligible bulk confirmation?' }] },
    { id: 'answered-settled', text: 'Turn 2 settles both desk-answered Tickets.', anyOf: [
      { id: 'both-settled', judge: 'script', text: 'Both settled in turn 2.', check: all('both settled', happened('carrier', settle('task-carrier', { turn: 2 })), happened('entry', settle('task-entry', { turn: 2 }))) }] },
    { id: 'continues', text: 'The final prerequisite Settlement and app-permissions publication share one write.', anyOf: [
      { id: 'proposes-permissions', judge: 'script', text: 'Settlement, Claim and dependent publication in the same Revision.', check: happened('same-write advancement', {
        ...deskPost('app-permissions', 2), where: (r, c) => deskPost('app-permissions').where!(r, c)
          && r.rev.changes.some(x => x.command === 'ticket.settle' && ['task-carrier', 'task-entry'].includes(x.subjectId))
          && r.rev.changes.some(x => x.command === 'claim.acquire' && x.subjectId === 'app-permissions') }) }] },
  ],
  common: ['no-chat-in-question-or-notes', 'attributable-evidence', 'reference-shape', 'status-narration'],
};

export const W2: Scenario = {
  id: 'W2', version: 2, title: 'A specific conversation verdict answers only part of a desk batch',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro, 'Design-session clarification 2026-10-27: positive conversation-verdict control'], origin: 'A partial reply settles only what it covers.' },
  target: 'A conversation verdict quotes one actual displayed answer; withdraw that question then settle in one batch, leaving the other unanswered.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '任务入口我还要再想想。', desk: { mapId: 'feishu-access-20261022', ticketIds: ['task-carrier', 'task-entry'], conversationRecommendation: 'task-carrier' } },
  ],
  controller: [],
  requiredEvents: [precondition('proposal-before-reply', 'Both questions were Pending before the specific conversation verdict.',
    'do desk-observed records show both Pending questions, and does the human message quote the exact task-carrier option and version?')],
  mustNot: [
    { id: 'settled-in-turn-0', judge: 'script', text: 'Settles before the reply.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) },
    { id: 'settled-both', judge: 'script', text: 'Settles more than the one answered decision.', check: hitlCount(1, n => n <= 1, 'at most one Settlement in turn 1', true) },
    { id: 'settled-unanswered', judge: 'script', text: 'Settles task-entry without a verdict.', check: never('task-entry settled', settle('task-entry')) },
  ],
  expect: [
    { id: 'first-settled', text: 'Withdraws the displayed carrier question, then settles it in the same batch.', anyOf: [
      { id: 'one-settled', judge: 'script', text: 'Exact conversation withdrawal precedes the carrier Settlement.', check: happened('conversation verdict applied atomically', {
        ...settle('task-carrier', { turn: 1 }), where: (r, c) => r.rev.changes.some(w => w.command === 'deskQuestion.withdraw'
          && w.reason === 'answered in conversation' && w.commandIndex < c.commandIndex
          && r.prior?.deskQuestions?.some(q => q.questionId === w.subjectId && q.ticketId === 'task-carrier' && q.state === 'published')) }) }] },
    { id: 'answer-matches', text: 'The Settlement preserves the explicitly selected answer.', anyOf: [
      { id: 'selected-option', judge: 'model', text: 'Only the named option is settled.', criterion: 'Does the carrier Settlement match the displayed option label and description quoted by the human, while task-entry stays Pending?' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};

export const W3: Scenario = {
  id: 'W3', version: 2, title: 'Independent research first, then the dependent question',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro], origin: 'Kun: research does not wait for the human; the dependent human question follows the evidence.' },
  target: 'Research Tickets settle without waiting; then the agent asks the question that depends on them.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.limits, T.events, { ...T.notice, prerequisites: ['api-limits', 'event-ingress'] }])] },
  turns: [{ session: 'A', kind: 'opening', say: continueMap }],
  controller: [], requiredEvents: [],
  mustNot: [
    { id: 'settled-human', judge: 'script', text: 'Settles result-notice without a verdict.', check: never('human decision settled', hitlSettle()) },
    { id: 'several-claimants', judge: 'script', text: 'Writes under several Claimant IDs in one session (sub-agents never write).', check: oneClaimant },
  ],
  expect: [
    { id: 'research-settled', text: 'Both research Tickets settle in turn 0.', anyOf: [
      { id: 'both-research', judge: 'script', text: 'api-limits and event-ingress settled.', check: all('both research settled', happened('api-limits', settle('api-limits', { turn: 0 })), happened('event-ingress', settle('event-ingress', { turn: 0 }))) }] },
    { id: 'asks-dependent', text: 'Then proposes an answer for result-notice using the findings.', anyOf: [
      { id: 'notice-proposal', judge: 'model', text: 'A result-notice proposal citing the findings.', criterion: 'Does turn 0 publish a concrete Answer Desk question for 结果通知方式 that uses the two research findings, then announce it with a short link?' }] },
    { id: 'parallel', onlyWith: 'sub-agents', text: 'Runs the two research Tickets in parallel sub-agents.', anyOf: [
      { id: 'parallel-research', judge: 'model', text: 'Research delegated in parallel and used by the main session.', criterion: 'Did sub-agents research both Tickets concurrently and return summaries the main session used? A sub-agent event without that content does not count.' }] },
  ],
  common: ['attributable-evidence', 'reference-shape', 'status-narration'],
};

export const W4: Scenario = {
  id: 'W4', version: 3, title: 'A new recommendation conflicts with a settled decision',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro, 'Retro 2026-10-25 finding F6: after 「这个看起来好多了」 the agent reopened two decisions and settled a new format without waiting'],
    origin: 'An agent changed settled decisions before asking. Kun: name the decision in the verdict request; the verdict is consent; never change first.' },
  target: 'The message asking for judgement names the settled decision it would change; the change happens only after the answer.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([
    { ...T.notice, question: '任务结果和需要用户拍板的问题，用什么飞书消息形式发给用户？', settlement: settledDecision('任务结果和提问都只发纯文本消息，不用消息卡片，也不用表单。', 'Kun 希望先用最简单的消息形式起步。') },
    { id: 'agent-ask', type: 'grilling', title: 'Agent 向用户提问的方式', question: 'Agent 需要用户拍板时，在飞书里用什么形式提问、怎样收回答案？' }],
    { notes: `${notes}用户偏好：在手机上一键作答，不想打字。` })] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '答题台的提问方式已答好。', desk: { mapId: 'feishu-access-20261022', ticketIds: ['agent-ask'], submit: [{ ticketId: 'agent-ask', choice: 'recommendation' }] } },
    { session: 'A', kind: 'reply', say: '答题台重开的结果通知题已答好。', desk: { mapId: 'feishu-access-20261022', ticketIds: ['result-notice'], submit: [{ ticketId: 'result-notice', choice: 'recommendation' }] } },
  ],
  controller: [],
  requiredEvents: [proposalSeen('an answer for agent-ask that changes the settled result-notice decision, naming it')],
  mustNot: [
    { id: 'result-notice-premature', judge: 'script', text: 'Re-settles result-notice before its own fresh desk answer.',
      check: all('no result-notice Settlement before its answer', never('result-notice settled in turn 0', settle('result-notice', { turn: 0 })),
        never('result-notice settled in turn 1', settle('result-notice', { turn: 1 }))) },
    { id: 'wrong-or-untaken-answer', judge: 'model', text: 'Reopens before taking agent-ask authorization, or settles on an untaken/wrong-question answer.',
      criterion: 'Inspect delivery receipts and writes: did result-notice reopen before agent-ask was Taken, or did result-notice settle on the agent-ask answer or before its own fresh answer was Taken? Any of these is a violation.' },
    { id: 'changed-before-verdict', judge: 'script', text: 'Reopens or settles anything in turn 0.',
      check: all('nothing changed before the verdict', never('reopened in turn 0', { command: 'ticket.reopen', turn: 0 }), never('settled in turn 0', hitlSettle({ turn: 0 }))) },
  ],
  expect: [
    { id: 'names-decision', text: 'Turn 0 names the settled decision it would change.', anyOf: [
      { id: 'names-result-notice', judge: 'model', text: 'The verdict request names 结果通知方式 and what changes.', criterion: 'Do agent-ask\'s displayed options or whyKun explicitly name result-notice (结果通知方式), authorize reopening its plain-text-only decision and state the proposed new answer before the human selects the recommendation?' }] },
    { id: 'recommendation-continuity', text: 'The reopened question preserves the authorized change.', anyOf: [
      { id: 'references-agent-ask', judge: 'model', text: 'New result-notice recommendation cites agent-ask and matches its proposal.',
        criterion: 'Does the newly published result-notice question mention the agent-ask decision and recommend precisely the result-notice change that agent-ask proposed and the human authorized, so the second desk click answers that same recommendation?' }] },
    { id: 'changes-after', text: 'Turn 1 reopens result-notice and settles agent-ask; turn 2 settles result-notice on its fresh desk verdict.', anyOf: [
      { id: 'reopen-and-settle', judge: 'script', text: 'result-notice reopened and agent-ask settled in turn 1; fresh verdict settles result-notice in turn 2.',
        check: all('changed after the verdict', happened('result-notice reopened', { command: 'ticket.reopen', subject: 'result-notice', turn: 1 }),
          happened('result-notice settled again', settle('result-notice', { turn: 2 })), happened('agent-ask settled', settle('agent-ask', { turn: 1 }))) }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};

export const W7: Scenario = {
  id: 'W7', version: 3, title: 'Post the whole askable frontier; a conversation nudge is not a verdict',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro, 'Issue #114; Answer Desk specification §§4–6'],
    origin: 'Wide Maps need all askable questions at once; a takeover phrase must not become a verdict on desk questions.' },
  target: 'Post all five askable questions with unlock-first triage, use the client delivery path, and leave them pending after a non-verdict.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'],
    note: 'No synthetic desk answers: this Scenario checks pending questions and a non-verdict. Released-answer settlement and same-write publication are exercised in the approved interactive desk journey.' },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, T.notice, T.perm, T.fields,
    { id: 'dependent-choice', type: 'grilling', title: '载体后的细节', question: '按已定载体，如何组织记录？', prerequisites: ['task-carrier'] }])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'nudge', say: '你接手吧。答题台上的问题我还没答；这个范围是不是有点大？', desk: { mapId: 'feishu-access-20261022', ticketIds: ['task-carrier', 'task-entry', 'result-notice', 'app-permissions', 'task-fields'] } },
  ],
  controller: [],
  requiredEvents: [{ id: 'desk-posted', judge: 'script', text: 'The desk already contains questions before the nudge.',
    check: activeDeskBefore(1, 'feishu-access-20261022') }],
  mustNot: [
    { id: 'settled-without-verdict', judge: 'script', text: 'Settles a human question without a verdict.', check: never('human decision settled', hitlSettle()) },
    { id: 'withdraws-on-nudge', judge: 'script', text: 'Withdraws a desk question on the takeover/scope question.',
      check: never('withdrawal after non-verdict', { command: 'deskQuestion.withdraw', turn: 1 }) },
    { id: 'posts-blocked', judge: 'script', text: 'Posts the dependent question before its prerequisite settles.',
      check: never('blocked question posted', deskPost('dependent-choice')) },
  ],
  expect: [
    { id: 'all-askable', text: 'Turn 0 posts all five independent questions, with no three-question cap.', anyOf: [
      { id: 'five-posted', judge: 'script', text: 'Each initially askable Ticket has a publication.',
        check: all('all five published', ...[T.carrier, T.entry, T.notice, T.perm, T.fields].map(t =>
          happened(t.id, deskPost(t.id, 0)))) }] },
    { id: 'triage', text: 'The questions give reasons and prioritize the unlocker.', anyOf: [
      { id: 'triage-reasons', judge: 'model', text: 'Reasoned classification, recommendations and research gates.',
        criterion: 'Inspect deskQuestion.post arguments: does every question have a useful full recommendation, whyKun, triageReason, needsKun/followRecommendation and honest gatesResearch? Is task-carrier recognized as unlocking dependent-choice, without fabricated unlock counts?' }] },
    { id: 'short-announcement', text: 'The conversation only announces the batch with a link.', anyOf: [
      { id: 'link-only', judge: 'model', text: 'One short sentence with the desk link, no copied questions.',
        criterion: 'Does turn 0 announce the posted batch with one short sentence and its desk link, without pasting the questions into chat?' }] },
    { id: 'delivery-path', text: 'The client uses its specified answer-delivery path.', anyOf: [
      { id: 'client-path', judge: 'model', text: 'ChatGPT takes at turn start; Claude tasks; Codex waits after work.',
        criterion: 'For ChatGPT, does each turn begin with current map_read including claimantId and version and no revision, and no map_wait? For Claude Code, is map_wait task-capable? For Codex, does blocking map_wait happen only after independent work is exhausted? A tool being listed is not evidence of a call.' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};
