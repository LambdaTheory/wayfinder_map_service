import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { mapTools, toolsOnlyMapTools } from '../src/mcp-schemas.js';

// The generator is intentionally plain ESM so it can run before TypeScript compilation.
// @ts-expect-error the build script is outside the TypeScript source graph
const { parseWorkflow } = await import('../scripts/build-workflow.mjs') as {
  parseWorkflow(markdown: string, version: string, previous?: { markdown: string; version: string }):
    { version: string; safetyCore: string; instructions: string; prompt: string };
};
const source = readFileSync('docs/agents/exploration-mcp.md', 'utf8');
const approvedVerdicts = "A question from the human is not an instruction or a verdict, even when you agree: answer it and ask before acting on it. Changing what a Map covers is the human's call: add or remove Scope Exclusions, change the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement to that proposal.";

test('F11: the dedicated Wayfinder skill proposes exclusions and records only human-authorized ones', () => {
  const path = '.agents/skills/wayfinder/SKILL.md';
  const skill = readFileSync(path, 'utf8');
  expect(skill).toContain('A Ticket found beyond the Destination is never settled as a decision: release its Claim and propose a Scope Exclusion.');
  expect(skill).toContain('names the Ticket and says why it is out of scope');
  expect(skill).toContain('the Ticket stays open until the service supports removal');
  expect(skill).toContain(approvedVerdicts);
  expect(skill).toContain("Change Scope Exclusions, the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement; a question from the human is neither.");
  expect(skill).not.toContain('Release any Claim, add a Scope Exclusion');
  expect(skill).not.toContain('Record the Scope Exclusion');
  const hashes = JSON.parse(readFileSync('docs/agents/installed-skill-hashes.json', 'utf8'));
  expect(hashes[path]).toBe(createHash('sha256').update(skill).digest('hex'));
  const sources = JSON.parse(readFileSync('docs/agents/skill-sources.json', 'utf8')) as { files: { dest: string; lineCount: number }[] };
  expect(sources.files.find(file => file.dest === 'wayfinder/SKILL.md')!.lineCount).toBe(skill.trimEnd().split('\n').length);
});

test.each(['.agents/skills/wayfinder/SKILL.md', 'docs/agents/exploration-mcp.md'])(
  'F11: %s uses a proposal reference only within the complete approved Verdicts text', path => {
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(approvedVerdicts);
    expect(text.replaceAll(approvedVerdicts, '')).not.toMatch(/\b(?:that|this) proposal\b/);
  });

test('W00: deterministic workflow extraction validates version, order, tool set and safety bound', () => {
  expect(parseWorkflow(source, '1.0.1')).toEqual(parseWorkflow(source, '1.0.1'));
  expect(parseWorkflow(source, '1.0.1')).toMatchObject({ version: '1.0.1' });
  expect(parseWorkflow(source, '1.0.1').instructions).toContain('\n\nversion: 1.0.1\n\n');
  expect([...parseWorkflow(source, '1.0.1').safetyCore].length).toBeLessThanOrEqual(512);
  expect(parseWorkflow(source, '1.0.1').safetyCore).toContain('old request is void until a human sees the new Revision and issues a new request');

  expect(() => parseWorkflow(source, 'latest')).toThrow(/Workflow build refused/);
  const cases = [
    `---\nworkflowVersion: 3.0.0\n---\n\n${source}`,
    source.replace('<!-- wayfinder:prompt:end -->', ''),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_create:start -->\n<!-- wayfinder:tool:map_create:start -->'),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_extra:start -->'),
    source.replace('Wayfinder MCP alone owns Map state', `X${'x'.repeat(512)} Wayfinder MCP alone owns Map state`),
  ];
  for (const invalid of cases) expect(() => parseWorkflow(invalid, '1.0.1')).toThrow(/Workflow build refused/);
});

test('W00: a changed workflow must increase the shared version, and the version never decreases', () => {
  const previous = { markdown: source, version: '1.0.1' };
  const editorialChange = source.replace('Resources and Prompts are optional explanations', 'Resources and Prompts are optional projections');
  expect(() => parseWorkflow(editorialChange, '1.0.1', previous)).toThrow(/increase the version/);
  expect(() => parseWorkflow(editorialChange, '0.9.0', previous)).toThrow(/cannot decrease/);
  expect(parseWorkflow(editorialChange, '1.0.2', previous).version).toBe('1.0.2');
  // A change outside the workflow also moves the shared version; the unchanged text accepts it.
  expect(parseWorkflow(source, '1.1.0', previous).version).toBe('1.1.0');
  expect(() => parseWorkflow(source, '1.0.0', previous)).toThrow(/cannot decrease/);
});

