import type { GivenRules } from './evidence.ts';

/** The extractor keeps uncertain exposure in the affected fields, including
 * legacy captured phases. Consumers must not erase it with retained rules or a
 * later source. fromSeq on such a phase is a bound, not a proven exposure. */
export function exposureGap(g: GivenRules, fields: ('instructions' | 'toolDescriptions' | 'resourceText')[] = ['instructions', 'toolDescriptions', 'resourceText']): string | undefined {
  for (const name of fields) {
    const field = g[name];
    if (field && !field.known && field.reason.startsWith('unpositioned ')) return field.reason;
  }
  return undefined;
}
