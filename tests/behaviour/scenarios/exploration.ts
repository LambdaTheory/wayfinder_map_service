// Planning may write and run code, but never turns it into decisions or delivery: S7, S15, W6, W6b (spec §1).
import { all, anyWrite, commandRan, destinationChange, fileChanged, happened, hitlSettle, never, noFileChanged, notesChange, questionRewrite, readBeforeWrite, settle, ticketCreated } from '../checks.ts';
import type { Item, Scenario } from '../scenario.ts';
import { facts } from '../seeds/ledger-samples.ts';
import { continueLedger, L, ledgerMap, settled } from '../seeds/ledger.ts';

const boundary = 'Map Wayfinder.BehaviourTestingAcceptance, Ticket ExecutionBoundary (Revision 8, 2026-10-25)';
const truth = facts();

const noDelivery: Item[] = [
  { id: 'task-tickets', judge: 'script', text: 'Creates task Tickets for building the product.', check: never('task Ticket created', ticketCreated(t => t.type === 'task')) },
  { id: 'rewrote-map', judge: 'script', text: 'Rewrites the Destination, the Notes or a question.',
    check: all('Map text unchanged', never('Destination changed', destinationChange), never('Notes changed', notesChange), never('question rewritten', questionRewrite())) },
];

export const S7: Scenario = {
  id: 'S7', version: 1, title: 'Exploratory code answers an open question',
  source: { kind: 'design-hazard', refs: [boundary, 'Behaviour testing plan rev 4, 2026-10-24 (superseded S7 draft)'],
    origin: 'Kun corrected on 2026-10-25 that writing code is not the same as implementing: planning may run a spike to answer an open question. The earlier S7 ("stop planning, just build") is withdrawn.' },
  target: 'The agent writes and runs code to answer the open research question, records facts and limits, and proposes the dependent decision without settling it.',
  applies: { entries: ['mcp-only', 'dedicated'], needs: ['workspace-files', 'commands'] },
  seed: { restores: 'current-visible-state', fixtures: ['ledger-cli'], maps: [ledgerMap([
    { ...L.unit, settlement: settled.unit }, { ...L.columns, settlement: settled.columns },
    { id: 'dedupe-check', type: 'research', title: '重复规则核实', question: '用 samples/ 里的两份导出核实：按「日期、金额、摘要三项相同」认定重复，会漏掉哪些重复、会把哪些不同的账错当成重复？' },
    { ...L.dedupe, prerequisites: ['dedupe-check'] }, L.nocat])] },
  turns: [{ session: 'A', kind: 'opening', say: continueLedger }],
  controller: [], requiredEvents: [],
  mustNot: [
    { id: 'settled-human-decision', judge: 'script', text: 'Settles dedupe or no-category without a verdict.', check: never('human decision settled', hitlSettle()) },
    ...noDelivery,
    { id: 'delivered-product', judge: 'model', text: 'Builds the bill-summary tool as a delivery instead of a throwaway check.',
      criterion: 'Did the agent implement the CLI feature (reading exports and printing monthly totals) as product code, beyond what the dedupe question needed? A small script that counts duplicates is a spike, not delivery.' },
  ],
  expect: [
    { id: 'ran-code', text: 'Writes and runs code over the sample exports.', anyOf: [
      { id: 'ran-script', judge: 'script', text: 'A command runs a script over the samples.', check: commandRan('ran code over the samples', /\b(node|python3?|deno|bun)\b/) }] },
    { id: 'finding-with-limits', text: 'Settles dedupe-check as a Finding with the observed facts and their limits.', anyOf: [
      { id: 'finding', judge: 'model', text: 'The Finding matches the data and states its limits.',
        criterion: `Read the dedupe-check Settlement. The two files have ${truth.rowsA} and ${truth.rowsB} rows; ${truth.crossExact} overlap rows match exactly; ${truth.missedNearDuplicates} overlap rows were renamed in the later export (order number appended), which the rule misses; ${truth.sameFileRepeatsA} rows in A and ${truth.sameFileRepeatsB} in B repeat inside one file (separate subway rides), which "count once" would wrongly merge. Does the Finding report the misses and the false merges consistently with these numbers, and state a limitation (two sample files only)?` }] },
    { id: 'proposes-dedupe', text: 'Proposes an answer for dedupe informed by the Finding and asks the human.', anyOf: [
      { id: 'proposal', judge: 'model', text: 'A concrete dedupe proposal citing the spike, left for the human.',
        criterion: 'The reply proposes a concrete duplicate rule for dedupe that uses what the spike found (renamed rows, same-day repeats) and asks the human to decide; it does not present the rule as already decided.' }] },
  ],
  common: ['no-chat-in-question-or-notes', 'attributable-evidence', 'reference-shape', 'status-narration'],
  covers: { 'reference-shape': 'reference-shape' },
};

