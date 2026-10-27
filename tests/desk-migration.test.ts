import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import { sqliteLifecycleForTests as legacyLifecycle } from './helpers/sqlite-v3.1.0.js';
import { parseId, prepareCreate } from '../src/index.js';
import { revisionFromPrepared } from '../src/revision-record.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function path(root = tmpdir()) { const dir = realpathSync(mkdtempSync(join(root, 'wayfinder-format-'))); cleanups.push(() => rmSync(dir, { recursive: true })); return join(dir, 'private', 'map.sqlite'); }
function id<K extends string>(kind: K, value: string) { const result = parseId(kind, value); if (result.kind !== 'ok') throw Error('id'); return result.value; }
function legacy(root?: string) {
  const dbPath = path(root); mkdirSync(dirname(dbPath), { mode: 0o700 }); writeFileSync(dbPath, '', { mode: 0o600 });
  const db = new DatabaseSync(dbPath); db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA application_id=1464225073; PRAGMA user_version=1;
    CREATE TABLE catalog (map_id TEXT PRIMARY KEY COLLATE BINARY, title TEXT NOT NULL, destination TEXT NOT NULL, head INTEGER NOT NULL);
    CREATE TABLE revisions (map_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(map_id, revision));`);
  const prepared = prepareCreate({ id: id('Map', 'Legacy'), title: 'Legacy', destination: 'Keep history', author: { actorId: id('Actor', 'a'), clientId: id('Client', 'c'), occurredAt: '2026-10-27T00:00:00Z' } });
  if (prepared.kind !== 'ok') throw Error('prepare'); const revision = revisionFromPrepared(prepared.value);
  db.prepare('INSERT INTO catalog VALUES (?, ?, ?, ?)').run('Legacy', 'Legacy', 'Keep history', 1);
  db.prepare('INSERT INTO revisions VALUES (?, ?, ?)').run('Legacy', 1, JSON.stringify(revision));
  return { dbPath, db, revision };
}
function inspect(dbPath: string) { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return { format: db.prepare('PRAGMA user_version').get()?.user_version,
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), records: db.prepare('SELECT record FROM revisions').all() }; } finally { db.close(); } }

test('fresh initialization is format 2; ordinary reopening makes no migration backup', () => {
  const dbPath = path(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(dbPath); lifecycle.open(dbPath, { migrate: true }).close();
  expect(inspect(dbPath)).toMatchObject({ format: 2, tables: ['catalog', 'desk_answers', 'desk_maps', 'desk_questions', 'reopen_requests', 'revisions'] });
  expect(readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format'))).toEqual([]);
});

test('format 1 migrates after a consistent private backup including committed WAL history, never rewrites old Revision JSON', async () => {
  const { dbPath, db, revision } = legacy();
  // Keep the legacy connection open: its committed writes still live in WAL.
  const before = inspect(dbPath); let backedUp = false;
  const lifecycle = sqliteLifecycleForTests({ afterBackup() { backedUp = true; expect(inspect(dbPath).format).toBe(1); },
    beforeMigrationCommit() { expect(backedUp).toBe(true); } });
  const storage = lifecycle.open(dbPath, { migrate: true }); db.close();
  try {
    expect(await storage.adapter.readRevision(id('Map', 'Legacy'), 1)).toEqual({ kind: 'found', value: revision });
    expect(storage.desk.inspect(id('Map', 'Legacy'))).toMatchObject({ kind: 'found', desk: { deskQuestions: [], reopenRequests: [], reopenContexts: [] } });
  } finally { storage.close(); }
  const names = readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format-2') && name.endsWith('.sqlite'));
  expect(names).toHaveLength(1); expect(names[0]).toMatch(/^map.sqlite.pre-format-2.\d{4}-.*\.[a-f0-9-]+\.sqlite$/);
  const backup = join(dirname(dbPath), names[0]!);
  expect(statSync(backup).mode & 0o777).toBe(0o600); expect(inspect(backup)).toEqual(before);
  expect(inspect(dbPath).records).toEqual(before.records);
  const backupBytes = readFileSync(backup); lifecycle.open(dbPath, { migrate: true }).close(); expect(readFileSync(backup)).toEqual(backupBytes);
});

test.each(['beforeBackup', 'afterBackup', 'beforeMigrationCommit'] as const)('%s failure admits nothing and leaves format 1 intact; backup artifacts survive', phase => {
  const { dbPath, db } = legacy(); db.close(); const before = inspect(dbPath);
  const backup = `${dbPath}.pre-format-2.test.sqlite`;
  const lifecycle = sqliteLifecycleForTests({ migrationBackupPath: backup, [phase]() { throw Error('controlled failure'); } });
  expect(() => lifecycle.open(dbPath, { migrate: true })).toThrow(); expect(inspect(dbPath)).toEqual(before);
  expect(existsSync(backup)).toBe(true);
  if (phase !== 'beforeBackup') expect(inspect(backup)).toEqual(before);
});

test.each(['existing', 'sidecar', 'permissions'] as const)('migration refuses %s backup target without changing the old format', kind => {
  const { dbPath, db } = legacy(); db.close(); const before = inspect(dbPath); const backup = `${dbPath}.pre-format-2.test.sqlite`;
  if (kind === 'existing') writeFileSync(backup, 'keep', { mode: 0o600 });
  else if (kind === 'sidecar') writeFileSync(backup + '-wal', 'keep', { mode: 0o600 });
  else chmodSync(dirname(dbPath), 0o755);
  expect(() => sqliteLifecycleForTests({ migrationBackupPath: backup }).open(dbPath, { migrate: true })).toThrow();
  expect(inspect(dbPath)).toEqual(before);
  if (kind === 'existing') expect(readFileSync(backup, 'utf8')).toBe('keep');
});

test('unknown newer format and an attempted downgrade are refused without creating a backup', () => {
  const dbPath = path(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(dbPath);
  let db = new DatabaseSync(dbPath); db.exec('PRAGMA user_version=99'); db.close();
  expect(() => lifecycle.open(dbPath, { migrate: true })).toThrow(); expect(inspect(dbPath).format).toBe(99);
  expect(readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format'))).toEqual([]);
  // Relabelling format 2 as 1 cannot drop/recreate desk tables or repair the database.
  db = new DatabaseSync(dbPath); db.exec('PRAGMA user_version=1'); db.close();
  expect(() => lifecycle.open(dbPath, { migrate: true })).toThrow(); expect(inspect(dbPath).format).toBe(1);
  expect(inspect(dbPath).tables).toContain('desk_answers');
});


test('opening format 1 without startup migration permission leaves it untouched', () => {
  const { dbPath, db } = legacy(); db.close(); const before = inspect(dbPath);
  expect(() => sqliteLifecycleForTests().open(dbPath)).toThrow('Not a supported Wayfinder SQLite database');
  expect(inspect(dbPath)).toEqual(before);
  expect(readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format'))).toEqual([]);
});

test('manual backup CLI preserves format 1 in both files while the legacy writer remains open', async () => {
  const root = join(homedir(), 'Library', 'Caches', 'wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { dbPath, db, revision } = legacy(root); cleanups.push(() => db.close());
  const before = inspect(dbPath); const destination = join(dirname(dbPath), 'manual.sqlite');
  // A backup needs no source write lock and must include the committed WAL.
  db.exec('BEGIN IMMEDIATE');
  try {
    const output = execFileSync('npm', ['run', '--silent', 'backup', '--', dbPath, destination], { encoding: 'utf8', stdio: 'pipe' });
    expect(output).toContain('SQLite backup completed');
    expect(output).not.toContain(dbPath); expect(output).not.toContain(destination);
  } finally { db.exec('ROLLBACK'); }
  expect(inspect(dbPath)).toEqual(before); expect(inspect(destination)).toEqual(before);
  expect(readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format'))).toEqual([]);
  for (const file of [dbPath, destination]) {
    const storage = legacyLifecycle().open(file);
    try {
      expect(await storage.adapter.readRevision(id('Map', 'Legacy'), 1)).toEqual({ kind: 'found', value: revision });
      expect(await storage.adapter.readCurrent(id('Map', 'Legacy'))).toEqual({ kind: 'found', value: revision.state });
    } finally { storage.close(); }
  }
}, 30_000);

test('read-only maintenance backup also preserves format 2 without startup migration', () => {
  const dbPath = path(); const lifecycle = sqliteLifecycleForTests(); lifecycle.initialize(dbPath);
  const before = inspect(dbPath); const destination = join(dirname(dbPath), 'manual.sqlite');
  lifecycle.backup(dbPath, destination);
  expect(inspect(dbPath)).toEqual(before); expect(inspect(destination)).toEqual(before);
  expect(readdirSync(dirname(dbPath)).filter(name => name.includes('pre-format'))).toEqual([]);
});
