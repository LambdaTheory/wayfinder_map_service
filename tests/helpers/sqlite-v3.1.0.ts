// Frozen v3.1.0 SQLite implementation (033b6f9), for format-1 compatibility tests.
// Only relative imports are adjusted; keep this implementation unchanged.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { StateAdapter } from '../../src/memory-adapter.js';
import type { InvalidInput, MapId, Revision, StoredMapState } from '../../src/types.js';
import { immutableClone } from '../../src/immutable.js';
import { calculateFrontier } from '../../src/frontier.js';
import { invalid, validateId } from '../../src/values.js';
import { capturePrepared, revisionFromPrepared } from '../../src/revision-record.js';

const APPLICATION_ID = 0x57464d31;
const FORMAT_VERSION = 1;
export interface SQLiteStorage {
  readonly adapter: StateAdapter;
  listMaps(args?: { readonly limit?: number; readonly afterMapId?: MapId }): ListedMaps | { readonly kind: 'rejected'; readonly error: InvalidInput };
  backup(destination: string): void;
  close(): void;
}
export interface MapIndex {
  readonly mapId: MapId;
  readonly title: string;
  readonly destination: string;
  readonly currentRevision: number;
}
export interface ListedMaps {
  readonly kind: 'listed';
  readonly maps: readonly MapIndex[];
  readonly nextAfterMapId: MapId | null;
}
export class SQLiteFailure extends Error {
  readonly code: 'storage_busy' | 'storage_failure';
  constructor(readonly outcome: 'not_published' | 'unknown', readonly requiresRestart: boolean, cause: unknown) {
    super('SQLite operation failed', { cause });
    this.name = 'SQLiteFailure';
    this.code = typeof cause === 'object' && cause !== null && 'errcode' in cause
      && typeof cause.errcode === 'number' && (cause.errcode & 0xff) === 5 ? 'storage_busy' : 'storage_failure';
  }
}

function connect(path: string) {
  const uri = pathToFileURL(path);
  uri.searchParams.set('mode', 'rw');
  return new DatabaseSync(uri.href, { timeout: 100 });
}

