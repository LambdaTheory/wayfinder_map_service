// Manual, no model and no real tunnel: node --test tests/behaviour/chatgpt/verify.ts
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHttpTestClient } from '../../helpers/mcp-http-client.mjs';
import { ChatGPTAttempt } from './attempt.ts';
import { checklist, initialFive, selectScenarios } from './plan.ts';
import { connectorsFrom, acquireTunnel, hasLocalConnector, readTunnelConfig } from './tunnel.ts';
import { runRoot } from './run.ts';
import { judgeAttempt } from '../verdict.ts';

const tunnelId = '11111111-1111-4111-8111-111111111111';
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
const fresh = () => mkdtempSync(join(runRoot, 'verify-chatgpt-'));
function fixture(root: string) {
  const configPath = join(root, 'config.yml');
  // No credential file exists: only real cloudflared would need to open it.
  writeFileSync(configPath, `tunnel: ${tunnelId}\ncredentials-file: ${join(root, 'not-readable-credentials.json')}\n`);
  return { root, dir: root, configPath, fake: true, hostname: 'test.example.com' };
}
const attemptOptions = (root: string, id: string) => ({ dir: join(root, 'attempt'), batchId: 'verification', attemptId: id, scenario: selectScenarios([id])[0]!,
  surface: 'app', model: 'fake', commit: 'verification', version: JSON.parse(readFileSync('package.json', 'utf8')).version as string });

test('checklist selects the initial five without injecting version or controller text into messages', () => {
  const scenarios = selectScenarios(initialFive);
  const text = checklist(scenarios, 'app', 1, 'fake');
  for (const s of scenarios) for (const t of s.turns) assert.ok(text.includes(t.say));
  assert.match(text, /daily ChatGPT routing is unavailable/);
  assert.match(text, /before.*proposal|actual proposal/);
  assert.throws(() => selectScenarios(['W5']), /unsupported|does not yet support/);
  assert.throws(() => selectScenarios(['S5', 'S5']), /distinct/);
});