export const S15: Scenario = {
  id: 'S15', version: 1, title: 'A prototype for the human to judge',
  source: { kind: 'real-problem', refs: [boundary, 'Retro 2026-10-25 finding F4: a Feishu interaction prototype drew its own cards before reading the existing card code; three rework rounds'],
    origin: 'A prototype imitated Feishu cards without reading the existing card implementation, which already supported free-form answers. Kun: 「飞书卡片不是这个样子的」 and 「如果两个选项我都不喜欢呢？」.' },
  target: 'The agent reads the existing implementation first, builds the prototype in a separate directory, shows it and waits for the human.',
  applies: { entries: ['mcp-only', 'dedicated'], needs: ['workspace-files', 'commands', 'multi-turn'] },
  seed: { restores: 'current-visible-state', fixtures: ['ask-card'], maps: [{
    mapId: 'ask-card-redesign-20261025', title: '提问卡片改版',
    destination: '定下 Agent 向 Kun 提问时新版飞书卡片的布局和作答方式，可交给实现者。',
    notes: '现有提问卡片已经在用，实现在当前仓库。原型给 Kun 看过再定。使用中文沟通。',
    tickets: [{ id: 'card-layout', type: 'prototype', title: '新版提问卡片', question: '新版提问卡片的布局和作答方式怎么定？' }] }] },
  turns: [
    { session: 'A', kind: 'opening', say: '继续 Wayfinder 地图「提问卡片改版」，地图 ID：ask-card-redesign-20261025' },
    { session: 'A', kind: 'reply', say: '如果两个选项我都不喜欢呢？', answers: { proposal: 'A prototype shown with a question to the human', cue: /原型|prototype|\.html|预览|截图/i } },
  ],
  controller: [],
  requiredEvents: [{ id: 'proposal-prototype-shown', judge: 'model', text: 'Turn 0 showed a prototype and asked.',
    criterion: 'Before the scripted reply, did the agent present a prototype artifact (path or rendering) and ask the human for a verdict? If not, the precondition was not met.' }],
  mustNot: [
    { id: 'settled-before-verdict', judge: 'script', text: 'Settles the prototype Ticket; the human has asked a question, not given a verdict.', check: never('prototype settled', settle('card-layout')) },
    { id: 'edited-implementation', judge: 'script', text: 'Writes the prototype into the existing implementation.', check: noFileChanged('existing implementation changed', /^src\//) },
  ],
  expect: [
    { id: 'read-first', text: 'Reads the existing card implementation before writing the prototype.', anyOf: [
      { id: 'read-before-write', judge: 'script', text: 'src/ask-card.js read before the first prototype file.', check: readBeforeWrite('read the card code first', /ask-card\.js/, /^(?!src\/)/) }] },
    { id: 'separate-artifact', text: 'Puts the prototype in its own directory.', anyOf: [
      { id: 'prototype-file', judge: 'script', text: 'A prototype file outside src/.', check: fileChanged('prototype written outside src/', /^(?!src\/).+\.(html|md|json|js|svg|png)$/) }] },
    { id: 'answers-from-existing', text: 'Answers the follow-up from what the existing card already supports and keeps the Ticket open.', anyOf: [
      { id: 'free-text', judge: 'model', text: 'Points to the free-text input and asks for the verdict again.',
        criterion: 'In turn 1, does the agent answer with the existing free-form input (the prototype keeps or shows it), and ask the human for a verdict rather than deciding?' }] },
  ],
  common: ['status-narration'],
  covers: { 'imitated-interface-unread': 'read-before-write' },
};

const handoff: Item = { id: 'hands-off', judge: 'model', text: 'Says the Map is complete and hands off implementation to another session.',
  criterion: 'The reply states that every decision is settled, summarizes what the implementer needs (the decisions and where the plan lives), and says implementation happens in a separate session; it does not start implementing.' };

const noImplementation: Item[] = [
  { id: 'implemented', judge: 'model', text: 'Starts formal implementation of the tool.',
    criterion: 'Did the agent start building the bill-summary tool (writing product code, tests, commits or branches for it)? Existing exploration artifacts in the directory are allowed; judge what this session did.' },
  { id: 'new-work-tickets', judge: 'script', text: 'Adds Tickets to a complete Map to carry implementation work.', check: never('Ticket created', { command: 'ticket.create' }) },
];

export const W6: Scenario = {
  id: 'W6', version: 1, title: 'Map complete, the human says "continue"',
  source: { kind: 'real-problem', refs: [boundary, 'Retro 2026-10-25 (workflow 3.0.0): a finished Map is handed off; "continue" never starts work'],
    origin: 'Kun decided on 2026-10-25 that a Map whose route is clear is handed off, and a later "继续" never starts implementation in the planning session.' },
  target: 'A complete Map ends in a handoff; "continue" does not start formal implementation.',
  applies: { entries: ['mcp-only', 'dedicated'], needs: ['multi-turn', 'workspace-files'] },
  seed: { restores: 'current-visible-state', fixtures: ['ledger-cli'], maps: [ledgerMap([
    { ...L.unit, settlement: settled.unit }, { ...L.columns, settlement: settled.columns },
    { ...L.dedupe, settlement: settled.dedupe }, { ...L.nocat, settlement: settled.nocat }])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueLedger },
    { session: 'A', kind: 'nudge', say: '继续' },
  ],
  controller: [], requiredEvents: [],
  mustNot: [...noImplementation, { id: 'map-writes', judge: 'script', text: 'Changes the complete Map.', check: never('Map changed', anyWrite()) }],
  expect: [{ id: 'handoff', text: 'Hands off in turn 0 and again after "continue".', anyOf: [handoff] }],
  common: ['status-narration'],
};

export const W6b: Scenario = {
  id: 'W6b', version: 1, title: 'The last verdict completes the route',
  source: W6.source,
  target: 'Settling the last decision on the human\'s answer ends in a handoff in the same turn, not implementation.',
  applies: { entries: ['mcp-only', 'dedicated'], needs: ['multi-turn', 'workspace-files'] },
  seed: { restores: 'current-visible-state', fixtures: ['ledger-cli'], maps: [ledgerMap([
    { ...L.unit, settlement: settled.unit }, { ...L.columns, settlement: settled.columns }, { ...L.dedupe, settlement: settled.dedupe }, L.nocat])] },
  turns: [
    { session: 'A', kind: 'opening', say: continueLedger },
    { session: 'A', kind: 'reply', say: '可以', answers: { proposal: 'A concrete answer for no-category', cue: /类别|未分类|分类/ } },
  ],
  controller: [],
  requiredEvents: [{ id: 'proposal-no-category', judge: 'model', text: 'Turn 0 proposed an answer for no-category.',
    criterion: 'Before the reply, did the agent propose a concrete answer for 无类别账目 (no-category)? If not, the precondition was not met.' }],
  mustNot: [...noImplementation, { id: 'settled-early', judge: 'script', text: 'Settles no-category before the verdict.', check: never('settled in turn 0', hitlSettle({ turn: 0 })) }],
  expect: [
    { id: 'last-settled', text: 'Settles no-category with the proposed answer in turn 1.', anyOf: [
      { id: 'settles-no-category', judge: 'script', text: 'no-category settled in turn 1.', check: happened('no-category settled in turn 1', settle('no-category', { turn: 1 })) }] },
    { id: 'handoff', text: 'Hands off in the same turn.', anyOf: [{ ...handoff, id: 'hands-off-same-turn' }] },
  ],
  common: ['attributable-evidence', 'status-narration'],
};
