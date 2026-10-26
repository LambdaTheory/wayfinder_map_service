// The Controller: seeds Maps before the first turn and reads the evidence after the last, with its own
// credential. Its writes follow the current release contract; it never writes for the agent (R2, R3).
import { createHttpTestClient } from '../../helpers/mcp-http-client.mjs';
import { isDeepStrictEqual } from 'node:util';
import type { WireRevision, WireState } from '../evidence.ts';
import type { SeedMap, SeedTicket } from '../scenario.ts';
import { newToken } from './service.ts';
import type { Credential } from './service.ts';

type Structured = Record<string, unknown> & { kind: string };
export const seedClaimant = 'behaviour-seed';

export interface Controller {
  /** The release the service states in its instructions, which the Controller's own writes attest. */
  version: string;
  instructions: string;
  toolDescriptions: Record<string, string>;
  seed(map: SeedMap, onRevision?: (revision: number) => void): Promise<number>;
  /** Every Map in the catalog with its full history, paged to the end. */
  exportCatalog(): Promise<{ mapId: string; history: WireRevision[] }[]>;
  close(): Promise<void>;
}

/** Historical authors are independent credentials; none is handed to an agent under test. */
export function historyCredentials(maps: SeedMap[]): Record<string, Credential> {
  return Object.fromEntries([...new Set(maps.flatMap(m => (m.history ?? []).map(h => h.author)))].filter(a => a !== 'controller')
    .map(author => [author, { clientId: author, token: newToken() }]));
}

export async function connectController(port: number, token: string, historyTokens: Record<string, string> = {}): Promise<Controller> {
  const { client, initializeResult } = await createHttpTestClient(port, token);
  const historicalClients = new Map<string, typeof client>();
  const instructions = initializeResult.instructions ?? '';
  const version = /^version: (\S+)$/m.exec(instructions)?.[1];
  if (!version) throw new Error('the service instructions state no version');
  const toolDescriptions = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.description ?? '']));

  async function call(name: string, args: Record<string, unknown>, author = 'controller'): Promise<Structured> {
    let sender = client;
    if (author !== 'controller') {
      if (!Object.hasOwn(historyTokens, author)) throw new Error('No credential for historical author');
      let historical = historicalClients.get(author);
      if (!historical) {
        historical = (await createHttpTestClient(port, historyTokens[author]!)).client;
        historicalClients.set(author, historical);
      }
      sender = historical;
    }
    const result = await sender.callTool({ name, arguments: args });
    return result.structuredContent as Structured;
  }
  async function apply(mapId: string, expectedRevision: number, commands: unknown[], author = 'controller'): Promise<number> {
    const result = await call('map_apply', { version, mapId, expectedRevision, commands }, author);
    if (result.kind !== 'committed') throw new Error(`seed write refused: ${JSON.stringify(result)}`);
    return result.revision as number;
  }

  return {
    version, instructions, toolDescriptions,
    async seed(map, onRevision = () => undefined) {
      if (map.history?.some(h => h.author !== 'controller' && !Object.hasOwn(historyTokens, h.author))) throw new Error('No credential for historical author');
      const created = await call('map_create', { version, mapId: map.mapId, title: map.title, destination: map.destination, notes: map.notes });
      if (created.kind !== 'committed') throw new Error(`seed create refused: ${JSON.stringify(created)}`);
      let revision = created.revision as number;
      onRevision(revision);
      if (map.history) {
        for (const step of map.history) {
          revision = await apply(map.mapId, revision, step.commands, step.author);
          onRevision(revision);
        }
        const head = (await call('map_read', { mapId: map.mapId })).revision as WireRevision;
        if (!isDeepStrictEqual(expectedHead(map), observedHead(head.state))) throw new Error('History seed head differs from expected Tickets or content');
        return revision;
      }
      const content = (section: string, items: SeedMap['fog'] = []) => items.map(item =>
        ({ kind: 'content.add', section, item: { id: item.id, text: item.text, references: item.references ?? [] } }));
      const batch = [
        ...map.tickets.map(t => ({ kind: 'ticket.create', ticket: { id: t.id, title: t.title, question: t.question, type: t.type } })),
        ...map.tickets.flatMap(t => (t.prerequisites ?? []).map(p => ({ kind: 'dependency.add', dependentId: t.id, prerequisiteId: p }))),
        ...content('fog', map.fog), ...content('scopeExclusions', map.scopeExclusions),
      ];
      if (batch.length) { revision = await apply(map.mapId, revision, batch); onRevision(revision); }
      for (const t of settleOrder(map.tickets)) {
        revision = await apply(map.mapId, revision, [{ kind: 'claim.acquire', ticketId: t.id, claimantId: seedClaimant },
          { kind: 'ticket.settle', ticketId: t.id, ticketType: t.type, claimantId: seedClaimant, settlement: wireSettlement(t.settlement!) }]);
        onRevision(revision);
      }
      const claims = map.tickets.filter(t => t.claim).map(t => ({ kind: 'claim.acquire', ticketId: t.id, claimantId: t.claim }));
      if (claims.length) { revision = await apply(map.mapId, revision, claims); onRevision(revision); }
      return revision;
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
    close: async () => { await Promise.all([client, ...historicalClients.values()].map(c => c.close())); },
  };
}

function expectedHead(map: SeedMap) {
  return { tickets: map.tickets.map(t => ({ ...t, prerequisites: [...(t.prerequisites ?? [])].sort(), claim: t.claim ?? null,
    ...(t.settlement ? { settlement: wireSettlement(t.settlement) } : {}) })),
    fog: (map.fog ?? []).map(c => ({ ...c, references: c.references ?? [] })),
    scopeExclusions: (map.scopeExclusions ?? []).map(c => ({ ...c, references: c.references ?? [] })) };
}

function observedHead(state: WireState) {
  return { tickets: state.tickets.map(t => ({ id: t.id, title: t.title, question: t.question, type: t.type,
    prerequisites: [...t.prerequisites].sort(), claim: t.claim,
    ...(t.settlement ? { settlement: wireSettlement((({ introducedAtRevision: _, ...s }) => s)(t.settlement)) } : {}) })),
    fog: state.fog, scopeExclusions: state.scopeExclusions };
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
