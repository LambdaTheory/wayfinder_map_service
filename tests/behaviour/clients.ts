// Client profiles and the applicability matrix: which Scenarios can run on which client and Entry.
import type { Entry, Harness } from './evidence.ts';
import { readiness } from './scenario.ts';
import type { Capability, Scenario } from './scenario.ts';

/**
 * What each client is expected to support. `onboarded` turns true only when its Driver has passed the five
 * onboarding checks of R2 (B02a for Codex, B06 for the others); until then no cell is shown as applicable.
 */
export const clientProfiles: Record<Harness, { onboarded: boolean; entries: Entry[]; supports: Partial<Record<Capability, boolean | 'unverified'>> }> = {
  codex: { onboarded: false, entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': true,
    'workspace-files': true, commands: true, 'resource-read': true, 'sub-agents': 'unverified', 'async-questions': false } },
  claude: { onboarded: false, entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': true,
    'workspace-files': true, commands: true, 'resource-read': true, 'sub-agents': 'unverified', 'async-questions': false } },
  chatgpt: { onboarded: false, entries: ['chatgpt'], supports: { 'multi-turn': true, 'new-session': true, 'concurrent-sessions': 'unverified',
    'workspace-files': false, commands: false, 'resource-read': false, 'sub-agents': false, 'async-questions': false } },
  pi: { onboarded: false, entries: ['mcp-only'], supports: {} },
  grok: { onboarded: false, entries: ['mcp-only'], supports: {} },
};

export type Cell = { state: 'applicable' } | { state: 'not-applicable' | 'unverified' | 'not-ready'; reasons: string[] };

/** One cell of the applicability matrix: a Scenario on one client through one Entry. */
export function cell(s: Scenario, harness: Harness, entry: Entry): Cell {
  const profile = clientProfiles[harness];
  if (!profile.entries.includes(entry) || !s.applies.entries.includes(entry)) return { state: 'not-applicable', reasons: [`entry ${entry}`] };
  const missing = s.applies.needs.filter(need => profile.supports[need] === false);
  if (missing.length) return { state: 'not-applicable', reasons: missing };
  const unverified = s.applies.needs.filter(need => profile.supports[need] !== true);
  const notReady = readiness(s);
  if (notReady.length) return { state: 'not-ready', reasons: notReady };
  if (!profile.onboarded) return { state: 'unverified', reasons: [...unverified, 'driver not onboarded'] };
  if (unverified.length) return { state: 'unverified', reasons: unverified };
  return { state: 'applicable' };
}
