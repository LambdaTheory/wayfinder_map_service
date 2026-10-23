// Read-only browser projection of one Revision. Never a mutation path.
import { calculateFrontier } from './frontier.js';
import type { ClaimantId, ClientId, MapContent, MapId, Revision, RevisionNumber, SemanticChange, StoredMapState,
  StoredSettlement, StoredTicket, TicketId, TicketType } from './types.js';

export type TicketState = 'waiting' | 'available' | 'inProgress' | 'settled';
export interface TicketView {
  readonly id: TicketId;
  readonly title: string;
  readonly question: string;
  readonly type: TicketType;
  readonly state: TicketState;
  readonly claimantId: ClaimantId | null;
  readonly layer: number;
  readonly row: number;
  readonly prerequisites: readonly TicketId[];
  readonly dependents: readonly TicketId[];
  readonly settlement: StoredSettlement<TicketType> | null;
}
export interface ChangeItem {
  readonly kind: string;
  readonly subjectId: string;
  readonly label?: string;
}
export interface MapView {
  readonly mapId: MapId;
  readonly title: string;
  readonly destination: string;
  readonly revision: RevisionNumber;
  readonly occurredAt: string;
  readonly clientId: ClientId;
  readonly tickets: readonly TicketView[];
  readonly fog: readonly MapContent[];
  readonly scopeExclusions: readonly MapContent[];
  readonly routeClear: boolean;
  readonly latest: readonly ChangeItem[];
}
export interface RevisionStamp {
  readonly revision: RevisionNumber;
  readonly occurredAt: string;
  readonly clientId: ClientId;
}

export function projectMap(current: Revision, previous: Revision | null): MapView {
  const { state } = current;
  const frontier = new Set(calculateFrontier(state));
  const layers = layerTickets(state.tickets);
  const dependents = new Map<TicketId, TicketId[]>(state.tickets.map(ticket => [ticket.id, []]));
  for (const ticket of state.tickets) for (const prerequisite of ticket.prerequisites) dependents.get(prerequisite)?.push(ticket.id);
  const tickets = state.tickets.map((ticket): TicketView => ({
    id: ticket.id, title: ticket.title, question: ticket.question, type: ticket.type,
    state: ticket.status === 'settled' ? 'settled' : ticket.claim !== null ? 'inProgress' : frontier.has(ticket.id) ? 'available' : 'waiting',
    claimantId: ticket.claim, ...layers.get(ticket.id)!, prerequisites: ticket.prerequisites,
    dependents: dependents.get(ticket.id)!, settlement: ticket.status === 'settled' ? ticket.settlement : null,
  }));
  // An empty route has not reached the Destination yet.
  const routeClear = state.fog.length === 0 && tickets.length > 0 && tickets.every(ticket => ticket.state === 'settled');
  return { mapId: current.mapId, title: state.title, destination: state.destination, revision: current.revision,
    occurredAt: current.author.occurredAt, clientId: current.author.clientId, tickets, fog: state.fog,
    scopeExclusions: state.scopeExclusions, routeClear,
    latest: oneDestinationChange(current.changes.map(change => classify(change, state, previous?.state))) };
}

// Changes name no patched field: the first map.update carries a Destination change, later ones stay map.update.
function oneDestinationChange(items: ChangeItem[]): ChangeItem[] {
  let named = false;
  return items.map(item => {
    if (item.kind !== 'destination.update') return item;
    if (named) return { ...item, kind: 'map.update' };
    named = true;
    return item;
  });
}

// Layer = longest prerequisite chain; rows keep Map order within a layer.
// Iterative like graph.ts: the domain already rejects cycles and dangling links.
export function layerTickets(tickets: readonly StoredTicket[]): ReadonlyMap<TicketId, { readonly layer: number; readonly row: number }> {
  const known = new Set(tickets.map(ticket => ticket.id));
  const remaining = new Map<TicketId, number>();
  const dependents = new Map<TicketId, TicketId[]>();
  for (const ticket of tickets) {
    const prerequisites = ticket.prerequisites.filter(identity => known.has(identity));
    remaining.set(ticket.id, prerequisites.length);
    for (const prerequisite of prerequisites) {
      const children = dependents.get(prerequisite) ?? [];
      children.push(ticket.id);
      dependents.set(prerequisite, children);
    }
  }
  const layer = new Map<TicketId, number>();
  const ready = [...remaining].filter(([, count]) => count === 0).map(([identity]) => identity);
  for (const identity of ready) layer.set(identity, 0);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const next = layer.get(ready[cursor]!)! + 1;
    for (const dependent of dependents.get(ready[cursor]!) ?? []) {
      layer.set(dependent, Math.max(layer.get(dependent) ?? 0, next));
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  const rows = new Map<number, number>();
  return new Map(tickets.map(ticket => {
    const value = layer.get(ticket.id) ?? 0;
    const row = rows.get(value) ?? 0;
    rows.set(value, row + 1);
    return [ticket.id, { layer: value, row }];
  }));
}

// content.* names no section: an addition is found in this Revision, a removal in the one before.
export function classify(change: SemanticChange, now: StoredMapState, before?: StoredMapState): ChangeItem {
  const { subjectId } = change;
  if (change.command === 'content.add' || change.command === 'content.update' || change.command === 'content.remove') {
    const states = change.command === 'content.remove' ? [before, now] : [now, before];
    for (const state of states) {
      for (const [section, items] of [['fog', state?.fog], ['scope', state?.scopeExclusions]] as const) {
        const item = items?.find(candidate => candidate.id === subjectId);
        if (item) return { kind: `${section}.${change.command.slice('content.'.length)}`, subjectId, label: item.text };
      }
    }
    return { kind: change.command, subjectId };
  }
  if (change.command === 'map.update') {
    return { kind: before && before.destination !== now.destination ? 'destination.update' : 'map.update', subjectId };
  }
  if (change.command === 'map.create') return { kind: 'map.create', subjectId };
  const ticket = now.tickets.find(candidate => candidate.id === subjectId) ?? before?.tickets.find(candidate => candidate.id === subjectId);
  return ticket ? { kind: change.command, subjectId, label: ticket.title } : { kind: change.command, subjectId };
}

export interface DestinationHistory {
  readonly created: RevisionStamp & { readonly destination: string };
  readonly changes: readonly (RevisionStamp & { readonly destination: string; readonly previous: string })[];
}

// The creating Revision is the Destination confirmation point (docs/spec/map-viewer.md §1).
export function destinationHistory(revisions: readonly Revision[]): DestinationHistory {
  const [first, ...later] = revisions;
  if (!first) throw new Error('Destination history requires the creating Revision');
  const changes = [];
  let previous = first.state.destination;
  for (const revision of later) {
    if (revision.state.destination === previous) continue;
    changes.push({ ...stamp(revision), destination: revision.state.destination, previous });
    previous = revision.state.destination;
  }
  return { created: { ...stamp(first), destination: first.state.destination }, changes };
}

// Start of the Fog item's current continuous presence, or null when the latest Revision has none.
export function fogAppearedAt(revisions: readonly Revision[], fogId: string): RevisionStamp | null {
  let appeared: Revision | undefined;
  for (let index = revisions.length - 1; index >= 0; index--) {
    if (!revisions[index]!.state.fog.some(item => item.id === fogId)) break;
    appeared = revisions[index];
  }
  return appeared ? stamp(appeared) : null;
}

function stamp(revision: Revision): RevisionStamp {
  return { revision: revision.revision, occurredAt: revision.author.occurredAt, clientId: revision.author.clientId };
}
