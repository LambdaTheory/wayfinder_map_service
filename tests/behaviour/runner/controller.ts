// The Controller: seeds Maps before the first turn and reads the evidence after the last, with its own
// credential. Its writes follow the current release contract; it never writes for the agent (R2, R3).
import { createHttpTestClient } from '../../helpers/mcp-http-client.mjs';
import type { EventRecord, WireRevision } from '../evidence.ts';
import type { SeedMap, SeedTicket } from '../scenario.ts';

type Structured = Record<string, unknown> & { kind: string };
export const seedClaimant = 'behaviour-seed';

export interface Controller {
  /** The release the service states in its instructions, which the Controller's own writes attest. */
  version: string;
  instructions: string;
  toolDescriptions: Record<string, string>;
  seed(map: SeedMap): Promise<number>;
  conflictingWrite(mapId: string, id: string): Promise<void>;
  /** Every Map in the catalog with its full history, paged to the end. */
  exportCatalog(): Promise<{ mapId: string; history: WireRevision[] }[]>;
  close(): Promise<void>;
}

export async function connectController(port: number, token: string, observe: (event: EventRecord) => void = () => undefined): Promise<Controller> {
  const { client, initializeResult } = await createHttpTestClient(port, token);
  const instructions = initializeResult.instructions ?? '';
  const version = /^version: (\S+)$/m.exec(instructions)?.[1];
  if (!version) throw new Error('the service instructions state no version');
  const toolDescriptions = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.description ?? '']));

  let callId = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<Structured> {
    const base = { seq: 0, at: new Date().toISOString(), actor: 'controller' as const, session: null, turn: null,
      kind: 'tool-call' as const, callId: `controller:${callId++}`, server: 'wayfinder', tool: name, arguments: args,
      requestId: { known: false as const, reason: 'SDK request ID not exposed' } };
    try {
      const result = await client.callTool({ name, arguments: args });
      observe({ ...base, result: { known: true, value: result.structuredContent }, failed: !!result.isError });
      return result.structuredContent as Structured;
    } catch (error) { observe({ ...base, result: { known: false, reason: String(error) }, failed: true }); throw error; }
  }
  async function apply(mapId: string, expectedRevision: number, commands: unknown[]): Promise<number> {
    const result = await call('map_apply', { version, mapId, expectedRevision, commands });
    if (result.kind !== 'committed') throw new Error(`seed write refused: ${JSON.stringify(result)}`);
    return result.revision as number;
  }

  return {
    version, instructions, toolDescriptions,
    async seed(map) {
      const created = await call('map_create', { version, mapId: map.mapId, title: map.title, destination: map.destination, notes: map.notes });
      if (created.kind !== 'committed') throw new Error(`seed create refused: ${JSON.stringify(created)}`);
      let revision = created.revision as number;
      const content = (section: string, items: SeedMap['fog'] = []) => items.map(item =>
        ({ kind: 'content.add', section, item: { id: item.id, text: item.text, references: item.references ?? [] } }));
      const batch = [
        ...map.tickets.map(t => ({ kind: 'ticket.create', ticket: { id: t.id, title: t.title, question: t.question, type: t.type } })),
        ...map.tickets.flatMap(t => (t.prerequisites ?? []).map(p => ({ kind: 'dependency.add', dependentId: t.id, prerequisiteId: p }))),
        ...content('fog', map.fog), ...content('scopeExclusions', map.scopeExclusions),
      ];
      if (batch.length) revision = await apply(map.mapId, revision, batch);
      for (const t of settleOrder(map.tickets)) {
        revision = await apply(map.mapId, revision, [{ kind: 'claim.acquire', ticketId: t.id, claimantId: seedClaimant },
          { kind: 'ticket.settle', ticketId: t.id, ticketType: t.type, claimantId: seedClaimant, settlement: wireSettlement(t.settlement!) }]);
      }
      const claims = map.tickets.filter(t => t.claim).map(t => ({ kind: 'claim.acquire', ticketId: t.id, claimantId: t.claim }));
      if (claims.length) revision = await apply(map.mapId, revision, claims);
      return revision;
    },
    async conflictingWrite(mapId, id) {
      // A concurrent agent may advance the head while the Controller prepares its injection.
      // Retry only this synthetic Controller action, never the agent's rejected intention.
      for (let retry = 0; retry < 10; retry++) {
        const head = await call('map_read', { mapId });
        if (head.kind !== 'found') throw new Error('Conflict injection needs a readable Map');
        const result = await call('map_apply', { version, mapId, expectedRevision: (head.revision as WireRevision).revision,
          commands: [{ kind: 'content.add', section: 'fog', item: { id, text: '试点群名单待定', references: [] } }] });
        if (result.kind === 'committed') return;
        if (result.kind !== 'conflict') throw new Error(`Conflict injection refused: ${JSON.stringify(result)}`);
      }
      throw new Error('Conflict injection could not commit after 10 concurrent changes');
    },
    async exportCatalog() {
      const ids: string[] = [];
      let after: string | undefined;
      do {
        const page = await call('map_list', { limit: 100, ...(after ? { afterMapId: after } : {}) });
        ids.push(...(page.maps as { mapId: string }[]).map(m => m.mapId));
        after = (page.nextAfterMapId as string | null) ?? undefined;
      } while (after);
      const out = [];
      for (const mapId of ids) {
        const head = await call('map_read', { mapId });
        const current = (head.revision as WireRevision).revision;
        const history: WireRevision[] = [];
        for (let r = 1; r <= current; r++) history.push((await call('map_read', { mapId, revision: r })).revision as WireRevision);
        out.push({ mapId, history });
      }
      return out;
    },
    close: () => client.close(),
  };
}

/** A seed Settlement in the input shape `ticket.settle` takes: every Evidence item and the Settlement carry extensions. */
function wireSettlement(s: NonNullable<SeedTicket['settlement']>) {
  return { ...s, evidence: s.evidence.map(e => ({ extensions: {}, ...e })), extensions: {} };
}

/** Settled seed Tickets in prerequisite order, so every Settlement finds its prerequisites settled. */
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
