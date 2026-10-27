import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeSQLite } from '../../dist/sqlite-storage.js';
import { startLocalMcpService } from '../../dist/mcp-service.js';
import { workflowContract } from '../../dist/mcp-tools.js';
import { createHttpTestClient } from './mcp-http-client.mjs';

// Explicit isolated private/local operator-path acceptance, never a canonical DB.
const root = process.env.WAYFINDER_SERVICE_TEST_ROOT;
if (!root) throw new Error('Private service acceptance root required');
const directory = realpathSync(mkdtempSync(join(root, 'wayfinder-service-acceptance-')));
const privateToken = randomBytes(32).toString('hex');
const children = [];
async function availablePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function command(path, port) {
  const child = fork(fileURLToPath(new URL('../../dist/mcp-start.js', import.meta.url)), [], { execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, WAYFINDER_DATABASE_PATH: path, WAYFINDER_PORT: String(port),
      WAYFINDER_TOKEN: privateToken, WAYFINDER_ACTOR_ID: 'operator', WAYFINDER_CLIENT_ID: 'operator-smoke', WAYFINDER_ALLOWED_ORIGINS: '[]' },
  });
  let logs = ''; let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const record = data => { logs += data; if (logs.includes('Wayfinder local MCP ready')) readyResolve(); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  children.push({ child, exit });
  return { child, ready, exit, logs: () => logs };
}
function safe(logs) {
  for (const secret of [privateToken, directory, 'private decision body', 'private evidence body']) assert.equal(logs.includes(secret), false);
}
try {
  const path = join(directory, 'private', 'maps.sqlite'); initializeSQLite(path);
  const port = await availablePort();
  // Production entry point: no temp/repository bypass, existing-format recognition.
  const config = { databasePath: path, port, token: privateToken, actorId: 'operator', clientId: 'operator-smoke' };
  const absent = join(directory, 'private', 'absent.sqlite');
  const empty = join(directory, 'private', 'empty.sqlite'); writeFileSync(empty, '', { mode: 0o600 });
  const wrong = join(directory, 'private', 'wrong.sqlite'); writeFileSync(wrong, 'not sqlite', { mode: 0o600 });
  const unsupported = join(directory, 'private', 'unsupported.sqlite'); initializeSQLite(unsupported);
  const alternate = new DatabaseSync(unsupported); alternate.exec('PRAGMA user_version=999'); alternate.close();
  for (const databasePath of [absent, empty, wrong, unsupported]) {
    await assert.rejects(startLocalMcpService({ ...config, databasePath }), error => error.code === 'storage_not_ready' && !error.message.includes(directory));
    const refused = command(databasePath, port); assert.deepEqual(await refused.exit, { code: 1, signal: null });
    assert.match(refused.logs(), /startup failed: storage_not_ready/); safe(refused.logs());
  }
  assert.equal(existsSync(absent), false);
  const host = command(path, port); await Promise.race([host.ready, host.exit.then(() => { throw new Error('Service exited before ready'); })]);
  assert.match(host.logs(), new RegExp(`ready version=${workflowContract.version.replaceAll('.', '\\.')}`)); safe(host.logs());
  const a = await createHttpTestClient(port, privateToken);
  assert.equal(a.negotiatedProtocol, '2025-11-25');
  assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['map_create', 'map_list', 'map_read', 'map_apply', 'map_wait']);
  await a.client.callTool({ name: 'map_create', arguments: { version: workflowContract.version, mapId: 'Acceptance.Operator', title: 'Isolated operator acceptance', destination: 'Manual service proof', notes: 'private decision body' } });
  await a.client.callTool({ name: 'map_apply', arguments: { version: workflowContract.version, mapId: 'Acceptance.Operator', expectedRevision: 1, commands: [
    { kind: 'ticket.create', ticket: { id: 'Retained', title: 'Retained', question: 'Continue?', type: 'task' } },
    { kind: 'claim.acquire', ticketId: 'Retained', claimantId: 'operator:continued' },
    { kind: 'content.add', section: 'fog', item: { id: 'Fog', text: 'private evidence body', references: [] } },
  ] } });
  const current = await a.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator' } });
  assert.equal(current.structuredContent.revision.revision, 2);
  const history = await a.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator', revision: 1 } });
  await a.client.close(); // Service must remain independently alive.
  const b = await createHttpTestClient(port, privateToken);
  assert.deepEqual(await b.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator' } }), current);
  const collision = command(path, port); assert.deepEqual(await collision.exit, { code: 1, signal: null });
  assert.match(collision.logs(), /startup failed: port_unavailable/); safe(collision.logs());
  await b.client.close(); host.child.kill('SIGTERM'); assert.deepEqual(await host.exit, { code: 0, signal: null });
  assert.match(host.logs(), /local MCP stopping/); assert.match(host.logs(), /local MCP stopped/); safe(host.logs());
  const restarted = command(path, port); await restarted.ready;
  const c = await createHttpTestClient(port, privateToken);
  assert.deepEqual(await c.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator' } }), current);
  assert.deepEqual(await c.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator', revision: 1 } }), history);
  assert.equal((await c.client.callTool({ name: 'map_read', arguments: { mapId: 'Acceptance.Operator', revision: 3 } })).structuredContent.code, 'revision_not_found');
  await c.client.close(); restarted.child.kill('SIGINT'); assert.deepEqual(await restarted.exit, { code: 0, signal: null }); safe(restarted.logs());
  console.log('Operator service command: private initialization/open, readiness refusals, fixed port, HTTP reconnect/Claims/history, SIGTERM/SIGINT and safe logs passed');
} finally {
  for (const { child, exit } of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  // Remove only this fresh named fixture; never remove configured root/user data.
  rmSync(directory, { recursive: true });
}
