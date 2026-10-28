// Synthetic B07 operator check. Run after npm run build, with pinned Node; no models, tunnels or existing state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeSQLite } from '../../dist/sqlite-storage.js';
import { workflowContract } from '../../dist/workflow.generated.js';

assert.equal(process.versions.node, '26.3.0');
const version = workflowContract.version;
const parent = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(parent, 'b07-smoke-'));
const database = join(dir, 'maps.sqlite');
const log = `${database}.calls.jsonl`;
const token = randomBytes(32).toString('hex');
const other = randomBytes(32).toString('hex');
const verifier = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => verifier(`wayfinder-call-credential/1\0${verifier(value)}`);
let child;
let exit;
let diagnostics = '';
let toolCalls = 0;
let requestId = 0;
try {
  initializeSQLite(database);
  let port;
  do {
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
  } while ([18765, 18766].includes(port));
  const credentials = join(dir, 'credentials.json');
  writeFileSync(credentials, JSON.stringify({ credentials: [{ clientId: 'Codex:synthetic:high', tokenSha256: verifier(other) }] }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('../../dist/mcp-start.js', import.meta.url).pathname], { env: {
    PATH: process.env.PATH, WAYFINDER_DATABASE_PATH: database, WAYFINDER_PORT: String(port), WAYFINDER_TOKEN: token,
    WAYFINDER_ACTOR_ID: 'b07-smoke', WAYFINDER_CLIENT_ID: 'Codex:synthetic:high', WAYFINDER_CREDENTIALS_FILE: credentials,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', data => { diagnostics += data; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic service readiness timed out')), 20_000);
    let output = '';
    child.stdout.on('data', data => { output += data; if (output.includes('Wayfinder local MCP ready')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    void exit.then(() => { clearTimeout(timeout); reject(new Error('Synthetic service exited before readiness')); });
  });
  async function rpc(method, params, session, bearer = token) {
    const id = ++requestId;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: {
      Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const payload = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(message => message.id === id)
      : JSON.parse(text);
    return { id: String(id), session: response.headers.get('mcp-session-id'), payload };
  }
  const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } };
  const a = await rpc('initialize', init); const b = await rpc('initialize', init, undefined, other);
  assert.notEqual(a.session, b.session);
  const readRecords = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  async function call(tool, args, expected, session = a.session, bearer = token) {
    const response = await rpc('tools/call', { name: tool, arguments: args }, session, bearer); toolCalls++;
    const record = readRecords().at(-1);
    assert.equal(record.requestId, response.id); assert.equal(record.mcpSessionId, session);
    assert.equal(record.result, expected); assert.equal(record.credentialFingerprint, fingerprint(bearer));
    return response.payload.result;
  }
  const create = { version, mapId: 'B07.Smoke', title: 'PRIVATE SYNTHETIC TITLE', destination: 'PRIVATE SYNTHETIC DESTINATION' };
  await call('map_list', {}, 'read');
  await call('map_create', create, 'committed');
  await call('map_read', { mapId: create.mapId }, 'read', b.session, other);
  await call('map_create', { ...create, version: 'old' }, 'version-mismatch');
  await call('map_create', create, 'map-exists');
  await call('map_read', { mapId: '/private/synthetic/path' }, 'input-error');
  await call('map_apply', { version, mapId: create.mapId, expectedRevision: 2,
    commands: [{ kind: 'map.update', patch: { notes: 'PRIVATE SYNTHETIC NOTES' } }] }, 'conflict');
  const lock = new DatabaseSync(database);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const failed = await call('map_create', { ...create, mapId: 'B07.Busy' }, 'service-failure');
    assert.equal(failed.structuredContent.code, 'storage_busy');
  } finally { lock.exec('ROLLBACK'); lock.close(); }

  // A real filesystem failure must not turn a successful write into an error.
  renameSync(log, `${log}.saved`); mkdirSync(log);
  const survived = await rpc('tools/call', { name: 'map_create', arguments: { ...create, mapId: 'B07.Gap' } }, a.session); toolCalls++;
  assert.equal(survived.payload.result.structuredContent.kind, 'committed');
  rmSync(log, { recursive: true }); renameSync(`${log}.saved`, log);
  await call('map_read', { mapId: 'B07.Gap' }, 'read');
  assert.equal(readRecords().at(-1).missingObservations, 1);
  const gaps = readFileSync(`${database}.calls.gaps.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].missingObservations, 1);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const logged = readFileSync(log, 'utf8');
  for (const forbidden of [token, other, database, 'PRIVATE SYNTHETIC', '/private/synthetic/path']) {
    assert(!logged.includes(forbidden)); assert(!diagnostics.includes(forbidden));
  }
  child.kill('SIGTERM'); assert.deepEqual(await exit, { code: 0, signal: null });
  assert(diagnostics.includes('wayfinder-service-call-gap/1'));
  assert.equal(readRecords().at(-1).schema, 'wayfinder-service-call-summary/1');
  assert.equal(readRecords().at(-1).missingObservations, 1);
  assert.equal(readRecords().at(-1).observations, 12);
  console.log(JSON.stringify({ version, toolCalls, persistedToolCalls: readRecords().filter(r => r.method === 'tools/call').length,
    missingObservations: 1, distinctSessions: 2, privateMode: '0600', stopped: true, result: 'passed' }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exit; clearTimeout(timeout);
  }
  rmSync(dir, { recursive: true, force: true });
}