function checkPath(path: string, temporary: boolean, initializing: boolean) {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0')) throw new Error('Canonical absolute SQLite path required');
  let component = parse(path).root;
  for (const segment of path.slice(component.length).split(sep)) {
    component = join(component, segment);
    try {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink()) throw new Error('SQLite path must not contain symlinks');
      if (component !== path && (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))) {
        throw new Error('Unsafe SQLite ancestor ownership or writable permissions');
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!temporary) {
    const roots = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/private/var/folders'].filter(existsSync).map(root => realpathSync(root)))];
    if (roots.some(root => path === root || path.startsWith(root + sep))) throw new Error('Temporary canonical SQLite storage is forbidden');
    for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
      if (existsSync(join(ancestor, '.git'))) throw new Error('SQLite storage must be outside repositories/worktrees');
      if (ancestor === dirname(ancestor)) break;
    }
  }
  const parent = dirname(path);
  if (existsSync(parent)) checkPrivate(parent, true);
  else if (!initializing) throw new Error('SQLite directory is missing');
  if (existsSync(path)) checkPrivate(path, false);
  else if (!initializing) throw new Error('SQLite database is missing; explicit initialization required');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(path + suffix); checkPrivate(path + suffix, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let existing = parent;
  while (!existsSync(existing)) existing = dirname(existing);
  const localDisk = process.platform === 'darwin'
    ? !!execFileSync('/bin/df', ['-P', '-T', 'apfs,hfs', existing], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    : process.platform === 'linux' && [0xef53, 0x58465342, 0x9123683e].includes(statfsSync(existing).type);
  if (!localDisk) throw new Error('Supported local-disk filesystem required');
}

function checkPrivate(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error('Unsafe SQLite ownership or permissions');
}

function initialize(path: string, temporary = false) {
  requireRuntime();
  checkPath(path, temporary, true);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Recheck newly created ancestry before reserving/opening the DB.
  checkPath(path, temporary, true);
  closeSync(openSync(path, 'wx', 0o600));
  checkPrivate(dirname(path), true);
  checkPrivate(path, false);
  const db = connect(path);
  try {
    configure(db);
    db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT_VERSION};
      CREATE TABLE catalog (map_id TEXT PRIMARY KEY COLLATE BINARY, title TEXT NOT NULL, destination TEXT NOT NULL, head INTEGER NOT NULL);
      CREATE TABLE revisions (map_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(map_id, revision)); COMMIT;`);
  } finally { db.close(); }
}

function configure(db: DatabaseSync) {
  if (db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') throw new Error('SQLite WAL is required');
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=100');
  if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 2
    || db.prepare('PRAGMA busy_timeout').get()?.timeout !== 100) throw new Error('Required SQLite settings unavailable');
}

interface TestFaults {
  readonly beforePublication?: () => void;
  readonly afterPublication?: () => void;
  readonly beforeRollback?: () => void;
  readonly beforeBackup?: () => void;
  readonly afterBackup?: () => void;
}

function recognizeFormat(db: DatabaseSync) {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
    || db.prepare('PRAGMA user_version').get()?.user_version !== FORMAT_VERSION) {
    throw new Error('Not a supported Wayfinder SQLite database');
  }
  // Ordinary format recognition, never a history/integrity audit.
  db.prepare('SELECT map_id, title, destination, head FROM catalog LIMIT 0');
  db.prepare('SELECT map_id, revision, record FROM revisions LIMIT 0');
}

function open(path: string, temporary = false, faults: TestFaults = {}): SQLiteStorage {
  requireRuntime();
  checkPath(path, temporary, false);
  const db = connect(path);
  try {
    recognizeFormat(db);
    configure(db);
  } catch (error) { db.close(); throw error; }
  let usable = true;
  function stopConnection() {
    usable = false;
    try { db.close(); } catch { /* No subsequent operations, even when close fails. */ }
  }
  function requireUsable() { if (!usable) throw new Error('SQLite connection closed or unusable; reopen required'); }
  const adapter: StateAdapter = {
    async readCurrent(mapId) {
      requireUsable();
      const error = validateId(mapId, ['mapId']);
      if (error) return { kind: 'rejected', error };
      const row = db.prepare('SELECT record FROM revisions JOIN catalog ON revisions.map_id=catalog.map_id AND revision=head WHERE catalog.map_id=?').get(mapId);
      return row ? { kind: 'found', value: immutableClone((JSON.parse(row.record as string) as {state: StoredMapState}).state) }
        : { kind: 'not_found', code: 'map_not_found', mapId };
    },
    async readRevision(mapId, revision) {
      requireUsable();
      const error = validateId(mapId, ['mapId']);
      if (error) return { kind: 'rejected', error };
      if (!Number.isSafeInteger(revision) || revision <= 0) return { kind: 'rejected', error: invalid(['revision'], 'Positive safe integer required') };
      const row = db.prepare('SELECT record FROM revisions WHERE map_id=? AND revision=?').get(mapId, revision);
      if (row) return { kind: 'found', value: immutableClone(JSON.parse(row.record as string) as Revision) };
      return db.prepare('SELECT head FROM catalog WHERE map_id=?').get(mapId)
        ? { kind: 'not_found', code: 'revision_not_found', mapId, revision }
        : { kind: 'not_found', code: 'map_not_found', mapId };
    },
    async commit(prepared) {
      requireUsable();
      const captured = capturePrepared(prepared);
      const revision = revisionFromPrepared(captured);
      const frontier = calculateFrontier(revision.state);
      let committing = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        const previous = db.prepare('SELECT head FROM catalog WHERE map_id=?').get(captured.mapId);
        if (captured.kind === 'create' && previous) {
          db.exec('ROLLBACK');
          return { kind: 'rejected', code: 'map_already_exists', mapId: captured.mapId };
        }
        if (captured.kind === 'apply') {
          if (!previous) { db.exec('ROLLBACK'); return { kind: 'rejected', code: 'map_not_found', mapId: captured.mapId }; }
          if (previous.head !== captured.priorRevision) {
            db.exec('ROLLBACK');
            return { kind: 'conflict', conflict: { mapId: captured.mapId, expectedRevision: captured.priorRevision, currentRevision: previous.head as number } };
          }
        }
        db.prepare('INSERT INTO revisions VALUES (?, ?, ?)').run(revision.mapId, revision.revision, JSON.stringify(revision));
        if (captured.kind === 'create') db.prepare('INSERT INTO catalog VALUES (?, ?, ?, ?)').run(revision.mapId, revision.state.title, revision.state.destination, revision.revision);
        else db.prepare('UPDATE catalog SET title=?, destination=?, head=? WHERE map_id=?').run(revision.state.title, revision.state.destination, revision.revision, revision.mapId);
        faults.beforePublication?.();
        committing = true;
        db.exec('COMMIT');
        faults.afterPublication?.();
        return { kind: 'committed', revision, frontier };
      } catch (error) {
        const unknownOutcome = committing && !db.isTransaction;
        try {
          if (db.isTransaction) { faults.beforeRollback?.(); db.exec('ROLLBACK'); }
        } catch {
          stopConnection();
          throw new SQLiteFailure(committing ? 'unknown' : 'not_published', true, error);
        }
        if (unknownOutcome) {
          stopConnection();
          throw new SQLiteFailure('unknown', true, error);
        }
        throw new SQLiteFailure('not_published', false, error);
      }
    },
  };
  return { adapter, backup(destination) {
    requireUsable();
    if (['', '-wal', '-shm', '-journal'].some(suffix => destination === path + suffix)) {
      throw new Error('Active SQLite storage is not a backup destination');
    }
    // Reserve only our own fresh empty file. VACUUM INTO refuses nonempty files;
    // private ancestry prevents other users replacing the reserved destination.
    checkPath(destination, temporary, true);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { lstatSync(destination + suffix); throw new Error('Backup target or sidecar already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    checkPath(destination, temporary, true);
    closeSync(openSync(destination, 'wx', 0o600));
    try {
      faults.beforeBackup?.();
      // SQLite's synchronous consistent snapshot mechanism; never raw-file copying,
      // command replay, or an additional driver/Worker. FULL syncs the output.
      db.prepare('VACUUM INTO ?').run(pathToFileURL(destination).href);
      faults.afterBackup?.();
      checkPath(destination, temporary, false);
      const completed = new DatabaseSync(pathToFileURL(destination), { readOnly: true });
      try { recognizeFormat(completed); }
      finally { completed.close(); }
    } catch (error) {
      // Leave the fresh artifact for explicit operator inspection; never call it
      // successful or remove an older backup. Source mutations are not replayed.
      throw new Error('SQLite backup failed; output is not a confirmed backup', { cause: error });
    }
  }, close() { if (usable) { usable = false; db.close(); } }, listMaps(args = {}) {
    requireUsable();
    const limit = args.limit === undefined ? 20 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { kind: 'rejected', error: invalid(['limit'], 'Integer from 1 through 100 required') };
    if (args.afterMapId !== undefined) {
      const error = validateId(args.afterMapId, ['afterMapId']);
      if (error) return { kind: 'rejected', error };
    }
    const rows = db.prepare('SELECT map_id, title, destination, head FROM catalog WHERE map_id > ? COLLATE BINARY ORDER BY map_id COLLATE BINARY LIMIT ?').all(args.afterMapId ?? '', limit + 1);
    const maps = rows.slice(0, limit).map(row => ({ mapId: row.map_id as MapId, title: row.title as string,
      destination: row.destination as string, currentRevision: row.head as number }));
    return immutableClone({ kind: 'listed', maps, nextAfterMapId: rows.length > limit ? maps.at(-1)!.mapId : null });
  } };
}

function requireRuntime() {
  if (process.versions.node !== '26.3.0') throw new Error('Wayfinder SQLite requires Node.js 26.3.0');
}

// Internal disposable-storage seam; never exported by the operator entry point.
export function sqliteLifecycleForTests(faults: TestFaults | (() => void) = {}) {
  return { initialize: (path: string) => initialize(path, true),
    open: (path: string) => open(path, true, typeof faults === 'function' ? { beforePublication: faults } : faults) };
}
export function initializeSQLite(path: string): void { initialize(path); }
export function openSQLite(path: string): SQLiteStorage { return open(path); }
