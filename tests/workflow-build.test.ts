import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The generator is intentionally plain ESM so it can run before TypeScript compilation.
// @ts-expect-error the build script is outside the TypeScript source graph
const { parseWorkflow } = await import('../scripts/build-workflow.mjs') as {
  parseWorkflow(markdown: string, previousMarkdown?: string): { workflowVersion: string; safetyCore: string };
};
const source = readFileSync('docs/agents/exploration-mcp.md', 'utf8');

test('W00: deterministic workflow extraction validates version, order, tool set and safety bound', () => {
  expect(parseWorkflow(source)).toEqual(parseWorkflow(source));
  expect(parseWorkflow(source)).toMatchObject({ workflowVersion: '3.0.0' });
  expect([...parseWorkflow(source).safetyCore].length).toBeLessThanOrEqual(512);
  expect(parseWorkflow(source).safetyCore).toContain('old request is void until a human sees the new Revision and issues a new request');

  const cases = [
    source.replace('workflowVersion: 3.0.0', 'workflowVersion: latest'),
    source.replace('<!-- wayfinder:prompt:end -->', ''),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_create:start -->\n<!-- wayfinder:tool:map_create:start -->'),
    source.replace('<!-- wayfinder:tool:map_create:start -->', '<!-- wayfinder:tool:map_extra:start -->'),
    source.replace('Wayfinder MCP alone owns Map state', `X${'x'.repeat(512)} Wayfinder MCP alone owns Map state`),
  ];
  for (const invalid of cases) expect(() => parseWorkflow(invalid)).toThrow(/Workflow build refused/);
});

test('W00: a changed workflow must strictly increase SemVer and cannot reuse or decrease it', () => {
  const editorialChange = source.replace('Resources and Prompts are optional explanations', 'Resources and Prompts are optional projections');
  expect(() => parseWorkflow(editorialChange, source)).toThrow(/increase workflowVersion/);
  expect(() => parseWorkflow(editorialChange.replace('workflowVersion: 3.0.0', 'workflowVersion: 1.2.1'), source)).toThrow(/increase workflowVersion/);
  expect(parseWorkflow(editorialChange.replace('workflowVersion: 3.0.0', 'workflowVersion: 3.0.1'), source).workflowVersion).toBe('3.0.1');
});
