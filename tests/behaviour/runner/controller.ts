import { requireDirectRuntime } from './direct-runtime.ts';
// The Controller: seeds Maps before the first turn and reads the evidence after the last, with its own
// credential. Its writes follow the current release contract; it never writes for the agent (R2, R3).
import { createHttpTestClient } from '../../helpers/mcp-http-client.mjs';
import { isDeepStrictEqual } from 'node:util';
import type { EventRecord, WireRevision, WireState } from '../evidence.ts';
import type { SeedMap } from '../scenario.ts';
import { visibleSeedSteps, wireSettlement } from '../seeds/steps.ts';
import { newToken } from './service.ts';
import type { Credential } from './service.ts';

type Structured = Record<string, unknown> & { kind: string };
export { seedClaimant } from '../seeds/steps.ts';

export interface Controller {
  /** The release the service states in its instructions, which the Controller's own writes attest. */
  version: string;
  instructions: string;
  toolDescriptions: Record<string, string>;
  seed(map: SeedMap, onRevision?: (revision: number) => void): Promise<number>;
  conflictingWrite(mapId: string, id: string): Promise<void>;
  /** Every Map in the catalog with its full history, paged to the end. */
  exportCatalog(): Promise<{ mapId: string; history: WireRevision[] }[]>;
  close(): Promise<void>;
}

/** Historical authors are independent credentials; none is handed to an agent under test. */
export function historyCredentials(maps: SeedMap[], reservedClientIds: string[]): Record<string, Credential> {
  const authors = [...new Set(maps.flatMap(m => (m.history ?? []).map(h => h.author)))].filter(a => a !== 'controller');
  if (authors.some(author => reservedClientIds.includes(author))) throw new Error('Historical author client ID collision with Controller or agent session');
  return Object.fromEntries(authors.map(author => [author, { clientId: author, token: newToken() }]));
}

export async function connectController(port: number, token: string, historyTokens: Record<string, string> = {}, observe: (event: EventRecord) => void = () => undefined): Promise<Controller> {
  requireDirectRuntime();
  const { client, initializeResult } = await createHttpTestClient(port, token);
  const historicalClients = new Map<string, typeof client>();
  const instructions = initializeResult.instructions ?? '';
  const version = /^version: (\S+)$/m.exec(instructions)?.[1];
  if (!version) throw new Error('the service instructions state no version');
  const toolDescriptions = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.description ?? '']));

  let callId = 0;
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
    const base = { seq: 0, at: new Date().toISOString(), actor: 'controller' as const, session: null, turn: null,
      kind: 'tool-call' as const, callId: `controller:${callId++}`, server: 'wayfinder', tool: name, arguments: args,
      requestId: { known: false as const, reason: 'SDK request ID not exposed' } };
    try {
      const result = await sender.callTool({ name, arguments: args });
      observe({ ...base, result: { known: true, value: result.structuredContent }, failed: !!result.isError });
      return result.structuredContent as Structured;
    } catch (error) { observe({ ...base, result: { known: false, reason: String(error) }, failed: true }); throw error; }
  }
  async function apply(mapId: string, expectedRevision: number, commands: unknown[], author = 'controller'): Promise<number> {
    const result = await call('map_apply', { version, mapId, expectedRevision, commands }, author);
    if (result.kind !== 'committed') throw new Error(`seed write refused: ${JSON.stringify(result)}`);
    return result.revision as number;
  }

  return {
    version, instructions, toolDescriptions,
    async seed(map, onRevision = () => undefined) {
      try {
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
          if (!isDeepStrictEqual(expectedHead(map), observedHead(head.state))) throw new Error('History seed head differs from expected Map text, Tickets or content');
          return revision;
        }
        for (const commands of visibleSeedSteps(map)) {
          revision = await apply(map.mapId, revision, commands);
          onRevision(revision);
        }
        return revision;
      } catch (error) {
        // The write may have committed before its reply was lost. Recover the boundary, but retain setup failure.
        try {
          const current = await call('map_read', { mapId: map.mapId });
          if (current.kind === 'found') onRevision((current.revision as WireRevision).revision);
        } catch { /* runAttempt's final catalog export recovers it if this read also fails. */ }
        throw error;
      }
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
    close: async () => { await Promise.all([client, ...historicalClients.values()].map(c => c.close())); },
  };
}

function expectedHead(map: SeedMap) {
  const text = { title: map.title, destination: map.destination, notes: map.notes };
  for (const step of map.history ?? []) for (const value of step.commands) {
    const command = value as { kind?: string; patch?: Partial<typeof text> };
    if (command.kind === 'map.update') for (const key of ['title', 'destination', 'notes'] as const) {
      if (command.patch?.[key] !== undefined) text[key] = command.patch[key];
    }
  }
  return { ...text, tickets: map.tickets.map(t => ({ ...t, prerequisites: [...(t.prerequisites ?? [])].sort(), claim: t.claim ?? null,
    ...(t.settlement ? { settlement: wireSettlement(t.settlement) } : {}) })),
    fog: (map.fog ?? []).map(c => ({ ...c, references: c.references ?? [] })),
    scopeExclusions: (map.scopeExclusions ?? []).map(c => ({ ...c, references: c.references ?? [] })) };
}

function observedHead(state: WireState) {
  return { title: state.title, destination: state.destination, notes: state.notes,
    tickets: state.tickets.map(t => ({ id: t.id, title: t.title, question: t.question, type: t.type,
    prerequisites: [...t.prerequisites].sort(), claim: t.claim,
    ...(t.settlement ? { settlement: wireSettlement((({ introducedAtRevision: _, ...s }) => s)(t.settlement)) } : {}) })),
    fog: state.fog, scopeExclusions: state.scopeExclusions };
}
