import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { prepareApply, prepareCreate } from '../../../src/index.ts';
import type { Command, MapId, NonEmpty, TicketId } from '../../../src/types.ts';
import { startLocalMcpService } from '../../../src/mcp-service.ts';
import { backupSQLite, initializeSQLite, openSQLite } from '../../../src/sqlite-storage.ts';
import type { SQLiteStorage } from '../../../src/sqlite-storage.ts';
import { initializeSQLite as initializeLegacy, openSQLite as openLegacy } from '../../helpers/sqlite-v3.1.0.ts';
import { freePort, newToken } from '../runner/service.ts';
import { captureProblem } from './capture.ts';
import type { CaptureInput } from './capture.ts';
import { seedAuthor } from './seed.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const mapId = 'Capture.Format' as MapId;
type SeedStorage = Pick<SQLiteStorage, 'adapter'> & Partial<Pick<SQLiteStorage, 'desk'>>;

function directory() {
  const root = join(homedir(), 'Library', 'Caches', 'wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(root, 'capture-format-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function format(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('PRAGMA user_version').get()?.user_version; } finally { db.close(); }
}
async function apply(storage: SeedStorage, id: MapId, commands: [unknown, ...unknown[]]) {
  const current = await storage.adapter.readCurrent(id);
  if (current.kind !== 'found') throw Error('fixture Map missing');
  const prepared = prepareApply(current.value, { mapId: id, expectedRevision: current.value.currentRevision,
    author: seedAuthor, commands: commands as NonEmpty<Command> }, storage.desk?.read(id));
  if (prepared.kind !== 'prepared') throw Error(`fixture prepare: ${JSON.stringify(prepared)}`);
  const committed = await storage.adapter.commit(prepared.change);
  if (committed.kind !== 'committed') throw Error('fixture commit failed');
  return committed.revision;
}
async function seed(storage: SeedStorage, id = mapId) {
  const created = prepareCreate({ id, title: 'Capture upgrade', destination: 'Keep Map history', author: seedAuthor });
  if (created.kind !== 'ok') throw Error('fixture creation failed');
  expect((await storage.adapter.commit(created.value)).kind).toBe('committed');
  await apply(storage, id, [{ kind: 'ticket.create', ticket: { id: 'A', title: 'Route', question: 'Which route?', type: 'grilling' } }]);
  await apply(storage, id, [{ kind: 'claim.acquire', ticketId: 'A', claimantId: 'worker' }]);
}
const settlement = { outcome: { kind: 'decision', statement: 'First route', rationale: 'Synthetic human verdict' },
  evidence: [], references: [], provenance: { method: 'fixture', sources: [] }, extensions: {} };
const settle = { kind: 'ticket.settle', ticketId: 'A', ticketType: 'grilling', claimantId: 'worker', settlement };
const post = { kind: 'deskQuestion.post', ticketId: 'A', claimantId: 'worker', question: { questionId: 'Q.A',
  options: [{ label: 'One', description: 'First route' }, { label: 'Two', description: 'Second route' }],
  recommendedOption: 1, recommendedAnswer: 'First route', whyKun: 'Synthetic choice', triage: 'needsKun', triageReason: 'A choice', gatesResearch: false } };
function request(restores: CaptureInput['restores'] = 'history', revision = 4): CaptureInput {
  return { id: 'CaptureFormat', title: 'Capture format upgrade', origin: 'Synthetic fixture', date: '2026-10-27',
    mapId, revision, restores, sessionRef: 'synthetic#capture', humanWords: 'What is next?', replayContext: '',
    originalCombination: 'codex:synthetic', originalConditions: { entry: 'mcp-only', effort: 'xhigh' },
    applies: { entries: ['mcp-only'], needs: [] }, purpose: 'Preserve the same ordinary Map history across migration',
    claims: [], redactions: [], reproductions: [],
    verdict: { target: 'Keep accepted history', basis: 'Synthetic ruling',
      mustNot: [{ id: 'rewrite', text: 'Rewrites history', criterion: 'Did it rewrite history?' }],
      expect: [{ id: 'answer', text: 'Answers the question', criterion: 'Did it answer?' }] } };
}
function copy(source: string, name: string) {
  const path = join(dirname(source), `${name}.sqlite`);
  backupSQLite(source, path);
  // Normalize only the new disposable backup, never its source.
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode=DELETE'); } finally { db.close(); }
  return path;
}
function cli(path: string, input: CaptureInput, name: string) {
  const dir = dirname(path), manifest = join(dir, `${name}.json`), out = join(dir, name);
  writeFileSync(manifest, JSON.stringify(input), { mode: 0o600 });
  const before = readFileSync(path);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.ts', import.meta.url)), path, manifest, out], { encoding: 'utf8' });
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(dir).filter(file => file.startsWith(`${path.slice(dir.length + 1)}-`))).toEqual([]);
  return { ...result, out };
}
function output(out: string) {
  return Object.fromEntries(['seed.json', 'scenario.json', 'capture.json'].map(name => [name, readFileSync(join(out, name), 'utf8')]));
}
async function fresh() {
  const path = join(directory(), 'source.sqlite');
  initializeSQLite(path);
  const storage = openSQLite(path); cleanups.push(() => storage.close());
  await seed(storage); await apply(storage, mapId, [settle]);
  return { path, storage };
}

