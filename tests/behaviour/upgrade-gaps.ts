import type { AttemptRecord, EventRecord, GivenRules } from './evidence.ts';

/** Native phases from one turn retain their proven sources. Older adapters do
 * not identify native turns; their latest phase may instead start a new chat,
 * so they cannot borrow a source from an earlier phase without that evidence. */
export function sourcesInTurn(a: AttemptRecord, e: EventRecord): GivenRules[] {
  const previous = a.given.filter(g => g.fromSeq <= e.seq);
  const latest = previous.reduce<GivenRules | undefined>((last, g) => !last || g.fromSeq > last.fromSeq ? g : last, undefined);
  return previous.filter(g => g === latest || (g.session !== undefined && g.turn !== undefined && g.session === e.session && g.turn === e.turn));
}

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
