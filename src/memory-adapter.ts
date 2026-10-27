import { prepareApply } from './create.js';
import { emptyDesk } from './desk-types.js';
import type { DeskState } from './desk-types.js';
import type { PreparedCommit } from './create.js';
import type { CommitResult, MapId, ReadResult, Revision, RevisionNumber, StoredMapState } from './types.js';
import { invalid, validateId } from './values.js';
import { calculateFrontier } from './frontier.js';
import { capturePrepared, revisionFromPrepared } from './revision-record.js';

export interface StateAdapter {
  readCurrent(mapId: MapId): Promise<ReadResult<StoredMapState>>;
  readRevision(mapId: MapId, revision: RevisionNumber): Promise<ReadResult<Revision>>;
  commit(prepared: PreparedCommit): Promise<CommitResult>;
}

export function createMemoryAdapter(): StateAdapter {
  return memoryAdapter();
}

// Internal synchronous fault seam: not re-exported from the public index.
export function createMemoryAdapterWithFault(beforePublication: () => void): StateAdapter {
  return memoryAdapter(beforePublication);
}

function memoryAdapter(beforePublication?: () => void): StateAdapter {
  const desks = new Map<MapId, DeskState>();
  const records = new Map<MapId, { readonly head: Revision; readonly history: ReadonlyMap<number, Revision> }>();
  return {
    async readCurrent(mapId) {
      const error = validateId(mapId, ['mapId']);
      if (error) return { kind: 'rejected', error };
      const record = records.get(mapId);
      return record ? { kind: 'found', value: record.head.state }
        : { kind: 'not_found', code: 'map_not_found', mapId };
    },
    async readRevision(mapId, revision) {
      const error = validateId(mapId, ['mapId']);
      if (error) return { kind: 'rejected', error };
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        return { kind: 'rejected', error: invalid(['revision'], 'Positive safe integer required') };
      }
      const record = records.get(mapId);
      if (!record) return { kind: 'not_found', code: 'map_not_found', mapId };
      const historical = record.history.get(revision);
      return historical ? { kind: 'found', value: historical }
        : { kind: 'not_found', code: 'revision_not_found', mapId, revision };
    },
    async commit(prepared) {
      // Capture before any possible async yield; check and publication have no gap.
      let captured = capturePrepared(prepared);
      const previous = records.get(captured.mapId);
      if (captured.kind === 'create' && previous) {
        return { kind: 'rejected', code: 'map_already_exists', mapId: captured.mapId };
      }
      if (captured.kind === 'apply') {
        if (!previous) return { kind: 'rejected', code: 'map_not_found', mapId: captured.mapId };
        if (previous.head.revision !== captured.priorRevision) return { kind: 'conflict', conflict: {
          mapId: captured.mapId, expectedRevision: captured.priorRevision, currentRevision: previous.head.revision,
        } };
      }
      if (captured.kind === 'apply' && captured.request && previous) {
        const rechecked = prepareApply(previous.head.state, captured.request, desks.get(captured.mapId) ?? emptyDesk);
        if (rechecked.kind !== 'prepared') return rechecked;
        captured = rechecked.change;
      }
      const revision = revisionFromPrepared(captured);
      const history = new Map(previous?.history);
      history.set(revision.revision, revision);
      const frontier = calculateFrontier(revision.state);
      beforePublication?.();
      if (captured.desk) desks.set(captured.mapId, captured.desk);
      records.set(captured.mapId, { head: revision, history });
      return { kind: 'committed', revision, frontier };
    },
  };
}