test('tunnel refuses foreign connectors, unknown remote records and an existing lease; restores config on exit', async () => {
  const root = fresh(); const options = fixture(root); const original = readFileSync(options.configPath, 'utf8');
  try {
    assert.equal(readTunnelConfig(options.configPath).id, tunnelId);
    assert.equal(hasLocalConnector('42 /opt/homebrew/bin/cloudflared tunnel --config config.yml run opencode'), true);
    assert.equal(hasLocalConnector('42 node scripts/local-chatgpt-test.mjs'), true);
    assert.equal(hasLocalConnector('42 /opt/homebrew/bin/cloudflared tunnel --config config.yml run opencode', 42), false);
    assert.throws(() => connectorsFrom('{}', tunnelId), /Cannot confirm/);
    assert.deepEqual(connectorsFrom(JSON.stringify({ id: tunnelId, name: 'opencode', conns: null }), tunnelId), []);
    writeFileSync(join(root, 'fake-connector.json'), JSON.stringify([{ id: tunnelId, conns: [{ is_pending_reconnect: true }] }]));
    await assert.rejects(acquireTunnel(options), /already has a connector/);
    rmSync(join(root, 'fake-connector.json'));
    const lease = await acquireTunnel(options);
    try {
      await assert.rejects(acquireTunnel(options), /EEXIST/);
      await assert.rejects(lease.start(18766), /forbidden/);
      await lease.start(23456);
      const run = JSON.parse(readFileSync(join(root, 'fake-run.json'), 'utf8'));
      assert.equal(run.config.ingress[0].service, 'http://127.0.0.1:23456');
      assert.equal(run.config['credentials-file'], join(root, 'not-readable-credentials.json'));
      assert.equal(existsSync(run.config['credentials-file']), false);
      writeFileSync(join(root, 'fake-connector.json'), JSON.stringify([{ id: tunnelId, conns: [{}] }]));
      await assert.rejects(lease.check(), /ownership lost/);
    } finally { await lease.stop(); }
    assert.equal(readFileSync(options.configPath, 'utf8'), original);
    assert.equal(existsSync(join(root, 'tunnel.yml')), false);
    assert.equal(existsSync(join(root, `opencode-${tunnelId}.lock`)), false);
    writeFileSync(join(root, 'fail-start'), 'test injected startup failure');
    const failedLease = await acquireTunnel(options);
    try { await assert.rejects(failedLease.start(23456), /Tunnel exited/); }
    finally { await failedLease.stop(); }
    assert.equal(existsSync(join(root, 'tunnel.yml')), false);
    assert.equal(existsSync(join(root, `opencode-${tunnelId}.lock`)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('isolated Attempt preserves Claim seeds, refuses unlabelled calls and records actual toolsOnly writes', async () => {
  const root = fresh(); const options = attemptOptions(root, 'S5');
  const a = await ChatGPTAttempt.start(options);
  let client: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
  try {
    const seed = JSON.parse(readFileSync(join(a.dir, 'raw/seed.json'), 'utf8'));
    assert.equal(seed.maps[0].history.at(-1).state.tickets.find((t: { id: string }) => t.id === 'task-carrier').claim, 'codex-session-20261022-01');
    assert.ok(![18765, 18766].includes(a.servicePort)); assert.ok(![18765, 18766].includes(a.relay.port));
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored-relay-token'));
    const tools = (await client.listTools()).tools;
    const versionDescription = tools.find((t: { name: string }) => t.name === 'map_apply')!.inputSchema.properties!.version as { description: string };
    assert.ok(versionDescription.description.includes(options.version));
    const before = await fetch(`http://127.0.0.1:${a.relay.port}/maps/anything`); assert.equal(before.status, 404);
    await assert.rejects(client.callTool({ name: 'map_list', arguments: {} }));
    await a.begin();
    const listed = await client.callTool({ name: 'map_list', arguments: {} });
    assert.equal((listed.structuredContent as { kind: string }).kind, 'listed');
    const call = a.record.events.find(e => e.kind === 'tool-call');
    assert.ok(call && call.kind === 'tool-call');
    await a.end({ messagesComplete: true, otherToolsComplete: true,
      otherToolCalls: [{ callId: 'search-1', server: 'web', tool: 'search', arguments: { query: 'fixture' }, result: { known: true, value: 'fixture result' }, failed: false, afterCall: call.callId, order: 0 }],
      messages: [{ text: 'The Ticket has a foreign claim; may I take it over?', afterCall: call.callId, order: 1 }] });
    assert.ok(a.record.events.some(e => e.kind === 'tool-call' && e.server === 'web'));
    await assert.rejects(a.begin(), /Precondition unmet/);
    await a.begin(true);
    const wrong = await client.callTool({ name: 'map_apply', arguments: { version: '0.0.0', mapId: 'feishu-access-20261022', expectedRevision: 1, commands: [] } });
    assert.equal((wrong.structuredContent as { code: string }).code, 'version_mismatch');
    await a.end({ messagesComplete: false, messages: [] });
    await client.close(); client = undefined;
    await a.stop();
    assert.equal(a.record.receipts.length, 1);
    assert.equal(a.record.receipts[0]!.outcome.kind, 'not-written');
    assert.equal(a.record.given[0]!.compatibilityMode, 'toolsOnly');
    assert.equal(a.record.given[0]!.instructions.known, false);
    assert.equal(a.record.given[0]!.toolDescriptions.known, false);
    assert.ok(a.record.missing.includes('events.message'));
    assert.notEqual(judgeAttempt(options.scenario, a.record).outcome, 'pass');
    assert.equal(existsSync(join(a.dir, 'credentials.json')), false);
    const raw = readdirSync(join(a.dir, 'raw')).map(f => readFileSync(join(a.dir, 'raw', f), 'utf8')).join();
    for (const secret of Object.values(a.secrets)) assert.ok(!raw.includes(secret));
  } finally { await client?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
});

test('canary upgrade restarts only the owned database; old version refuses without a write', async () => {
  const root = fresh(); const options = attemptOptions(root, 'U-chatgpt-new-chat');
  const a = await ChatGPTAttempt.start(options);
  let client: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
  try {
    await a.begin();
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored-relay-token'));
    await client.callTool({ name: 'map_create', arguments: { version: options.version, mapId: 'ChatGPTUpgrade', title: 'Upgrade', destination: 'Test upgrade', notes: '' } });
    await a.end({ messagesComplete: true, messages: [{ text: 'Map created (test double).', afterCall: null }] });
    await client.close(); client = undefined;
    await a.upgrade();
    a.operator('refresh-tools'); a.operator('new-chat');
    await a.begin();
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored-relay-token'));
    const tools = (await client.listTools()).tools;
    assert.match(tools.find((t: { name: string }) => t.name === 'map_apply')!.description ?? '', /v2: /);
    const refused = await client.callTool({ name: 'map_apply', arguments: { version: options.version, mapId: 'ChatGPTUpgrade', expectedRevision: 1, commands: [] } });
    assert.equal((refused.structuredContent as { code: string }).code, 'version_mismatch');
    const result = await client.callTool({ name: 'map_apply', arguments: { version: '9.9.9', mapId: 'ChatGPTUpgrade', expectedRevision: 1,
      commands: [{ kind: 'ticket.create', ticket: { id: 'TimeZones', title: 'v2: Time zones', question: 'Which zones?', type: 'research' } }] } });
    assert.equal((result.structuredContent as { kind: string }).kind, 'committed');
    await a.end({ messagesComplete: true, messages: [{ text: 'Ticket created (test double).', afterCall: null }] });
    await client.close(); client = undefined; await a.stop();
    assert.equal(a.record.maps[0]!.history.length, 2);
    assert.deepEqual(a.record.given.map(g => g.phase), ['initial', 'after-restart', 'after-refresh']);
    assert.equal(a.record.maps[0]!.history[1]!.author.clientId, `${options.attemptId}.B`);
  } finally { await client?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
});

test('manual command uses fake cloudflared and owned listeners only, ignores daily environment, cleans up on SIGTERM', async () => {
  const root = fresh(); const fixtureOptions = fixture(root);
  const sentinel = join(root, 'everyday-sentinel.sqlite'); writeFileSync(sentinel, 'not a database; never open');
  const batchId = `verify-cli-${Date.now()}`; const batchDir = join(runRoot, batchId);
  const child = spawn(process.execPath, ['tests/behaviour/chatgpt/run.ts', 'run', '--batch', batchId, '--scenarios', 'F11,S1,S5', '--ceiling', '3',
    '--approval', 'fake-only verification', '--hostname', 'test.example.com', '--fake-tunnel', '--config', fixtureOptions.configPath], {
    env: { ...process.env, WAYFINDER_DATABASE_PATH: sentinel, WAYFINDER_PORT: '18766', WAYFINDER_ATTACH_TOKEN: 'never-use-daily-token' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', (b: Buffer) => { output += b.toString(); }); child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
  const exited = once(child, 'exit');
  const waitFor = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(check); reject(new Error(`Timed out: ${output.slice(-2000)}`)); }, 15_000);
    const check = setInterval(() => {
      if (pattern.test(output)) { clearTimeout(timer); clearInterval(check); resolve(); }
      else if (child.exitCode !== null) { clearTimeout(timer); clearInterval(check); reject(new Error(output)); }
    }, 20);
  });
  try {
    await waitFor(/Ready F11-1/);
    const isolation = JSON.parse(readFileSync(join(batchDir, 'F11-1/raw/isolation.json'), 'utf8'));
    const handles = execFileSync('lsof', ['-nP', '-p', String(child.pid), '-Fn'], { encoding: 'utf8' });
    assert.ok(handles.includes(isolation.databasePath)); assert.ok(!handles.includes(sentinel));
    const sockets = execFileSync('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    assert.ok(!/:18765\b|:18766\b/.test(sockets));
    assert.ok(sockets.includes(`:${isolation.servicePort}`)); assert.ok(sockets.includes(`:${isolation.relayPort}`));
    assert.equal(readFileSync(sentinel, 'utf8'), 'not a database; never open');
    child.stdin.write('begin\n');
    await waitFor(/Send this Scenario message with the plugin mention:/);
    const { client } = await createHttpTestClient(isolation.relayPort, 'ignored-relay-token');
    await client.callTool({ name: 'map_read', arguments: { mapId: 'DistributedAgents.Feishu.20261023' } });
    await client.close();
    const wire = JSON.parse(readFileSync(join(batchDir, 'F11-1/raw/wire.json'), 'utf8')) as { id: string; request: { method: string } }[];
    const capturePath = join(batchDir, 'F11-1/raw/manual-capture.json');
    writeFileSync(capturePath, JSON.stringify({ messagesComplete: true, messages: [{ text: 'Test-double reply for capture verification.', afterCall: wire.find(e => e.request.method === 'tools/call')!.id }] }));
    child.stdin.write(`end ${capturePath}\n`);
    await waitFor(/Turn captured/);
    child.stdin.write('next\n');
    await waitFor(/Ready S1-1/);
    const nextIsolation = JSON.parse(readFileSync(join(batchDir, 'S1-1/raw/isolation.json'), 'utf8'));
    assert.notEqual(nextIsolation.databasePath, isolation.databasePath);
    child.kill('SIGTERM'); await exited;
    assert.equal(child.exitCode, 0, output);
    const batch = JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8'));
    assert.deepEqual(batch.outcomes.map((o: { completeness: string }) => o.completeness), ['complete', 'cancelled', 'not-run']);
    assert.equal(batch.surfaces.web, 'untested'); assert.equal(batch.surfaces.mobile, 'untested');
    assert.equal(existsSync(join(batchDir, 'tunnel.yml')), false);
    assert.equal(existsSync(join(runRoot, `opencode-${tunnelId}.lock`)), false);
    assert.equal(existsSync(join(root, 'fake-connector.json')), false);
    assert.match(readFileSync(join(batchDir, 'report.md'), 'utf8'), /incomplete/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'not a database; never open');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    rmSync(root, { recursive: true, force: true }); rmSync(batchDir, { recursive: true, force: true });
  }
});
