import { createServer, request } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { serveLocalMcp } from '../src/mcp-http-internal.js';
import { sqliteLifecycleForTests } from '../src/sqlite-internal.js';
import { prepareCreate, prepareApply } from '../src/index.js';
import type { Command, MapId, NonEmpty, Revision, MutationAuthor } from '../src/types.js';
import { createViewerKey } from '../src/viewer-key.js';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test.skipIf(process.platform === 'win32')('POSIX key publication still replaces an existing owner-read-only key', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'viewer-key-posix-')));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  chmodSync(directory, 0o700);
  const path = join(directory, 'key');
  writeFileSync(path, 'old-process-key', { mode: 0o400 });
  const key = createViewerKey(path);
  key.publish();
  expect(key.accepts(readFileSync(path, 'utf8'))).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  key.remove();
  expect(existsSync(path)).toBe(false);
});
const token = 'synthetic-mcp-token-not-a-browser-key';
const mapId = 'Desk.Test' as MapId;
const author = { actorId: 'test', clientId: 'test', occurredAt: '2026-10-27T00:00:00.000Z' } as MutationAuthor;
const question = (name = 'A', triage = 'needsKun') => ({ kind: 'deskQuestion.post', ticketId: name, claimantId: 'worker', question: {
  questionId: `Q.${name}`, options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }],
  recommendedOption: 1, recommendedAnswer: 'Choose the first complete answer.', whyKun: 'A tradeoff', triage, triageReason: 'Choose', gatesResearch: false,
} });
const create = (name: string) => ({ kind: 'ticket.create', ticket: { id: name, type: 'grilling', title: name, question: `${name}?` } });
const claim = (name: string) => ({ kind: 'claim.acquire', ticketId: name, claimantId: 'worker' });
const settle = (name: string, answer?: { answerId: string; questionVersion: number }) => ({ kind: 'ticket.settle', ticketId: name, claimantId: 'worker', ticketType: 'grilling',
  settlement: { outcome: { kind: 'decision', statement: 'One', rationale: 'Confirmed' }, evidence: [], references: [], provenance: { method: 'test', sources: [] }, extensions: {} },
  ...(answer ? { deskAnswer: { answerId: answer.answerId, questionVersion: answer.questionVersion } } : {}),
});
async function freePort() {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port; await new Promise<void>(r => server.close(() => r())); return port;
}
async function fixture(enabled?: boolean) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'viewer-desk-'))); cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'maps.sqlite'); let now = Date.parse(author.occurredAt);
  const lifecycle = sqliteLifecycleForTests({ now: () => new Date(now).toISOString() }); lifecycle.initialize(path);
  let storage = lifecycle.open(path); const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const keyPath = join(directory, 'private', 'answer-key');
  const config = { databasePath: path, port, token, actorId: 'test', clientId: 'test', answerDeskKeyPath: keyPath, ...(enabled === undefined ? {} : { answerDeskEnabled: enabled }) };
  let running = await serveLocalMcp(storage, config); cleanups.push(() => running.stop());
  const created = prepareCreate({ id: mapId, title: 'Synthetic desk', destination: 'Choose', author });
  if (created.kind !== 'ok') throw Error('bad fixture'); await storage.adapter.commit(created.value);
  async function apply(commands: unknown[]) {
    const state = await storage.adapter.readCurrent(mapId); if (state.kind !== 'found') throw Error('missing fixture');
    const prepared = prepareApply(state.value, { mapId, expectedRevision: state.value.currentRevision, author, commands: commands as unknown as NonEmpty<Command> }, storage.desk.read(mapId));
    if (prepared.kind !== 'prepared') throw Error(JSON.stringify(prepared));
    const committed = await storage.adapter.commit(prepared.change); if (committed.kind !== 'committed') throw Error(JSON.stringify(committed));
    return committed.revision;
  }
  function http(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
    const body = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    return new Promise<{status: number; body: string; headers: Record<string, unknown>; json: () => any}>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(body && !headers['Transfer-Encoding'] ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', s => text += s); res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers, json: () => JSON.parse(text) }));
      }); req.on('error', reject); req.end(body);
    });
  }
  const write = (value: unknown, headers: Record<string, string> = {}) => http('/api/desk', 'POST', value, {
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
    ...(existsSync(keyPath) ? { 'X-Wayfinder-Key': readFileSync(keyPath, 'utf8') } : {}), ...headers,
  });
  const answer = (name = 'A', choice: unknown = { option: 1 }, version = 1) => ({ action: 'answer', mapId, submissions: [{ questionId: `Q.${name}`, questionVersion: version, choice }] });
  const view = async (known = 0) => http(`/api/maps/${mapId}/view?known=${known}`);
  const head = async () => { const s = await storage.adapter.readCurrent(mapId); if (s.kind !== 'found') throw Error('missing'); return s.value.currentRevision; };
  const history = async () => { const result: Revision[] = []; for (let n = 1; n <= await head(); n++) { const r = await storage.adapter.readRevision(mapId, n); if (r.kind === 'found') result.push(r.value); } return result; };
  return { directory, path, keyPath, origin, http, write, answer, view, apply, head, history,
    get storage() { return storage; }, get running() { return running; }, tick() { now += 15000; },
    async restart() { await running.stop(); storage = lifecycle.open(path); running = await serveLocalMcp(storage, config); },
  };
}

