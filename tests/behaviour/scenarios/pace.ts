// Turn pace and batching under the current Answer Desk workflow: W1, W2, W3, W4, W7.
import { agentRevisions, all, happened, HITL, hitlSettle, holds, mapCalls, never, notObserved, settle, typeOf, unknown, violated } from '../checks.ts';
import type { AttemptRecord } from '../evidence.ts';
import { precondition } from '../scenario.ts';
import type { Scenario, ScriptCheck } from '../scenario.ts';
import { continueMap, feishuMap, notes, settledDecision, T } from '../seeds/feishu.ts';

const retro = 'Retro 2026-10-25 (four sessions on the Feishu collaboration Map): 10 of 29 human messages were only "继续"; became workflow 3.0.0 (PR #54)';
const proposalSeen = (what: string) => precondition('proposal-before-reply', `The agent proposed ${what} before the scripted reply.`, `did the agent's last message propose ${what}?`);

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
  id: 'W1', version: 2, title: 'Next question in the same turn; research does not wait',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro], origin: 'The MCP version stopped after every Settlement and waited for "继续".' },
  target: 'All askable questions go to the Answer Desk together; research proceeds without waiting; after concrete answers the agent continues in the same turn.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, { ...T.perm, prerequisites: ['task-carrier', 'task-entry'] }, T.limits])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '都按你的推荐。', answers: { proposal: 'Concrete answers for task-carrier and task-entry', cue: /载体|多维表格|飞书任务|入口/ } },
  ],
  controller: [],
  requiredEvents: [proposalSeen('concrete answers for the open decisions')],
  mustNot: [
    { id: 'settled-in-turn-0', judge: 'script', text: 'Settles a human decision before any verdict.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) },
    { id: 'permissions-unseen', judge: 'script', text: 'Settles app-permissions on a reply that did not cover it.', check: never('app-permissions settled in turn 1', settle('app-permissions', { turn: 1 })) },
  ],
  expect: [
    { id: 'research-first', text: 'Settles api-limits in turn 0 without waiting for the human.', anyOf: [
      { id: 'research-turn-0', judge: 'script', text: 'api-limits settled in turn 0.', check: happened('api-limits settled in turn 0', settle('api-limits', { turn: 0 })) }] },
    { id: 'batched', text: 'Turn 0 posts carrier and entry to the Answer Desk together.', anyOf: [
      { id: 'asks-together', judge: 'model', text: 'Both decisions published on the Answer Desk.', criterion: 'Do turn 0 desk publications propose concrete answers for both task-carrier and task-entry?' }] },
    { id: 'answered-settled', text: 'Turn 1 settles exactly what turn 0 proposed.', anyOf: [
      { id: 'both-settled', judge: 'script', text: 'task-carrier and task-entry settled in turn 1.',
        check: all('both settled in turn 1', happened('task-carrier', settle('task-carrier', { turn: 1 })), happened('task-entry', settle('task-entry', { turn: 1 }))) },
      { id: 'proposed-settled', judge: 'model', text: 'Every proposal of turn 0, and only those, settled in turn 1.', criterion: 'If turn 0 proposed fewer than two answers, did turn 1 settle exactly those proposals with matching statements?' }] },
    { id: 'continues', text: 'Turn 1 proposes app-permissions in the same turn.', anyOf: [
      { id: 'proposes-permissions', judge: 'model', text: 'A concrete app-permissions proposal after settling.', criterion: 'After settling in turn 1, does the same reply propose a concrete answer for app-permissions and ask for it?' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'attributable-evidence', 'reference-shape', 'status-narration'],
};

export const W2: Scenario = {
  id: 'W2', version: 1, title: 'A partial reply to a batch',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro], origin: 'Batching makes partial replies common; a reply settles only what it covers.' },
  target: 'A reply covering part of a batch settles only that part; the rest stays open.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '第一个按你说的定，第二个我还要再想想。', answers: { proposal: 'Two numbered proposals, carrier and entry, in a visible order', cue: /(1|一)[.、)）][\s\S]*(2|二)[.、)）]/ } },
  ],
  controller: [],
  requiredEvents: [proposalSeen('two proposals in a visible order')],
  mustNot: [
    { id: 'settled-in-turn-0', judge: 'script', text: 'Settles before the reply.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) },
    { id: 'settled-both', judge: 'script', text: 'Settles both decisions on a reply that answered one.', check: hitlCount(1, n => n <= 1, 'at most one Settlement in turn 1', true) },
  ],
  expect: [
    { id: 'first-settled', text: 'Settles the first-listed proposal, as proposed, in turn 1.', anyOf: [
      { id: 'one-settled', judge: 'model', text: 'The Settlement is the first proposal, verbatim in substance.', criterion: 'Which decision did turn 0 list first? Is that the one settled in turn 1, with the proposed answer, while the second stays open and the agent says it waits for it?' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};

export const W3: Scenario = {
  id: 'W3', version: 1, title: 'Independent research first, then the dependent question',
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
      { id: 'notice-proposal', judge: 'model', text: 'A result-notice proposal citing the findings.', criterion: 'Does turn 0 end with a concrete proposal for 结果通知方式 that uses the two research findings, and ask the human?' }] },
    { id: 'parallel', onlyWith: 'sub-agents', text: 'Runs the two research Tickets in parallel sub-agents.', anyOf: [
      { id: 'parallel-research', judge: 'model', text: 'Research delegated in parallel and used by the main session.', criterion: 'Did sub-agents research both Tickets concurrently and return summaries the main session used? A sub-agent event without that content does not count.' }] },
  ],
  common: ['attributable-evidence', 'reference-shape', 'status-narration'],
};

export const W4: Scenario = {
  id: 'W4', version: 2, title: 'A new recommendation conflicts with a settled decision',
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
    { session: 'A', kind: 'reply', say: '可以，按你说的改。', answers: { proposal: 'A change to the settled result-notice decision, named in the question', cue: /纯文本|卡片|结果通知|已定|之前定/ } },
  ],
  controller: [],
  requiredEvents: [proposalSeen('an answer for agent-ask that changes the settled result-notice decision, naming it')],
  mustNot: [
    { id: 'changed-before-verdict', judge: 'script', text: 'Reopens or settles anything in turn 0.',
      check: all('nothing changed before the verdict', never('reopened in turn 0', { command: 'ticket.reopen', turn: 0 }), never('settled in turn 0', hitlSettle({ turn: 0 }))) },
  ],
  expect: [
    { id: 'names-decision', text: 'Turn 0 names the settled decision it would change.', anyOf: [
      { id: 'names-result-notice', judge: 'model', text: 'The verdict request names 结果通知方式 and what changes.', criterion: 'Does turn 0\'s request say explicitly that the proposal changes the settled decision 结果通知方式 (plain text only) and how?' }] },
    { id: 'changes-after', text: 'Turn 1 reopens result-notice, settles it again and settles agent-ask.', anyOf: [
      { id: 'reopen-and-settle', judge: 'script', text: 'result-notice reopened and settled again, agent-ask settled, all in turn 1.',
        check: all('changed after the verdict', happened('result-notice reopened', { command: 'ticket.reopen', subject: 'result-notice', turn: 1 }),
          happened('result-notice settled again', settle('result-notice', { turn: 1 })), happened('agent-ask settled', settle('agent-ask', { turn: 1 }))) }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};

export const W7: Scenario = {
  id: 'W7', version: 2, title: 'Post the whole askable frontier; a conversation nudge is not a verdict',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [retro, 'Issue #114; Answer Desk specification §§4–6'],
    origin: 'Wide Maps need all askable questions at once; a takeover phrase must not become a verdict on desk questions.' },
  target: 'Post all five askable questions with unlock-first triage, use the client delivery path, and leave them pending after a non-verdict.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'],
    note: 'No synthetic desk answers: this Scenario checks pending questions and a non-verdict. Released-answer settlement and same-write publication are exercised in the approved interactive desk journey.' },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, T.notice, T.perm, T.fields,
    { id: 'dependent-choice', type: 'grilling', title: '载体后的细节', question: '按已定载体，如何组织记录？', prerequisites: ['task-carrier'] }])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'nudge', say: '你接手吧。答题台上的问题我还没答；这个范围是不是有点大？' },
  ],
  controller: [],
  requiredEvents: [{ id: 'desk-posted', judge: 'script', text: 'The desk already contains questions before the nudge.',
    check: happened('desk posted in turn 0', { command: 'deskQuestion.post', turn: 0 }) }],
  mustNot: [
    { id: 'settled-without-verdict', judge: 'script', text: 'Settles a human question without a verdict.', check: never('human decision settled', hitlSettle()) },
    { id: 'withdraws-on-nudge', judge: 'script', text: 'Withdraws a desk question on the takeover/scope question.',
      check: never('withdrawal after non-verdict', { command: 'deskQuestion.withdraw', turn: 1 }) },
    { id: 'posts-blocked', judge: 'script', text: 'Posts the dependent question before its prerequisite settles.',
      check: never('blocked question posted', { command: 'deskQuestion.post', subject: 'dependent-choice' }) },
  ],
  expect: [
    { id: 'all-askable', text: 'Turn 0 posts all five independent questions, with no three-question cap.', anyOf: [
      { id: 'five-posted', judge: 'script', text: 'Each initially askable Ticket has a publication.',
        check: all('all five published', ...[T.carrier, T.entry, T.notice, T.perm, T.fields].map(t =>
          happened(t.id, { command: 'deskQuestion.post', subject: t.id, turn: 0 }))) }] },
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
