import type { SeedMap, SeedTicket } from '../scenario.ts';

export const seedClaimant = 'behaviour-seed';

/** Shared pure write plan for the capture verifier and the MCP Controller. */
export function visibleSeedSteps(map: SeedMap): unknown[][] {
  const content = (section: 'fog' | 'scopeExclusions') => (map[section] ?? []).map(item =>
    ({ kind: 'content.add', section, item: { ...item, references: item.references ?? [] } }));
  const batch = [
    ...map.tickets.map(t => ({ kind: 'ticket.create', ticket: { id: t.id, title: t.title, question: t.question, type: t.type } })),
    ...map.tickets.flatMap(t => (t.prerequisites ?? []).map(p => ({ kind: 'dependency.add', dependentId: t.id, prerequisiteId: p }))),
    ...content('fog'), ...content('scopeExclusions'),
  ];
  const steps: unknown[][] = batch.length ? [batch] : [];
  for (const t of settleOrder(map.tickets)) steps.push([
    { kind: 'claim.acquire', ticketId: t.id, claimantId: seedClaimant },
    { kind: 'ticket.settle', ticketId: t.id, ticketType: t.type, claimantId: seedClaimant, settlement: wireSettlement(t.settlement!) },
  ]);
  const claims = map.tickets.filter(t => t.claim).map(t => ({ kind: 'claim.acquire', ticketId: t.id, claimantId: t.claim }));
  if (claims.length) steps.push(claims);
  return steps;
}

/** Supply the empty extension containers required by ticket.settle's input shape. */
export function wireSettlement(s: NonNullable<SeedTicket['settlement']>) {
  return { ...s, evidence: s.evidence.map(e => ({ extensions: {}, ...e })), extensions: {} };
}

function settleOrder(tickets: SeedTicket[]): SeedTicket[] {
  const settled = tickets.filter(t => t.settlement);
  const done = new Set<string>();
  const out: SeedTicket[] = [];
  while (out.length < settled.length) {
    const next = settled.find(t => !done.has(t.id) && (t.prerequisites ?? []).every(p => done.has(p)));
    if (!next) throw new Error('seed settlements form a cycle or wait on an open prerequisite');
    done.add(next.id);
    out.push(next);
  }
  return out;
}
