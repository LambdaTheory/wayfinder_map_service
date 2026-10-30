import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { assertCanonicalPrivatePath, assertPrivate, makePrivateDirectory } from '../src/private-paths.js';
import { initializeSQLite, openSQLite, backupSQLite } from '../src/sqlite-storage.js';
import { appendPrivateMetadata } from '../src/call-metadata.js';
import { createViewerKey } from '../src/viewer-key.js';
import { DatabaseSync } from 'node:sqlite';
import { prepareCreate } from '../src/index.js';
import { revisionFromPrepared } from '../src/revision-record.js';
import type { MapId, MutationAuthor } from '../src/types.js';

const windows = test.skipIf(process.platform !== 'win32');
const roots: string[] = [];
function fixture() {
  const root = join(homedir(), '.wayfinder-windows-tests', randomUUID());
  makePrivateDirectory(join(root, '私有 空间')); roots.push(root); return join(root, '私有 空间', 'data', 'maps.sqlite');
}
// Only synthetic paths are passed over stdin. ACL changes are confined to each
// fresh fixture; the runtime never repairs unsafe existing user data.
function publicRead(path: string, rights: 'Read' | 'Modify' = 'Read', inheritOnly = false) {
  const inheritance = inheritOnly ? "'ContainerInherit,ObjectInherit','InheritOnly'," : '';
  const source = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); $p=[Console]::In.ReadToEnd(); $item=Get-Item -LiteralPath $p -Force; $acl=$item.GetAccessControl(); $sid=[Security.Principal.SecurityIdentifier]'S-1-1-0'; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'${rights}',${inheritance}'Allow'))); $item.SetAccessControl($acl)`;
  execFileSync(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { input: path, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
}
afterEach(() => { for (const root of roots.splice(0)) {
  if (!root.startsWith(join(homedir(), '.wayfinder-windows-tests') + '\\')) throw Error('Unsafe test cleanup');
  rmSync(root, { recursive: true, force: true });
} });

windows('private NTFS initialize/reopen/sidecars/consistent backup and metadata/key lifecycle', () => {
  const path = fixture(); initializeSQLite(path);
  const storage = openSQLite(path);
  try {
    for (const name of [path, path + '-wal', path + '-shm']) assertPrivate(name, false);
    const destination = join(dirname(path), 'backup.sqlite'); backupSQLite(path, destination);
    const backup = openSQLite(destination); expect(backup.listMaps()).toMatchObject({ kind: 'listed', maps: [] }); backup.close();
    expect(() => backupSQLite(path, destination)).toThrow();
    const log = path + '.calls.jsonl'; appendPrivateMetadata(log, { synthetic: true }); assertPrivate(log, false);
    const keyPath = join(dirname(path), 'key'); const key = createViewerKey(keyPath); key.publish();
    expect(key.accepts(readFileSync(keyPath, 'utf8'))).toBe(true); assertPrivate(keyPath, false); key.remove(); expect(existsSync(keyPath)).toBe(false);
  } finally { storage.close(); }
  openSQLite(path).close();
}, 120000);

windows.each(['parent', 'database', 'wal'] as const)('refuse public-read %s ACL without changing bytes', target => {
  const path = fixture(); initializeSQLite(path); const storage = openSQLite(path);
  try {
    const before = readFileSync(path); publicRead(target === 'parent' ? dirname(path) : target === 'wal' ? path + '-wal' : path);
    expect(() => openSQLite(path)).toThrow(); expect(readFileSync(path)).toEqual(before);
    if (target === 'parent') expect(() => createViewerKey(join(dirname(path), 'bad-key')).publish()).toThrow();
  } finally { storage.close(); }
}, 60000);

windows('reject directory junctions and hardlinked databases', () => {
  const path = fixture(); initializeSQLite(path);
  const alias = join(dirname(dirname(path)), 'alias'); symlinkSync(dirname(path), alias, 'junction');
  expect(() => openSQLite(join(alias, 'maps.sqlite'))).toThrow();
  const link = join(dirname(path), 'hardlink.sqlite'); linkSync(path, link);
  expect(() => openSQLite(link)).toThrow(); expect(() => openSQLite(path)).toThrow();
}, 60000);

windows('reject an untrusted writable ancestor even with a private immediate parent', () => {
  const path = fixture(); initializeSQLite(path);
  publicRead(dirname(dirname(path)), 'Modify');
  expect(() => openSQLite(path)).toThrow();
  expect(() => createViewerKey(join(dirname(path), 'bad-key')).publish()).toThrow();
  expect(() => appendPrivateMetadata(path + '.calls.jsonl', {})).toThrow();
}, 60000);

windows('inheritable public ACL is rejected before a key or metadata file can be created', () => {
  const path = fixture(); initializeSQLite(path);
  publicRead(dirname(path), 'Read', true);
  const before = readdirSync(dirname(path));
  expect(() => createViewerKey(join(dirname(path), 'must-not-publish')).publish()).toThrow();
  expect(() => appendPrivateMetadata(path + '.calls.jsonl', {})).toThrow();
  expect(readdirSync(dirname(path))).toEqual(before);
}, 60000);

windows('format 1 startup migration retains immutable history and a private readable format 1 backup', async () => {
  const path = fixture(); makePrivateDirectory(dirname(path));
  const prepared = prepareCreate({ id: 'Legacy.Windows' as MapId, title: 'Legacy', destination: 'Preserve history',
    author: { actorId: 'test', clientId: 'test', occurredAt: '2026-10-30T00:00:00Z' } as MutationAuthor });
  if (prepared.kind !== 'ok') throw Error('fixture');
  const revision = revisionFromPrepared(prepared.value); const json = JSON.stringify(revision);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA application_id=1464225073; PRAGMA user_version=1; PRAGMA journal_mode=WAL;
    CREATE TABLE catalog(map_id TEXT PRIMARY KEY COLLATE BINARY,title TEXT NOT NULL,destination TEXT NOT NULL,head INTEGER NOT NULL);
    CREATE TABLE revisions(map_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(map_id,revision));`);
  db.prepare('INSERT INTO catalog VALUES(?,?,?,?)').run('Legacy.Windows', 'Legacy', 'Preserve history', 1);
  db.prepare('INSERT INTO revisions VALUES(?,?,?)').run('Legacy.Windows', 1, json);
  try {
    const storage = openSQLite(path, { migrate: true });
    expect(await storage.adapter.readRevision('Legacy.Windows' as MapId, 1)).toEqual({ kind: 'found', value: revision }); storage.close();
    const name = readdirSync(dirname(path)).find(name => name.includes('.pre-format-2.') && name.endsWith('.sqlite'));
    expect(name).toBeDefined(); const backupPath = join(dirname(path), name!); assertPrivate(backupPath, false);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(1); expect(backup.prepare('SELECT record FROM revisions').get()?.record).toBe(json); }
    finally { backup.close(); }
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(db.prepare('SELECT record FROM revisions').get()?.record).toBe(json);
  } finally { db.close(); }
}, 120000);

windows('reject UNC/device/ADS/DOS/trailing aliases and production repository/temp paths', () => {
  for (const path of ['relative.sqlite', '\\\\server\\share\\maps.sqlite', '\\\\?\\C:\\maps.sqlite', 'C:\\maps.sqlite:stream',
    'C:\\private\\NUL.sqlite', 'C:\\private.\\maps.sqlite', 'C:\\private\\maps.sqlite ', 'C:\\private\\..\\maps.sqlite']) {
    expect(() => assertCanonicalPrivatePath(path)).toThrow();
  }
  const absentDrive = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index) + ':\\').find(drive => !existsSync(drive));
  if (absentDrive) expect(() => assertCanonicalPrivatePath(join(absentDrive, 'private', 'maps.sqlite'))).toThrow();
  const repo = join(process.cwd(), 'must-not-create.sqlite');
  const temp = join(tmpdir(), 'must-not-create.sqlite');
  for (const path of [repo, temp]) { expect(() => initializeSQLite(path)).toThrow(); expect(existsSync(path)).toBe(false); }
});
