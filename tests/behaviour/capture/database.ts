// Deliberately separate from openSQLite: that operator API configures a writable connection.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Revision } from '../../../src/types.ts';
import { CaptureError } from './errors.ts';

export function openCaptureDatabase(path: string): DatabaseSync {
  const uri = pathToFileURL(resolve(path));
  uri.searchParams.set('mode', 'ro');
  return new DatabaseSync(uri.href, { readOnly: true, timeout: 100 });
}

/** One read transaction, bound parameters, no initialization, migration, checkpoint or writable adapter. */
export function readRevisions(path: string, mapId: string, revision: number, history: boolean): Revision[] {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new CaptureError('Revision must be a positive safe integer');
  const db = openCaptureDatabase(path);
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x57464d31
      || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new CaptureError('Unsupported Wayfinder database format');
    const head = db.prepare('SELECT head FROM catalog WHERE map_id=?').get(mapId);
    if (!head || Number(head.head) < revision) throw new CaptureError('Source Map or Revision not found');
    const rows = db.prepare('SELECT revision, record FROM revisions WHERE map_id=? AND revision BETWEEN ? AND ? ORDER BY revision')
      .all(mapId, history ? 1 : revision, revision);
    if (rows.length !== (history ? revision : 1)) throw new CaptureError('Source history has missing Revisions');
    return rows.map(row => {
      const r = JSON.parse(row.record as string) as Revision;
      if (r.mapId !== mapId || r.state.id !== mapId || r.revision !== row.revision || r.state.currentRevision !== r.revision
        || r.priorRevision !== (r.revision === 1 ? null : r.revision - 1)
        || r.kind !== (r.revision === 1 ? 'create' : 'apply')) throw new CaptureError('Inconsistent source Revision');
      return r;
    });
  } finally { db.close(); }
}