test('the default service provides the keyed desk; explicit disable is refused', async () => {
  const f = await fixture();
  expect(existsSync(f.keyPath)).toBe(true);
  expect((await f.view()).json()).toHaveProperty('desk');
  await expect(fixture(false)).rejects.toMatchObject({ code: 'answer_desk_required' });
});
test('one keyed entry: no token substitution, query keys, cross-origin, Host, unkeyed writes or general mutations', async () => {
  const f = await fixture(true); await f.apply([create('A'), claim('A'), question()]);
  const before = await f.history(); const value = f.answer();
  for (const headers of [
    { 'X-Wayfinder-Key': '' }, { 'X-Wayfinder-Key': token }, { 'X-Wayfinder-Key': 'wrong' },
    { Origin: 'http://evil.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'evil.test' },
  ]) expect((await f.write(value, headers)).status).toBe(403);
  expect((await f.http(`/api/desk?key=${readFileSync(f.keyPath, 'utf8')}`, 'POST', value)).status).toBe(404);
  expect((await f.http('/api/desk', 'GET')).status).toBe(405);
  expect((await f.http('/api/desk', 'OPTIONS')).status).toBe(405);
  for (const path of ['/', `/maps/${mapId}`, `/api/maps/${mapId}/view`, '/viewer/desk.js']) expect((await f.http(path, 'POST', value)).status).toBe(405);
  for (const action of ['map_apply', 'take', 'settle', 'deskQuestion.post']) expect((await f.write({ action, mapId })).status).toBe(400);
  expect((await f.write({ ...value, commands: [] })).status).toBe(400);
  expect((await f.write(value, { 'Content-Type': 'text/plain' })).status).toBe(415);
  expect((await f.write('{')).status).toBe(400);
  expect((await f.write(f.answer('A', { text: ' \n ' }))).status).toBe(400);
  for (const headers of [{}, { 'Transfer-Encoding': 'chunked' }]) {
    const refused = await f.write(' '.repeat(1_048_577), headers);
    expect(refused.status).toBe(413); expect(refused.json()).toEqual({ error: 'request_too_large' });
  }
  expect(await f.history()).toEqual(before); expect(f.storage.desk.read(mapId).answers).toEqual([]);
  const result = await f.write(value); expect(result.status).toBe(200);
  expect(result.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' });
  expect(result.headers).not.toHaveProperty('access-control-allow-origin');
  expect(JSON.stringify(await f.history())).not.toContain(readFileSync(f.keyPath, 'utf8'));
  expect(f.running.metadataStatus().observations).toBe(0);
});

test('answers, edits, Taken and withdrawal poll without a Revision; old publication and bulk failure never silently retarget', async () => {
  const f = await fixture(true); await f.apply([create('A'), claim('A'), question(), create('B'), claim('B'), question('B', 'followRecommendation')]);
  const before = await f.history(); const head = await f.head();
  expect((await f.write(f.answer())).status).toBe(200);
  let view = (await f.view(head)).json(); expect(view.desk.deskQuestions[0].state).toBe('answered');
  f.tick(); f.storage.desk.takeEligible(mapId, 'worker' as any);
  view = (await f.view(head)).json(); expect(view.desk.deskQuestions[0].state).toBe('taken');
  expect((await f.write(f.answer('A', { text: 'Need evidence' }))).status).toBe(200);
  view = (await f.view(head)).json(); expect(view.desk.deskQuestions[0]).toMatchObject({ state: 'answered', currentAnswer: { choice: { text: 'Need evidence' } } });
  expect(view.desk.deskQuestions[0].answerHistory).toHaveLength(2); expect(await f.history()).toEqual(before);
  await f.apply([{ kind: 'deskQuestion.withdraw', ticketId: 'A', claimantId: 'worker', questionId: 'Q.A', questionVersion: 1, reason: 'Need a new premise' }, question()]);
  const desk = f.storage.desk.read(mapId);
  expect((await f.write({ action: 'answer', mapId, submissions: [f.answer('B').submissions[0], f.answer().submissions[0]] })).status).toBe(409);
  expect(f.storage.desk.read(mapId)).toEqual(desk);
  expect((await f.write(f.answer('A', { option: 2 }, 2))).status).toBe(200);
  expect((await f.view(head)).json().desk.deskQuestions).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'withdrawn', withdrawnReason: 'Need a new premise' })]));
});


test('bulk confirmation admits only pending followRecommendation questions and their displayed recommendation', async () => {
  const f = await fixture(true);
  await f.apply([create('A'), claim('A'), question(), create('B'), claim('B'), question('B', 'followRecommendation'), create('C'), claim('C'), question('C', 'followRecommendation')]);
  const batch = (one: unknown, two: unknown) => ({ action: 'answer', mapId, submissions: [one, two] });
  expect((await f.write(batch(f.answer().submissions[0], f.answer('B').submissions[0]))).status).toBe(400);
  expect((await f.write(batch(f.answer('B').submissions[0], f.answer('C', { option: 2 }).submissions[0]))).status).toBe(400);
  expect(f.storage.desk.read(mapId).answers).toEqual([]);
  expect((await f.write(batch(f.answer('B').submissions[0], f.answer('C').submissions[0]))).status).toBe(200);
  expect(f.storage.desk.read(mapId).answers.map(a => a.ticketId)).toEqual(['B', 'C']);
});

