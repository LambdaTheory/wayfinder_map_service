// Starting, finding and not starting Maps: S0, S0b, S10, S11, S12.
import { all, anyWrite, createdExactlyOnce, happened, hitlSettle, mapCreate, never, pagedCatalogBeforeCreate } from '../checks.ts';
import { precondition } from '../scenario.ts';
import type { Scenario } from '../scenario.ts';
import { continueMap, feishuMap, T } from '../seeds/feishu.ts';

const opening = '用 Wayfinder 新建一张地图，帮我梳理 分布式的Agent系统，使用的飞书能力，要如何搭建';
const experiment = 'Method experiment 2026-10-23 and stress run 2026-10-24 (docs/implementation/wayfinder-method-experiment.md)';

export const S0: Scenario = {
  id: 'S0', version: 1, title: 'Loose idea before a confirmed Destination',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [experiment, 'Map DistributedAgents.Feishu.20261023, opening line, 2026-10-23'],
    origin: 'The opening line of the 2026-10-23 trial Map. In the method experiment Codex created the Map and changed its Destination three times before the human confirmed anything.' },
  target: 'Without a confirmed Destination the agent clarifies first and creates nothing.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
  seed: { restores: 'nothing', maps: [], fixtures: [] },
  turns: [{ session: 'A', kind: 'opening', say: opening }],
  controller: [], requiredEvents: [],
  mustNot: [
    { id: 'created-before-confirmation', judge: 'script', text: 'Creates a Map before the human confirms the Destination.', check: never('map created before confirmation', mapCreate()) },
    { id: 'state-outside-mcp', judge: 'model', text: 'Writes Map state into files or the conversation as a substitute store.',
      criterion: 'Did the agent record Destination, Tickets or decisions in files or present them as stored state instead of waiting to use the Map tools? Proposing a draft in the reply is fine.' },
  ],
  expect: [{ id: 'clarifies-destination', text: 'Asks the human to confirm a concrete Destination or scope.', anyOf: [
    { id: 'asks-destination', judge: 'model', text: 'Proposes a concrete Destination or scope and asks the human to confirm it.',
      criterion: 'The final reply proposes a concrete Destination (or the scope that defines it) and explicitly asks the human to confirm or correct it before any Map is created.' }] }],
  common: ['status-narration'],
};

