// Deliberately separate from openSQLite: that operator API configures a writable connection.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Revision } from '../../../src/types.ts';
import { CaptureError } from './errors.ts';

export function openCaptureDatabase(path: string): DatabaseSync {
  // Inspect bytes without SQLite: even a read-only WAL connection may create -wal/-shm.
  // Capture accepts a quiescent, rollback-journal private copy, never a live WAL source.
  const descriptor = openSync(path, 'r');
  const header = Buffer.alloc(20);
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new CaptureError('Unsupported SQLite header');
  } finally { closeSync(descriptor); }
  if (header[18] !== 1 || header[19] !== 1 || ['-wal', '-shm', '-journal'].some(suffix => existsSync(path + suffix))) {
    throw new CaptureError('Capture requires a quiescent private database copy in DELETE journal mode without sidecars; do not open this source directly');
  }
  const uri = pathToFileURL(resolve(path));
  uri.searchParams.set('mode', 'ro');
  return new DatabaseSync(uri.href, { readOnly: true, timeout: 100 });
}

function hasDeskHistory(record: Revision): boolean {
  return !!record.state.deskQuestions?.length
    || record.state.tickets.some(ticket => ticket.status === 'settled' && ticket.settlement.deskAnswer !== undefined)
    || record.changes.some(change => change.command.startsWith('deskQuestion.') || change.command === 'reopenRequest.close');
}

/** One read transaction, bound parameters, no initialization, migration, checkpoint or writable adapter. */
export function readCaptureSource(path: string, mapId: string, revision: number, history: boolean): { revisions: Revision[]; gaps: string[] } {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new CaptureError('Revision must be a positive safe integer');
  const db = openCaptureDatabase(path);
  try {
    db.exec('BEGIN');
    const format = db.prepare('PRAGMA user_version').get()?.user_version;
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x57464d31
      || (format !== 1 && format !== 2)) throw new CaptureError('Unsupported Wayfinder database format');
    // Check presence only, across the database: desk payloads are outside the current B04 capture contract.
    const gaps = format === 2 && ['desk_questions', 'desk_answers', 'reopen_requests', 'desk_maps']
      .some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      ? ['答题台状态未采集 (Answer Desk state not captured): this database contains desk records, possibly on another Map; desk tables and their state are outside the current capture contract.'] : [];
    const head = db.prepare('SELECT head FROM catalog WHERE map_id=?').get(mapId);
    if (!head || Number(head.head) < revision) throw new CaptureError('Source Map or Revision not found');
    const rows = db.prepare('SELECT revision, record FROM revisions WHERE map_id=? AND revision BETWEEN ? AND ? ORDER BY revision')
      .all(mapId, history || format === 2 ? 1 : revision, revision);
    if (rows.length !== (history || format === 2 ? revision : 1)) throw new CaptureError('Source history has missing Revisions');
    const records = rows.map(row => {
      const r = JSON.parse(row.record as string) as Revision;
      if (r.mapId !== mapId || r.state.id !== mapId || r.revision !== row.revision || r.state.currentRevision !== r.revision
        || r.priorRevision !== (r.revision === 1 ? null : r.revision - 1)
        || r.kind !== (r.revision === 1 ? 'create' : 'apply')) throw new CaptureError('Inconsistent source Revision');
      // Even visible-state capture must not silently lose earlier desk-only Revisions.
      if (hasDeskHistory(r)) throw new CaptureError('这张图含答题台历史，当前采集工具尚不支持 (Selected Map has Answer Desk history; desk-history conversion is not implemented)');
      return r;
    });
    return { revisions: history ? records : records.slice(-1), gaps };
  } finally { db.close(); }
}