test('Reopen shows exact Settlement bindings; changed list refuses, cancellation and replacement stay outside Revisions', async () => {
  const f = await fixture(true); await f.apply([create('A'), claim('A'), question()]);
  const submitted = (await f.write(f.answer())).json().value[0]; f.tick(); f.storage.desk.takeEligible(mapId, 'worker' as any);
  await f.apply([settle('A', submitted), create('B'), { kind: 'dependency.add', dependentId: 'B', prerequisiteId: 'A' }, claim('B'), settle('B')]);
  let targets = (await f.view()).json().desk.reopenTargets;
  expect(targets[0]).toMatchObject({ ticketId: 'A', affectedTickets: ['B'], source: { questionId: 'Q.A', questionVersion: 1 } });
  expect(targets[1]).not.toHaveProperty('source');
  const submission = (target: any) => ({ ticketId: target.ticketId, settlementIntroducedAtRevision: target.settlementIntroducedAtRevision,
    affectedTickets: target.affectedTickets, affectedSettlementRevisions: target.affectedSettlementRevisions,
    requested: { option: 2, label: 'Two', questionId: 'Q.A', questionVersion: 1 } });
  const old = submission(targets[0]);
  await f.apply([{ kind: 'ticket.reopen', ticketId: 'B', reason: 'New verdict' }, claim('B'), settle('B')]);
  const deskBefore = f.storage.desk.read(mapId);
  expect((await f.write({ action: 'reopen', mapId, submission: old })).json()).toEqual({ error: 'list_changed' });
  expect(f.storage.desk.read(mapId)).toEqual(deskBefore);
  targets = (await f.view()).json().desk.reopenTargets; const history = await f.history();
  const posted = await f.write({ action: 'reopen', mapId, submission: submission(targets[0]) }); expect(posted.status).toBe(200);
  const first = posted.json().value.requestId;
  expect((await f.write({ action: 'cancelReopen', mapId, requestId: first })).status).toBe(200);
  expect((await f.view()).json().desk.reopenRequests).toEqual([]);
  const next = (await f.write({ action: 'reopen', mapId, submission: submission(targets[0]) })).json().value;
  f.tick(); f.storage.desk.takeEligible(mapId, 'worker' as any);
  expect((await f.write({ action: 'cancelReopen', mapId, requestId: next.requestId })).json()).toEqual({ error: 'request_not_pending' });
  expect((await f.write({ action: 'reopen', mapId, submission: { ...submission(targets[0]), requested: { text: 'Reconsider' } } })).status).toBe(200);
  expect((await f.view()).json().desk.reopenRequests).toHaveLength(1); expect(await f.history()).toEqual(history);
});

test('service restart rotates key and never returns it from reads, assets, errors, Map state or metadata', async () => {
  const f = await fixture(true); await f.apply([create('A'), claim('A'), question()]);
  const key = readFileSync(f.keyPath, 'utf8'); expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(key).not.toBe(token);
  expect(statSync(f.keyPath).mode & 0o777).toBe(0o600);
  for (const path of ['/', `/maps/${mapId}`, '/api/maps', `/api/maps/${mapId}/view`, '/viewer/desk.js', '/viewer/viewer.js', '/answer-key']) {
    expect((await f.http(path)).body).not.toContain(key);
  }
  await f.restart(); expect(readFileSync(f.keyPath, 'utf8')).not.toBe(key);
  expect((await f.write(f.answer(), { 'X-Wayfinder-Key': key })).status).toBe(403);
  expect((await f.write(f.answer())).status).toBe(200);
  await f.running.stop(); expect(existsSync(f.keyPath)).toBe(false);
});

test('key publication refuses shared directories and symlinks without overwriting their targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'viewer-key-')); cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'key'); chmodSync(directory, 0o755); expect(() => createViewerKey(path).publish()).toThrow();
  chmodSync(directory, 0o700); const target = join(directory, 'target'); writeFileSync(target, 'do not overwrite', { mode: 0o600 }); symlinkSync(target, path);
  expect(() => createViewerKey(path).publish()).toThrow(); expect(readFileSync(target, 'utf8')).toBe('do not overwrite');
});

test('launcher hands the key only to the browser and refuses disabled/unsafe handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-desk-')); cleanups.push(() => rmSync(root, { recursive: true }));
  expect(execFileSync('python3', ['tests/helpers/launcher-desk.py'], { encoding: 'utf8', env: { ...process.env,
    HOME: root, WAYFINDER_AGENT_STATE_ROOT: root, WAYFINDER_AGENT_SERVICE_DIR: join(root, 'svc'), WAYFINDER_AGENT_OUTPUTS: join(root, 'outputs'),
  } })).toContain('launcher desk verified');
});
