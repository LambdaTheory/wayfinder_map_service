import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The generator is intentionally plain ESM so it can run before TypeScript compilation.
// @ts-expect-error the build script is outside the TypeScript source graph
const { parseWorkflow } = await import('../scripts/build-workflow.mjs') as {
  parseWorkflow(markdown: string, version: string, previous?: { markdown: string; version: string }):
    { version: string; safetyCore: string; instructions: string };
};
const source = readFileSync('docs/agents/exploration-mcp.md', 'utf8');

test('W00: deterministic workflow extraction validates version, order, tool set and safety bound', () => {
  expect(parseWorkflow(source, '3.0.1')).toEqual(parseWorkflow(source, '3.0.1'));
  expect(parseWorkflow(source, '3.0.1')).toMatchObject({ version: '3.0.1' });
  expect(parseWorkflow(source, '3.0.1').instructions).toContain('\n\nversion: 3.0.1\n\n');
  expect([...parseWorkflow(source, '3.0.1').safetyCore].length).toBeLessThanOrEqual(512);
  expect(parseWorkflow(source, '3.0.1').safetyCore).toContain('old request is void until a human sees the new Revision and issues a new request');

  expect(() => parseWorkflow(source, 'latest')).toThrow(/Workflow build refused/);
  const cases = [
    `---\nworkflowVersion: 3.0.1\n---\n\n${source}`,
    source.replace('<!-- wayfinder:prompt:end -->', ''),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_create:start -->\n<!-- wayfinder:tool:map_create:start -->'),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_extra:start -->'),
    source.replace('Wayfinder MCP alone owns Map state', `X${'x'.repeat(512)} Wayfinder MCP alone owns Map state`),
  ];
  for (const invalid of cases) expect(() => parseWorkflow(invalid, '3.0.1')).toThrow(/Workflow build refused/);
});

test('W00: a changed workflow must increase the shared version, and the version never decreases', () => {
  const previous = { markdown: source, version: '3.0.1' };
  const editorialChange = source.replace('Resources and Prompts are optional explanations', 'Resources and Prompts are optional projections');
  expect(() => parseWorkflow(editorialChange, '3.0.1', previous)).toThrow(/increase the version/);
  expect(() => parseWorkflow(editorialChange, '1.2.1', previous)).toThrow(/cannot decrease/);
  expect(parseWorkflow(editorialChange, '3.0.2', previous).version).toBe('3.0.2');
  // A change outside the workflow also moves the shared version; the unchanged text accepts it.
  expect(parseWorkflow(source, '3.1.0', previous).version).toBe('3.1.0');
  expect(() => parseWorkflow(source, '3.0.0', previous)).toThrow(/cannot decrease/);
});
