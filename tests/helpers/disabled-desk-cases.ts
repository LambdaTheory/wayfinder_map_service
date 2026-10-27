import { readFileSync } from 'node:fs';

// Full SDK results captured from a built v3.1.0 export, after tools/list.
// Keep malformed requests intact; normalize only the current release claim.
export function disabledDeskCases(version: string): { label: string; name: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[] {
  const baseline = JSON.parse(readFileSync(new URL('./mcp-disabled-desk-v3.1.0.json', import.meta.url), 'utf8'));
  return baseline.cases.map((entry: { arguments: Record<string, unknown> }) => ({ ...entry,
    arguments: { ...entry.arguments, ...(entry.arguments.version === baseline.release ? { version } : {}) },
  }));
}
