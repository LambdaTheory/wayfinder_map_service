import type { SeedTicket } from '../scenario.ts';

type Settlement = NonNullable<SeedTicket['settlement']>;

/** A settled human decision as a seed carries it. The seed's own evidence names where the verdict came from. */
export function decision(statement: string, rationale: string, method: string): Settlement {
  const provenance = { method, sources: [] };
  return { outcome: { kind: 'decision', statement, rationale },
    evidence: [{ statement: `${method}中给出结论。`, references: [], provenance }], references: [], provenance };
}

export function finding(statement: string, method: string, limitations?: string): Settlement {
  const provenance = { method, sources: [] };
  return { outcome: { kind: 'finding', statement, ...(limitations ? { limitations } : {}) },
    evidence: [{ statement, references: [], provenance }], references: [], provenance };
}