test.each([['instructions', mapTools], ['toolsOnly', toolsOnlyMapTools]] as const)(
  'workflow fixes: %s exposes every rule in its governed tools and initialization', (_mode, tools) => {
    const instructions = parseWorkflow(source, '5.0.0').instructions;
    const skill = readFileSync('.agents/skills/wayfinder/SKILL.md', 'utf8');
    const descriptions = Object.fromEntries(tools.map(tool => [tool.name, tool.description!]));
    const rules = [
      { tools: ['map_create', 'map_list'], passages: ['give an actionable recommendation and its reasons now',
        'even if the opening request asks for a Map', 'If the human still wants a Map after that explanation'] },
      { tools: ['map_apply'], passages: ['explicitly authorizes clearing or taking over the identified Tickets',
        'After a Conflict, ask about takeover as its own question, naming the Tickets and the session holding them',
        'An explicit reply to take over those Tickets is sufficient; the human need not repeat their IDs',
        'even when it answers a combined takeover-and-continue question'] },
      { tools: ['map_list', 'map_read', 'map_apply'], passages: ['state the capability limit, offer supported next steps',
        'ask which the human wants before changing the Map', 'Deletion is unsupported',
        'add a Notes line that it is abandoned, changing nothing else', 'never simulate deletion'] },
      { tools: ['map_apply'], passages: ['When you reopen a settled decision, in the same reply name the other Tickets affected by the change, including open ones',
        'A direct change request covers only the parts the human states', 'Propose those details for a fresh verdict',
        'Reopening and Settlement still follow the verdict and Answer Desk rules'] },
      { tools: ['map_read', 'map_apply'], passages: ['check the accepted decisions against the Destination, open or claimed Tickets, and Fog',
        'Count every open or claimed Ticket relevant to the route as unfinished',
        'The route is clear only when every relevant Ticket is settled',
        'an empty Frontier alone is not enough', 'hand off in the same turn', 'Otherwise name the specific unfinished Ticket or undecided choice',
        'Add Tickets only for decisions an answer made precise and the route still needs',
        'implementation elaboration that leaves the settled plan unchanged'] },
    ];
    for (const rule of rules) for (const passage of rule.passages) {
      expect(instructions).toContain(passage);
      expect(skill).toContain(passage);
      for (const tool of rule.tools) expect(descriptions[tool], `${tool}: ${passage}`).toContain(passage);
    }
    expect(readFileSync('scripts/wayfinder-agent/agent-instructions.md', 'utf8'))
      .toContain('前沿为空不等于完成，有缺口就点明');
  });

test('workflow fixes: Prompt and skill keep the human choice to create and the completion gate', () => {
  const prompt = parseWorkflow(source, '5.0.0').prompt;
  expect(prompt).toContain('answer a one-turn question with an actionable recommendation and its reasons');
  expect(prompt).toContain('explaining that no Map is needed even if the opening request asks for one');
  expect(prompt).toContain('If the human still wants a Map after that explanation, confirm its Destination');
  expect(prompt).not.toContain('If a Map is still needed');
  const skill = readFileSync('.agents/skills/wayfinder/SKILL.md', 'utf8');
  expect(skill).not.toMatch(/If there is no fog|the whole way fits one session|ask how to proceed|otherwise hand off/);
  expect(skill).toContain('If no new Ticket is needed, continue existing unfinished Tickets; hand off only when the completion check above passes.');
});

// Pin each governed tool, not just initialization instructions: ChatGPT sees tools only.
test.each([['instructions', mapTools], ['toolsOnly', toolsOnlyMapTools]] as const)(
  'W114: %s tools independently carry the Answer Desk rules', (_mode, tools) => {
    const descriptions = Object.fromEntries(tools.map(tool => [tool.name, tool.description!]));
    const rules = {
      map_apply: ['Post every currently askable human question', 'without a three-question limit',
        'Prioritize unlockers', 'immediateUnlocks', 'downstreamUnsettled', 'triageReason', 'gatesResearch',
        'Both triage classes still need a human verdict', 'one short sentence and the desk link',
        'Settle released verdicts and publish newly unlocked questions in the same ordered',
        'deskAnswer:{answerId,questionVersion}', 'Taken by this Claimant', 'answered in conversation',
        'then settling without `deskAnswer` in that same batch', 'authorizes neither withdrawal nor Settlement',
        'Agents never submit Desk Answers'],
      map_read: ['At each turn start', 'ChatGPT', 'claimantId', 'version', 'omit `revision`',
        'marks eligible answers and Reopen Requests Taken', 'without waiting', 'never take', 'Taken-but-unsettled'],
      map_wait: ['hold the call for up to `maxWaitSeconds`', 'only after independent work is exhausted',
        'io.modelcontextprotocol/tasks', 'Claude Code', 'Clients unable to hold a long call, including ChatGPT',
        'current `map_read` with `claimantId` and `version` at each turn start', 'never settles', 'lost receipt'],
    };
    for (const [name, passages] of Object.entries(rules)) {
      for (const passage of passages) expect(descriptions[name], `${name}: ${passage}`).toContain(passage);
    }
    const instructions = parseWorkflow(source, '4.0.0').instructions;
    for (const passage of ['Post every currently askable', 'triageReason', 'gatesResearch', 'each turn start',
      'deskAnswer:{answerId,questionVersion}', 'answered in conversation', 'authorizes neither withdrawal nor Settlement']) {
      expect(instructions).toContain(passage);
    }
    expect(source).not.toMatch(/up to three per message|at most three questions/);
  });
