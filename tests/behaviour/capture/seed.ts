import { CaptureError } from './errors.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Command, Revision, StoredMapState, StoredTicket, NonEmpty } from '../../../src/types.ts';
import type { SeedMap, SeedTicket } from '../scenario.ts';

import { captureDomain } from './domain.ts';
import { visibleSeedSteps } from '../seeds/steps.ts';

export interface ClaimChoice { ticketId: string; action: 'keep' | 'clear'; reason: string }
export interface HistoryOverride { revision: number; commands: Command[]; reason: string; evidence: string }
export const seedAuthor = { actorId: 'capture', clientId: 'capture', occurredAt: '2026-01-01T00:00:00Z' } as Revision['author'];

function settlement(ticket: StoredTicket) {
  if (ticket.status !== 'settled') throw new CaptureError('Expected a settled Ticket');
  const { introducedAtRevision: _, ...value } = ticket.settlement;
  return value;
}

/** B01's state format cannot carry Map/Ticket/Settlement extensions; never silently discard nonempty ones. */
export function visibleMap(state: StoredMapState): SeedMap {
  if (Object.keys(state.extensions).length || state.tickets.some(t => Object.keys(t.extensions).length
    || (t.status === 'settled' && Object.keys(t.settlement.extensions).length))) {
    throw new CaptureError('Nonempty extensions need an explicit Scenario format decision; capture cannot discard them');
  }
  return { mapId: state.id, title: state.title, destination: state.destination, notes: state.notes,
    tickets: state.tickets.map(t => {
      const result: SeedTicket = { id: t.id, title: t.title, question: t.question, type: t.type };
      if (t.prerequisites.length) result.prerequisites = [...t.prerequisites];
      if (t.claim) result.claim = t.claim;
      if (t.status === 'settled') {
        const { extensions: _, ...value } = settlement(t);
        result.settlement = structuredClone(value) as unknown as NonNullable<SeedTicket['settlement']>;
      }
      return result;
    }), fog: state.fog.map(c => ({ ...c, references: [...c.references] })),
    scopeExclusions: state.scopeExclusions.map(c => ({ ...c, references: [...c.references] })) };
}

export function applySeedCommands(state: StoredMapState, commands: unknown[], author = seedAuthor): StoredMapState {
  const result = captureDomain().prepareApply(state, { mapId: state.id, expectedRevision: state.currentRevision, author,
    commands: commands as unknown as NonEmpty<Command> });
  if (result.kind !== 'prepared') throw new CaptureError('Seed commands cannot be replayed under the current domain contract');
  return result.change.next;
}

export function createSeedState(map: SeedMap, author = seedAuthor): StoredMapState {
  const result = captureDomain().prepareCreate({ id: map.mapId as StoredMapState['id'], title: map.title,
    destination: map.destination, notes: map.notes, author });
  if (result.kind !== 'ok') throw new CaptureError('Seed creation is invalid');
  return result.value.next;
}

/** Validate a state seed through real domain commands, including prerequisite-order Settlements. */
export function replayVisible(map: SeedMap): StoredMapState {
  let state = createSeedState(map);
  for (const commands of visibleSeedSteps(map)) state = applySeedCommands(state, commands);
  return state;
}