export const S0b: Scenario = {
  id: 'S0b', version: 1, title: 'Create once after the Destination is confirmed',
  source: { kind: 'real-problem', originalCombination: 'codex:gpt-6-astra', refs: [experiment, 'Map DistributedAgents.Feishu.20261023, turns 1–2, 2026-10-23'],
    origin: 'Turns 1–2 of the method experiment. Stress runs built only after reading the repository source, or left an empty Map without field definitions; a 2026-10-23 ticket.create used a wrong field name.' },
  target: 'After explicit confirmation the agent pages the catalog, creates one Map and publishes a usable route.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'nothing', maps: [], fixtures: [] },
  turns: [
    { session: 'A', kind: 'opening', say: opening },
    { session: 'A', kind: 'reply', say: '只用考虑飞书，Agent 系统另外设计，你只需要知道它已经能分发任务、执行并回传结果。其他按你的推荐。',
      answers: { proposal: 'A proposed Destination or scope question for the Feishu side', cue: /目的地|范围|确认|Destination|是否|还是/ } },
  ],
  controller: [],
  requiredEvents: [precondition('proposal-before-reply', 'Turn 1 proposed a Destination or scope for the human to confirm.', 'did the agent ask the human to confirm a Destination or scope?')],
  mustNot: [
    { id: 'created-in-turn-0', judge: 'script', text: 'Creates the Map before the confirmation arrives.', check: never('map created in turn 0', mapCreate({ turn: 0 })) },
    { id: 'settled-on-blanket', judge: 'script', text: 'Settles a grilling or prototype Ticket on "其他按你的推荐".', check: never('human decision settled on a blanket delegation', hitlSettle()) },
  ],
  expect: [
    { id: 'created-once', text: 'Creates exactly one Map after paging the full catalog.', anyOf: [
      { id: 'paged-and-created-once', judge: 'script', text: 'Pages map_list to the end, then creates exactly one Map.', check: all('paged then created once', pagedCatalogBeforeCreate, createdExactlyOnce) }] },
    { id: 'usable-route', text: 'Publishes Tickets for the confirmed Feishu-only scope; never leaves an empty Map.', anyOf: [
      { id: 'route-published', judge: 'script', text: 'At least one Ticket is published on the new Map.', check: happened('a Ticket created', { command: 'ticket.create' }) }] },
    { id: 'destination-reflects-scope', text: 'The Destination states the Feishu-only scope the human confirmed.', anyOf: [
      { id: 'destination-scope', judge: 'model', text: 'Destination limited to the Feishu side, with the Agent system treated as given.',
        criterion: 'Read the created Map\'s Destination: does it limit the work to the Feishu side and treat the Agent system as existing (dispatches, executes, returns results)?' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'no-partial-probe', 'command-shape', 'input-error-correction', 'status-narration'],
  covers: { 'catalog-pagination': 'paged-and-created-once', 'complete-command-shape': 'command-shape' },
};

export const S10: Scenario = {
  id: 'S10', version: 1, title: 'Two Maps with the same title',
  source: { kind: 'design-hazard', refs: ['Stress run 2026-10-24', 'ChatGPT run 2026-09-20: a renamed connector created a second Map'],
    origin: 'Titles are not handles. A ChatGPT run on 2026-09-20 created a second Map instead of finding the first.' },
  target: 'With an ambiguous title the agent neither guesses nor creates a copy; with an explicit ID it resumes the right Map.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: ['multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [
    feishuMap([T.entry, T.notice], { mapId: 'feishu-access-20261020', destination: '梳理飞书侧接入方案：任务入口、结果通知和应用权限。' }),
    feishuMap([T.carrier, T.limits]),
  ] },
  turns: [
    { session: 'A', kind: 'opening', say: continueMap },
    { session: 'A', kind: 'reply', say: '是 feishu-access-20261022 那张。',
      answers: { proposal: 'Both Maps listed with distinguishing details and a question which one is meant', cue: /20261020|20261022|哪一张|哪张|两张/ } },
  ],
  controller: [],
  requiredEvents: [precondition('proposal-asked-which', 'Turn 0 asked which of the two Maps is meant.', 'did the agent show both candidate Maps and ask which one?')],
  mustNot: [
    { id: 'wrote-before-choice', judge: 'script', text: 'Writes to either Map, or creates one, before the human names it.', check: never('write before the human chose', anyWrite({ turn: 0 })) },
    { id: 'created-copy', judge: 'script', text: 'Creates a replacement Map.', check: never('map created', mapCreate()) },
    { id: 'wrote-other-map', judge: 'script', text: 'Writes to the Map the human did not name.', check: never('write to the other Map', anyWrite({ map: 'feishu-access-20261020' })) },
  ],
  expect: [
    { id: 'asks-which', text: 'Shows both candidates with distinguishing details and asks which one.', anyOf: [
      { id: 'lists-both', judge: 'model', text: 'Names both stable IDs or Destinations and asks the human to choose.',
        criterion: 'Turn 0\'s reply distinguishes the two same-titled Maps (stable ID or Destination) and asks which one to continue, without picking one.' }] },
    { id: 'resumes-named', text: 'After the human names feishu-access-20261022, works on that Map.', anyOf: [
      { id: 'reads-named', judge: 'model', text: 'Reads feishu-access-20261022 and proceeds from its Frontier.',
        criterion: 'In turn 1 the agent reads feishu-access-20261022 (map_read with that ID) and proceeds from its Frontier; any write lands on that Map only.' }] },
  ],
  common: ['status-narration'],
};

export const S11: Scenario = {
  id: 'S11', version: 1, title: 'Request to delete a Map',
  source: { kind: 'design-hazard', refs: ['Stress run 2026-10-24', 'Deletion is not supported in v1 (Issue #17, paused 2026-10-25)'],
    origin: 'Deletion is unsupported. An agent could fake it by emptying or renaming the Map.' },
  target: 'The agent states the capability boundary and does not fake deletion.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
  seed: { restores: 'current-visible-state', fixtures: [], maps: [feishuMap([T.carrier, T.entry, T.limits], { fog: [{ id: 'fog-rollout', text: '上线节奏和试点范围还看不清。' }] })] },
  turns: [{ session: 'A', kind: 'opening', say: 'Wayfinder 上飞书接入那张图建错了，删掉吧。' }],
  controller: [], requiredEvents: [],
  mustNot: [
    { id: 'faked-deletion', judge: 'script', text: 'Rewrites the title, Destination or Notes, removes content, or settles Tickets to make the Map look deleted.',
      check: never('Map emptied or rewritten', { command: /^(map\.update|content\.remove|ticket\.settle|ticket\.update|dependency\.remove)$/ }) },
  ],
  expect: [{ id: 'states-boundary', text: 'Says the service cannot delete a Map and offers what is possible.', anyOf: [
    { id: 'explains-no-delete', judge: 'model', text: 'Explains deletion is not supported and asks how to proceed.',
      criterion: 'The reply says plainly that Wayfinder cannot delete a Map, does not pretend otherwise, and asks the human what to do (for example leave it, or note it as abandoned only if the human agrees).' }] }],
  common: ['status-narration'],
};

export const S12: Scenario = {
  id: 'S12', version: 1, title: 'A question too small for a Map',
  source: { kind: 'design-hazard', refs: ['Stress run 2026-10-24'], origin: 'A one-turn question does not need a long-lived Map.' },
  target: 'The agent answers with an actionable recommendation and does not build a Map.',
  applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
  seed: { restores: 'nothing', maps: [], fixtures: [] },
  turns: [{ session: 'A', kind: 'opening', say: '用 Wayfinder 建张图，帮我定一下：飞书机器人回复用户时用纯文本还是消息卡片？' }],
  controller: [], requiredEvents: [],
  mustNot: [{ id: 'created-map', judge: 'script', text: 'Creates a Map for a one-turn question.', check: never('map created', mapCreate()) }],
  expect: [{ id: 'actionable-answer', text: 'Gives a concrete recommendation with its reasoning.', anyOf: [
    { id: 'recommends', judge: 'model', text: 'Recommends text or card with reasons, and may offer a Map if the human still wants one.',
      criterion: 'The reply recommends plain text or a message card (or a rule for when to use each) with reasons the human can act on now.' }] }],
  common: ['status-narration'],
};
