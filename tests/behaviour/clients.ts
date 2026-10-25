// Client profiles and the applicability matrix: which Scenarios can run on which client and Entry.
import type { Entry, Harness } from './evidence.ts';
import { readiness } from './scenario.ts';
import type { Capability, Scenario } from './scenario.ts';

/**
 * What each client supports. An Entry joins `onboarded` only when its Driver has passed the five onboarding checks
 * of R2 (B02a for Codex MCP-only, B02d and B06 for the rest); until then no cell is shown as applicable. `true`
 * means proven in a run, `false` known unsupported, `'unverified'` expected but not yet shown.
 */
export const clientProfiles: Record<Harness, { onboarded: Entry[]; entries: Entry[]; supports: Partial<Record<Capability, boolean | 'unverified'>> }> = {
  // Batch B1-20261025 proved multi-turn resumption, but ran before the sandbox became an allowlist; onboarding
  // waits for a run under the current profile (#65).
  codex: { onboarded: [], entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': true, 'workspace-files': 'unverified', commands: 'unverified',
    'new-session': 'unverified', 'concurrent-sessions': 'unverified', 'resource-read': 'unverified', 'sub-agents': 'unverified', 'async-questions': false } },
  claude: { onboarded: [], entries: ['mcp-only', 'dedicated', 'matt'], supports: { 'multi-turn': 'unverified', 'new-session': 'unverified', 'concurrent-sessions': 'unverified',
    'workspace-files': 'unverified', commands: 'unverified', 'resource-read': 'unverified', 'sub-agents': 'unverified', 'async-questions': false } },
  chatgpt: { onboarded: [], entries: ['chatgpt'], supports: { 'multi-turn': 'unverified', 'new-session': 'unverified', 'concurrent-sessions': 'unverified',
    'workspace-files': false, commands: false, 'resource-read': false, 'sub-agents': false, 'async-questions': false } },
  pi: { onboarded: [], entries: ['mcp-only'], supports: {} },
  grok: { onboarded: [], entries: ['mcp-only'], supports: {} },
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
  if (!profile.onboarded.includes(entry)) return { state: 'unverified', reasons: [...unverified, 'driver not onboarded'] };
  if (unverified.length) return { state: 'unverified', reasons: unverified };
  return { state: 'applicable' };
}