/** Reconstruct only arguments determined by stored Revision states. Ambiguous transient arguments require evidence. */
function reconstruct(before: StoredMapState, r: Revision): Command[] {
  let interim = before;
  return r.changes.map((change, index) => {
    const next = r.state.tickets.find(t => t.id === change.subjectId);
    const old = interim.tickets.find(t => t.id === change.subjectId);
    const access = old?.claim ? { claimantId: old.claim } : {};
    let command: Command | undefined;
    switch (change.command) {
      case 'map.update': command = { kind: 'map.update', patch: { title: r.state.title, destination: r.state.destination, notes: r.state.notes, extensions: r.state.extensions } }; break;
      case 'ticket.create': if (next) command = { kind: 'ticket.create', ticket: { id: next.id, title: next.title, question: next.question, type: next.type, extensions: next.extensions } }; break;
      case 'ticket.update': if (next && old) command = { kind: 'ticket.update', ticketId: old.id, patch: { title: next.title, question: next.question, type: next.type, extensions: next.extensions }, ...access }; break;
      case 'ticket.settle': if (next?.status === 'settled' && old?.claim) command = { kind: 'ticket.settle', ticketId: next.id, ticketType: next.type, claimantId: old.claim, settlement: settlement(next) } as Command; break;
      case 'ticket.reopen': if (old && change.reason) command = { kind: 'ticket.reopen', ticketId: old.id, reason: change.reason }; break;
      case 'claim.acquire': {
        // A later release/clear/settle can erase this Claimant even when another Claim is visible at the head.
        const overwritten = r.changes.slice(index + 1).some(c => c.subjectId === change.subjectId
          && /^(claim\.|ticket\.(settle|reopen)$)/.test(c.command));
        if (next?.claim && !overwritten) command = { kind: 'claim.acquire', ticketId: next.id, claimantId: next.claim };
        break;
      }
      case 'claim.release': if (old?.claim) command = { kind: 'claim.release', ticketId: old.id, claimantId: old.claim, ...(change.reason ? { reason: change.reason } : {}) }; break;
      case 'claim.clear': if (old?.claim && change.reason) command = { kind: 'claim.clear', ticketId: old.id, expectedClaimantId: old.claim, reason: change.reason }; break;
      case 'dependency.add': case 'dependency.remove': {
        if (!old || !next) break;
        const candidates = change.command === 'dependency.add' ? next.prerequisites.filter(p => !old.prerequisites.includes(p))
          : old.prerequisites.filter(p => !next.prerequisites.includes(p));
        if (candidates.length === 1) command = { kind: change.command, dependentId: old.id, prerequisiteId: candidates[0]!, ...access };
        break;
      }
      case 'content.add': case 'content.update': case 'content.remove': {
        const source = change.command === 'content.remove' ? interim : r.state;
        for (const section of ['fog', 'scopeExclusions'] as const) {
          const item = source[section].find(c => c.id === change.subjectId);
          if (item) command = change.command === 'content.remove' ? { kind: change.command, section, itemId: item.id }
            : { kind: change.command, section, item };
        }
        break;
      }
    }
    if (!command) throw new CaptureError(`Revision ${r.revision} has ambiguous command arguments; provide a documented history override`);
    const result = captureDomain().applyCommand(interim, command, index);
    if (result.kind !== 'ok') throw new CaptureError(`Revision ${r.revision} needs a documented history override`);
    interim = result.value;
    return command;
  });
}

export function historyMap(records: Revision[], overrides: HistoryOverride[]): { map: SeedMap; verified: number[] } {
  const first = records[0]!;
  if (records.length < 2) throw new CaptureError('Creation-only history has no history steps; select current-visible-state');
  if (records.slice(1).some(r => r.author.clientId === 'controller')) {
    throw new CaptureError('Historical client ID controller is reserved for the Controller role in the B01 seed format; an explicit format decision is required');
  }
  const map = visibleMap(records.at(-1)!.state);
  // SeedMap's top-level fields are map_create inputs; its Ticket/content arrays describe the expected head.
  Object.assign(map, { title: first.state.title, destination: first.state.destination, notes: first.state.notes });
  let state = createSeedState(map, first.author);
  if (!isDeepStrictEqual(state, first.state)) throw new CaptureError('Initial Revision cannot be represented by this seed format');
  if (new Set(overrides.map(o => o.revision)).size !== overrides.length
    || overrides.some(o => !o.reason?.trim() || !o.evidence?.trim() || !records.slice(1).some(r => r.revision === o.revision))) {
    throw new CaptureError('History overrides require unique existing apply Revisions, reasons and evidence');
  }
  map.history = records.slice(1).map(r => {
    const commands = overrides.find(o => o.revision === r.revision)?.commands ?? reconstruct(state, r);
    state = applySeedCommands(state, commands, r.author);
    if (!isDeepStrictEqual(state, r.state)) throw new CaptureError(`Revision ${r.revision} replay differs from its source Revision state`);
    return { author: r.author.clientId, commands };
  });
  return { map, verified: records.map(r => r.revision) };
}
