// Actual Windows / SDK / Chromium acceptance against a fresh private instance.
// No real Map, credential, daily service, default browser profile or global config.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openSQLite } from '../../dist/sqlite-storage.js';
import { openWindowsDesk } from '../../dist/windows-browser.js';
import { createHttpTestClient } from './mcp-http-client.mjs';
const root = join(homedir(), '.wayfinder-windows-tests', randomUUID());
const env = { ...process.env, WAYFINDER_WINDOWS_HOME: root };
const entry = resolve('dist/windows-local.js');
const run = (...args) => execFileSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 60000 });
const mapId = 'Windows.Synthetic'; const claimantId = 'windows-sdk-session';
const dbPath = join(root, 'data/maps.sqlite'); const keyPath = join(root, 'answer-desk-key');
const evidence = resolve('.scratch/windows-evidence'); mkdirSync(evidence, { recursive: true });
let host, browser, connection; let allLogs = ''; let oldKey;
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
async function start() {
  host = spawn(process.execPath, [entry, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('service startup timeout')), 30000);
    const record = chunk => { allLogs += chunk; if (chunk.toString().includes('Windows ready')) { clearTimeout(timer); resolve(); } };
    host.stdout.on('data', record); host.stderr.on('data', record);
    host.once('exit', () => { clearTimeout(timer); reject(Error('service startup failed')); });
  });
}
async function stop() {
  const exiting = new Promise(r => host.once('exit', (code, signal) => r({ code, signal })));
  assert.match(run('stop'), /stopped/); assert.deepEqual(await exiting, { code: 0, signal: null }); host = undefined;
}
const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(expression, sessionId) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const result = await browser.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.result.value) return result.result.value;
    await pause(150);
  }
  const diagnostic = await browser.call('Runtime.evaluate', { expression: `JSON.stringify({ready:document.readyState,path:location.pathname,hidden:document.hidden,hasFragment:!!location.hash,questions:document.querySelectorAll('.desk-question').length,options:document.querySelectorAll('.desk-option').length,enabled:document.querySelectorAll('.desk-option:not(:disabled)').length})`, returnByValue: true }, sessionId);
  throw Error('browser expectation timed out: ' + diagnostic.result.value);
}
try {
  assert.match(run('init', String(port)), /initialized/); assert.match(run('client-config'), /generated/);
  const { token } = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  const clientConfig = JSON.parse(readFileSync(join(root, 'mcp-client.json'), 'utf8'));
  assert.equal(clientConfig.mcpServers.wayfinder.headers.Authorization, `Bearer ${token}`);
  await start(); assert.match(run('status'), /running/);
  connection = await createHttpTestClient(port, token);
  assert.equal(connection.negotiatedProtocol, '2025-11-25');
  assert.deepEqual((await connection.client.listTools()).tools.map(t => t.name), ['map_create', 'map_list', 'map_read', 'map_apply', 'map_wait']);
  const version = connection.initializeResult.serverInfo.version;
  assert(connection.initializeResult.instructions.includes(`version: ${version}`));
  assert.equal((await call('map_list', {})).kind, 'listed');
  const created = await call('map_create', { version, mapId, title: 'Windows 合成验收', destination: '验证持久地图与安全答题' });
  assert.equal(created.kind, 'committed');
  const applied = await call('map_apply', { version, mapId, expectedRevision: 1, commands: [
    { kind: 'ticket.create', ticket: { id: 'Choice', type: 'grilling', title: '合成选择', question: '使用哪种合成验证范围？' } },
    { kind: 'claim.acquire', ticketId: 'Choice', claimantId },
    { kind: 'deskQuestion.post', ticketId: 'Choice', claimantId, question: { questionId: 'Q.Choice',
      options: [{ label: '合成范围 A', description: '独立测试数据' }, { label: '合成范围 B', description: '另一独立测试数据' }],
      recommendedOption: 1, recommendedAnswer: '使用合成范围 A 完成测试。', whyKun: '仅用于验收的选择', triage: 'needsKun', triageReason: '合成测试', gatesResearch: false } },
  ] });
  assert.equal(applied.kind, 'committed'); assert.equal(applied.revision, 2);
  const conflict = await call('map_apply', { version, mapId, expectedRevision: 1, commands: [{ kind: 'map.update', patch: { notes: 'must not publish' } }] });
  assert.equal(conflict.kind, 'conflict'); assert.equal((await call('map_read', { mapId })).kind, 'found');
  // This explicit, scripted synthetic test is a fresh request after inspecting the conflict.
  const invalid = await call('map_apply', { version, mapId, expectedRevision: 2, commands: [
    { kind: 'map.update', patch: { notes: 'must roll back' } }, { kind: 'claim.acquire', ticketId: 'Absent', claimantId },
  ] });
  assert.equal(invalid.kind, 'rejected');
  const before = await call('map_read', { mapId }); assert.equal(before.revision.state.notes, '');
  oldKey = readFileSync(keyPath, 'utf8');
  const headless = process.env.WAYFINDER_WINDOWS_VISIBLE_BROWSER !== '1';
  browser = await openWindowsDesk({ port, mapId, keyPath, profile: join(root, 'browser'), headless });
  const browserVersion = (await browser.call('Browser.getVersion')).product;
  assert(browser.args.every(arg => !arg.includes(oldKey) && !arg.includes(token)));
  assert(!browser.args.some(arg => arg.includes('remote-debugging-port')));
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId: browser.targetId, flatten: true });
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false }, sessionId);
  await until("document.querySelector('.desk-question') && location.hash === '' && !!document.querySelector('.desk-option:not(:disabled)')", sessionId);
  assert.equal((await browser.call('Runtime.evaluate', { expression: 'localStorage.length + sessionStorage.length', returnByValue: true }, sessionId)).result.value, 0);
  const dom = await browser.call('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
  assert(!dom.result.value.includes(oldKey));
  await browser.call('Page.enable', {}, sessionId);
  const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(evidence, 'windows-desk.png'), Buffer.from(shot.data, 'base64'));
  // A browser-side click runs the real desk UI and same-origin write path.
  await browser.call('Runtime.evaluate', { expression: "document.querySelector('.desk-option').click()" }, sessionId);
  await until("document.querySelector('.desk-summary').textContent.includes('已答 1')", sessionId);
  const answered = await call('map_read', { mapId }); assert.equal(answered.revision.state.currentRevision, 2);
  assert.equal(answered.deskQuestions[0].currentAnswer.choice.option, 1);
  await connection.client.close(); connection = undefined; await stop();
  assert(!existsSync(keyPath));
  await start(); assert.notEqual(readFileSync(keyPath, 'utf8'), oldKey);
  const origin = `http://127.0.0.1:${port}`;
  const unauthorized = await fetch(`${origin}/api/desk`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Wayfinder-Key': oldKey }, body: JSON.stringify({ action: 'answer', mapId, submissions: [{ questionId: 'Q.Choice', questionVersion: 1, choice: { option: 2 } }] }) });
  assert.equal(unauthorized.status, 403);
  connection = await createHttpTestClient(port, token);
  const resumed = await call('map_read', { mapId }); assert.deepEqual(resumed.revision.state, answered.revision.state);
  assert.deepEqual(resumed.deskQuestions, answered.deskQuestions);
  const elapsed = Date.now();
  const delivered = await call('map_wait', { version, mapId, claimantId, maxWaitSeconds: 30 });
  assert.equal(delivered.outcome, 'delivered'); assert.equal(delivered.items[0].choice.option, 1);
  const receipt = delivered.items[0];
  const settled = await call('map_apply', { version, mapId, expectedRevision: 2, commands: [{ kind: 'ticket.settle', ticketId: 'Choice', claimantId, ticketType: 'grilling',
    deskAnswer: { answerId: receipt.answerId, questionVersion: receipt.questionVersion },
    settlement: { outcome: { kind: 'decision', statement: '使用合成范围 A', rationale: '由合成浏览器答复验证' }, evidence: [], references: [], provenance: { method: 'Windows synthetic acceptance', sources: [] }, extensions: {} } }] });
  assert.equal(settled.kind, 'committed'); assert.equal(settled.revision, 3);
  const historical = await call('map_read', { mapId, revision: 2 }); assert.equal(historical.kind, 'found');
  // A separate credentialed modern SDK client resumes the same durable Map.
  const modern = await createHttpTestClient(port, token, '2026-07-28');
  assert.equal(modern.negotiatedProtocol, '2026-07-28');
  assert.equal((await modern.client.callTool({ name: 'map_read', arguments: { mapId } })).structuredContent.kind, 'found'); await modern.client.close();
  const backupPath = join(root, 'backup/maps.sqlite'); assert.match(run('backup', backupPath), /completed/);
  const backup = openSQLite(backupPath); const saved = await backup.adapter.readCurrent(mapId);
  assert.equal(saved.kind, 'found'); assert.equal(saved.value.currentRevision, 3); assert.equal(saved.value.tickets[0].status, 'settled');
  assert.equal(backup.desk.read(mapId).answers[0].state, 'taken'); backup.close();
  await connection.client.close(); connection = undefined; await stop();
  const reopened = openSQLite(dbPath); assert.equal((await reopened.adapter.readRevision(mapId, 1)).kind, 'found'); reopened.close();
  const sql = new DatabaseSync(dbPath); const sqlite = sql.prepare('select sqlite_version() as v').get().v; sql.close();
  for (const sensitive of [token, oldKey, root, 'must roll back', '合成范围']) assert(!allLogs.includes(sensitive));
  const metadata = readFileSync(dbPath + '.calls.jsonl', 'utf8');
  for (const sensitive of [token, oldKey, root, 'must roll back', '合成范围']) assert(!metadata.includes(sensitive));
  assert(metadata.trim().split('\n').map(JSON.parse).every(record => record.missingObservations === 0));
  const result = { platform: process.platform, node: process.versions.node, sqlite, protocols: ['2025-11-25', '2026-07-28'],
    tools: 5, mapRevision: 3, persistentClaimAndAnswer: true, backup: true, browserPipe: true, browserVersion, headless, oldKeyRejected: true, logsRedacted: true, metadataPrivacy: true, waitMs: Date.now() - elapsed };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await connection?.client.close();
  if (host) { try { run('stop'); } catch { host.kill(); } }
  if (!root.startsWith(join(homedir(), '.wayfinder-windows-tests') + '\\')) throw Error('Unsafe cleanup');
  rmSync(root, { recursive: true, force: true });
}