test.each(['history', 'current-visible-state'] as const)('service migration from initialized format 1 preserves the complete %s capture', async restores => {
  const path = join(directory(), 'source.sqlite');
  initializeLegacy(path);
  const legacy = openLegacy(path);
  try { await seed(legacy); await apply(legacy, mapId, [settle]); } finally { legacy.close(); }
  const before = copy(path, 'before'); expect(format(before)).toBe(1);
  const captured = cli(before, request(restores), 'before-capture');
  expect(captured.status, captured.stderr).toBe(0);
  const service = await startLocalMcpService({ databasePath: path, port: await freePort(), token: newToken(),
    actorId: 'capture-test', clientId: 'capture-test' });
  try { expect(format(path)).toBe(2); } finally { await service.stop(); }
  const after = copy(path, 'after'); expect(format(after)).toBe(2);
  const migrated = cli(after, request(restores), 'after-capture');
  expect(migrated.status, migrated.stderr).toBe(0);
  expect(migrated.stdout).toBe(captured.stdout);
  expect(output(migrated.out)).toEqual(output(captured.out));
  expect(JSON.parse(output(migrated.out)['capture.json']!).verification.sourceRevisionsVerified)
    .toEqual(restores === 'history' ? [1, 2, 3, 4] : [4]);
});

test.each(['another Map used the desk', 'target Map has only a Reopen Request'])('%s: capture succeeds and every output records the omission', async situation => {
  const { path, storage } = await fresh();
  const ordinary = captureProblem(copy(path, 'ordinary'), request());
  if (situation === 'another Map used the desk') {
    const other = 'Other.Map' as MapId;
    await seed(storage, other); await apply(storage, other, [post]);
    expect(storage.desk.submitAnswers(other, [{ questionId: 'Q.A', questionVersion: 1,
      choice: { text: '/Users/synthetic/desk-only-private-material' } }]).kind).toBe('updated');
  } else {
    expect(storage.desk.fileReopenRequest(mapId, { ticketId: 'A' as TicketId, settlementIntroducedAtRevision: 4,
      affectedTickets: [], affectedSettlementRevisions: {}, requested: { text: '/Users/synthetic/desk-only-private-material' } }).kind).toBe('updated');
  }
  const backup = copy(path, 'with-desk');
  const result = cli(backup, request(), 'with-desk-capture');
  expect(result.status, result.stderr).toBe(0);
  const files = output(result.out), summary = JSON.parse(result.stdout);
  expect(summary.gaps).toHaveLength(1);
  expect(summary.gaps[0]).toContain('答题台状态未采集');
  for (const text of [...Object.values(files), result.stdout]) {
    expect(text).toContain('答题台状态未采集');
    expect(text).not.toContain('desk-only-private-material');
  }
  const captured = JSON.parse(files['capture.json']!);
  expect(captured.gaps).toEqual(summary.gaps);
  expect(captured.history).toEqual(ordinary.record.history);
  expect(captured.verification).toEqual(ordinary.record.verification);
  expect(JSON.parse(files['seed.json']!).maps).toEqual(ordinary.seed.maps);
});

