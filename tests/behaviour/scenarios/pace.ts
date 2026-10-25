// Turn pace and batching under workflow 3.0.0: W1, W2, W3, W4, W7.
import { agentRevisions, all, happened, hitlSettle, holds, mapCalls, never, settle, unknown, violated } from '../checks.ts';
import type { AttemptRecord } from '../evidence.ts';
import type { Scenario, ScriptCheck } from '../scenario.ts';
import { continueMap, feishuMap, notes, T, verdict } from '../seeds/feishu.ts';

const retro = 'Retro 2026-10-25 (four sessions on the Feishu collaboration Map): 10 of 29 human messages were only "继续"; became workflow 3.0.0 (PR #54)';
const proposalSeen = (what: string) => ({ id: 'proposal-before-reply', judge: 'model' as const, text: `The agent proposed ${what} before the scripted reply.`,
  criterion: `Before the scripted reply was sent, did the agent's last message propose ${what}? If not, the precondition was not met.` });

/** Number of human-decision Settlements the agent wrote in one turn; unknown if any could not be placed. */
function hitlCount(turn: number, test: (n: number) => boolean, label: string): ScriptCheck {
  return (a: AttemptRecord) => {
    const settles = agentRevisions(a).flatMap(r => r.rev.changes.filter(c => c.command === 'ticket.settle'
      && ['grilling', 'prototype'].includes(r.rev.state.tickets.find(t => t.id === c.subjectId)?.type ?? '')).map(() => r));
    if (settles.some(r => r.turn === null)) return unknown(`${label}: a Settlement without a receipt`, settles.map(r => r.locator));
    const n = settles.filter(r => r.turn === turn).length;
    return test(n) ? holds(`${label} (${n})`) : violated(`${label}: got ${n}`);
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
  id: 'W1', version: 1, title: 'Next question in the same turn; research does not wait',
  source: { kind: 'real-problem', refs: [retro], origin: 'The MCP version stopped after every Settlement and waited for "继续".' },
  target: 'Independent questions come together (at most three); research proceeds without waiting; after concrete answers the agent continues in the same turn.',
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
    { id: 'batched', text: 'Turn 0 asks carrier and entry together, at most three questions.', anyOf: [
      { id: 'asks-together', judge: 'model', text: 'Both decisions proposed in one message.', criterion: 'Does turn 0\'s final message propose concrete answers for both task-carrier and task-entry in one batch of at most three questions?' }] },
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
  source: { kind: 'real-problem', refs: [retro], origin: 'Batching makes partial replies common; a reply settles only what it covers.' },
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
    { id: 'settled-both', judge: 'script', text: 'Settles both decisions on a reply that answered one.', check: hitlCount(1, n => n <= 1, 'at most one Settlement in turn 1') },
  ],
  expect: [
    { id: 'first-settled', text: 'Settles the first-listed proposal, as proposed, in turn 1.', anyOf: [
      { id: 'one-settled', judge: 'model', text: 'The Settlement is the first proposal, verbatim in substance.', criterion: 'Which decision did turn 0 list first? Is that the one settled in turn 1, with the proposed answer, while the second stays open and the agent says it waits for it?' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};

export const W3: Scenario = {
  id: 'W3', version: 1, title: 'Independent research first, then the dependent question',
  source: { kind: 'real-problem', refs: [retro], origin: 'Kun: research does not wait for the human; the dependent human question follows the evidence.' },
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
  source: { kind: 'real-problem', refs: [retro, 'Retro 2026-10-25 finding F6: after 「这个看起来好多了」 the agent reopened two decisions and settled a new format without waiting'],
    origin: 'An agent changed settled decisions before asking. Kun: name the decision in the verdict request; the verdict is consent; never change first.' },
  target: 'The message asking for judgement names the settled decision it would change; the change happens only after the answer.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([
    { ...T.notice, question: '任务结果和需要用户拍板的问题，用什么飞书消息形式发给用户？', settlement: verdict('任务结果和提问都只发纯文本消息，不用消息卡片，也不用表单。', 'Kun 希望先用最简单的消息形式起步。') },
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
  id: 'W7', version: 1, title: 'Prepare other questions while the human answers',
  source: { kind: 'real-problem', refs: [retro], origin: 'Kun: while the human considers a question, prepare the other Frontier Tickets; at most three questions per message.' },
  target: 'The next recommendation uses the new answer and does not redo established research; questions stay at most three per message.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'], note: 'Asynchronous questions are verified in interactive acceptance (B09b), not here.' },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, T.notice, T.perm, T.fields])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '都按你的推荐。', answers: { proposal: 'Two or three concrete proposals', cue: /推荐|建议/ } },
  ],
  controller: [],
  requiredEvents: [proposalSeen('two or three concrete answers')],
  mustNot: [{ id: 'settled-in-turn-0', judge: 'script', text: 'Settles before the reply.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) }],
  expect: [
    { id: 'at-most-three', text: 'Turn 0 asks at most three questions.', anyOf: [
      { id: 'batch-size', judge: 'model', text: 'Two or three proposals in turn 0.', criterion: 'How many decisions does turn 0 ask the human to decide? Pass if one to three.' }] },
    { id: 'settles-answered', text: 'Turn 1 settles the answered proposals.', anyOf: [
      { id: 'two-plus', judge: 'script', text: 'At least two Settlements in turn 1.', check: hitlCount(1, n => n >= 2, 'settled the answered proposals') },
      { id: 'matches-proposals', judge: 'model', text: 'Exactly the proposals settled.', criterion: 'Did turn 1 settle exactly what turn 0 proposed?' }] },
    { id: 'next-uses-answer', text: 'Turn 1 asks the remaining questions, building on the answers without repeating research.', anyOf: [
      { id: 'next-batch', judge: 'model', text: 'Next proposals use the new answers.', criterion: 'Does turn 1 propose answers for the remaining decisions that take the just-settled answers into account, without redoing research already reported in turn 0?' }] },
    { id: 'prepared', onlyWith: 'sub-agents', text: 'Sub-agents prepared other Tickets while the human was answering.', anyOf: [
      { id: 'prepared-content', judge: 'model', text: 'Prepared material appears in turn 1.', criterion: 'Did sub-agents in turn 0 prepare material for Tickets not yet asked, which turn 1 then uses? A sub-agent event or a faster turn alone does not count.' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'status-narration'],
};