test.each(['desk_questions', 'desk_answers', 'reopen_requests', 'desk_maps'] as const)('a row in %s alone is sufficient to record the gap', async table => {
  const { path } = await fresh();
  const db = new DatabaseSync(path);
  try {
    const inserts = {
      desk_questions: "INSERT INTO desk_questions VALUES ('Other', 'Q', 1, '{}')",
      desk_answers: "INSERT INTO desk_answers VALUES ('Other', 'A', '{}')",
      reopen_requests: "INSERT INTO reopen_requests VALUES ('Other', 'R', '{}')",
      desk_maps: "INSERT INTO desk_maps VALUES ('Other', '2026-10-27T00:00:00Z')",
    };
    db.exec(inserts[table]);
  } finally { db.close(); }
  expect(captureProblem(copy(path, 'copy'), request()).record.gaps).toEqual([expect.stringContaining('答题台状态未采集')]);
});

test.each(['history', 'current-visible-state'] as const)('selected Map desk history is explicitly refused for %s without output or source mutation', async restores => {
  const path = join(directory(), 'source.sqlite'); initializeSQLite(path);
  const storage = openSQLite(path); cleanups.push(() => storage.close());
  await seed(storage); await apply(storage, mapId, [post]);
  const backup = copy(path, 'copy');
  const result = cli(backup, { ...request(restores), claims: [{ ticketId: 'A', action: 'keep', reason: 'Keep the existing Claim' }] }, 'refused');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('这张图含答题台历史，当前采集工具尚不支持');
  expect(result.stdout).toBe('');
  expect(readdirSync(dirname(path))).not.toContain('refused');
  // A selected Revision before desk use remains capturable, with the database-wide gap.
  expect(captureProblem(backup, request(restores, 2)).record.gaps).toHaveLength(1);
});

test.each(['history', 'current-visible-state'] as const)('an earlier desk-only Revision cannot disappear from %s capture', async restores => {
  const { path, storage } = await fresh();
  const filed = storage.desk.fileReopenRequest(mapId, { ticketId: 'A' as TicketId, settlementIntroducedAtRevision: 4,
    affectedTickets: [], affectedSettlementRevisions: {}, requested: { text: 'Reconsider' } });
  if (filed.kind !== 'updated') throw Error('fixture request failed');
  await apply(storage, mapId, [{ kind: 'ticket.reopen', ticketId: 'A', reason: 'Conversation verdict' }]);
  await apply(storage, mapId, [{ kind: 'reopenRequest.close', requestId: filed.value.requestId, reason: 'Already reopened' }]);
  const last = await apply(storage, mapId, [{ kind: 'map.update', patch: { notes: 'Ordinary latest change' } }]);
  expect(last.state.deskQuestions).toBeUndefined();
  const result = cli(copy(path, 'copy'), request(restores, last.revision), 'refused');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('这张图含答题台历史，当前采集工具尚不支持');
  expect(result.stdout).toBe('');
  expect(readdirSync(dirname(path))).not.toContain('refused');
});

test.each([0, 3, 99])('unknown format %i remains refused without changing the copy', async version => {
  const { path } = await fresh(); const backup = copy(path, 'copy');
  const db = new DatabaseSync(backup); db.exec(`PRAGMA user_version=${version}`); db.close();
  const result = cli(backup, request(), 'refused');
  expect(result.status).toBe(1); expect(result.stderr).toContain('Unsupported Wayfinder database format');
  expect(readdirSync(dirname(path))).not.toContain('refused');
});
