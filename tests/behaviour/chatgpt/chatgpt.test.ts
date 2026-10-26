// Merge-gate checks: fake cloudflared only, no model and no real tunnel.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { createHttpTestClient } from '../../helpers/mcp-http-client.mjs';
import { ChatGPTAttempt } from './attempt.ts';
import type { Capture } from './attempt.ts';
import type { Exchange } from './relay.ts';
import { checklist, initialFive, selectScenarios } from './plan.ts';
import { connectorsFrom, acquireTunnel, hasLocalConnector, readTunnelConfig } from './tunnel.ts';
import { clientVisibility, runBatch, runRoot } from './run.ts';
import { judgeAttempt } from '../verdict.ts';
import { asScenario, upgradeChecks } from '../upgrade-checks.ts';
import { observeIsolation, everydayListener, unchangedListener } from './isolation.ts';

mkdirSync(runRoot, { recursive: true, mode: 0o700 });
const fresh = () => mkdtempSync(join(runRoot, 'verify-chatgpt-'));
function fixture(root: string) {
  const tunnelId = randomUUID();
  const configPath = join(root, 'config.yml');
  // No credential file exists: only real cloudflared would need to open it.
  writeFileSync(configPath, `tunnel: ${tunnelId}\ncredentials-file: ${join(root, 'not-readable-credentials.json')}\n`);
  return { id: tunnelId, root, dir: root, configPath, fake: true, hostname: 'test.example.com' };
}
const attemptOptions = (root: string, id: string) => ({ dir: join(root, 'attempt'), batchId: 'verification', attemptId: id, scenario: selectScenarios([id])[0]!,
  surface: 'app', model: 'fake', commit: 'verification', version: JSON.parse(readFileSync('package.json', 'utf8')).version as string });
const wireOf = (a: ChatGPTAttempt): Exchange[] => JSON.parse(readFileSync(join(a.dir, 'raw/wire.json'), 'utf8'));
const listedSource = (a: ChatGPTAttempt) => `raw/wire.json#${wireOf(a).findLast(e => e.httpMethod === 'POST' && e.request.method === 'tools/list')!.id}`;

async function eventually(check: () => boolean, detail: () => string = () => 'condition not observed') {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(detail());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function cliFixture(fault?: 'throw' | 'reject' | 'exit', scenarios = 'F11') {
  const root = fresh(); const config = fixture(root);
  const batchId = `cli-fault-${randomUUID()}`;
  const batchDir = join(runRoot, batchId);
  const trigger = join(root, 'trigger'); const hook = join(root, 'fault.mjs');
  writeFileSync(hook, `import { existsSync } from 'node:fs';\nconst timer = setInterval(() => { if (!existsSync(${JSON.stringify(trigger)})) return; clearInterval(timer); ${fault === 'throw' ? "throw new Error('injected uncaught failure')" : fault === 'reject' ? "void Promise.reject(new Error('injected rejected failure'))" : 'process.exit(7)'}; }, 20); timer.unref();\n`);
  const child = spawn(process.execPath, [...(fault ? ['--import', hook] : []), 'tests/behaviour/chatgpt/run.ts', 'run', '--batch', batchId,
    '--scenarios', scenarios, '--ceiling', '1', '--approval', 'fake-only verification', '--hostname', 'test.example.com', '--fake-tunnel', '--config', config.configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (b: Buffer) => { output += b.toString(); }); child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
  const exited = once(child, 'exit');
  const waitFor = async (pattern: RegExp) => eventually(() => {
    if (pattern.test(output)) return true;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
    return false;
  }, () => output);
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    const run = join(root, 'fake-run.json');
    if (existsSync(run) && existsSync(join(root, 'fake-connector.json'))) {
      try { process.kill(JSON.parse(readFileSync(run, 'utf8')).pid, 'SIGTERM'); } catch { /* owned fake already exited */ }
      await eventually(() => !existsSync(join(root, 'fake-connector.json')));
    }
    rmSync(join(runRoot, `opencode-${config.id}.lock`), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true }); rmSync(batchDir, { recursive: true, force: true });
  };
  try { await waitFor(/Ready F11-1/); }
  catch (error) { await cleanup(); throw error; }
  return { root, config, batchDir, child, exited, trigger, cleanup, waitFor, output: () => output,
    port: JSON.parse(readFileSync(join(batchDir, 'F11-1/raw/isolation.json'), 'utf8')).relayPort as number };
}

test('checklist selects the initial five without injecting version or controller text into messages', () => {
  const scenarios = selectScenarios(initialFive);
  const text = checklist(scenarios, 'app', 1, 'fake');
  for (const s of scenarios) for (const t of s.turns) assert.ok(text.includes(t.say));
  assert.match(text, /daily ChatGPT routing is unavailable/);
  assert.match(text, /before.*proposal|actual proposal/);
  assert.throws(() => selectScenarios(['W5']), /unsupported|does not yet support/);
  assert.throws(() => selectScenarios(['S5', 'S5']), /distinct/);
}, 30_000);

test('tunnel refuses foreign connectors, unknown remote records and an existing lease; restores config on exit', async () => {
  const root = fresh(); const options = fixture(root); const tunnelId = options.id; const original = readFileSync(options.configPath, 'utf8');
  try {
    assert.equal(readTunnelConfig(options.configPath).id, tunnelId);
    assert.equal(hasLocalConnector('42 /opt/homebrew/bin/cloudflared tunnel --config config.yml run opencode'), true);
    assert.equal(hasLocalConnector('42 node scripts/local-chatgpt-test.mjs'), true);
    assert.equal(hasLocalConnector('42 /opt/homebrew/bin/cloudflared tunnel --config config.yml run opencode', 42), false);
    assert.throws(() => connectorsFrom('{}', tunnelId), /Cannot confirm/);
    assert.deepEqual(connectorsFrom(JSON.stringify({ id: tunnelId, name: 'opencode', conns: null }), tunnelId), []);
    assert.deepEqual(connectorsFrom(JSON.stringify({ id: tunnelId, name: 'opencode', conns: [{ id: tunnelId, conns: [] }] }), tunnelId), [tunnelId]);
    writeFileSync(join(root, 'fake-connector.json'), JSON.stringify([{ id: tunnelId, conns: [{ is_pending_reconnect: true }] }]));
    await assert.rejects(acquireTunnel(options), /already has a registered connector/);
    rmSync(join(root, 'fake-connector.json'));
    const lease = await acquireTunnel(options);
    try {
      await assert.rejects(acquireTunnel(options), /Tunnel lease exists/);
      await assert.rejects(lease.start(18766), /forbidden/);
      await lease.start(23456);
      const run = JSON.parse(readFileSync(join(root, 'fake-run.json'), 'utf8'));
      assert.equal(run.config.ingress[0].service, 'http://127.0.0.1:23456');
      assert.equal(run.config.ingress[1].service, 'http_status:404');
      assert.equal(run.config['credentials-file'], join(root, 'not-readable-credentials.json'));
      assert.equal(existsSync(run.config['credentials-file']), false);
      const own = JSON.parse(readFileSync(join(root, 'fake-connector.json'), 'utf8'));
      writeFileSync(join(root, 'fake-connector.json'), JSON.stringify([...own, { id: tunnelId, conns: [] }]));
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
}, 30_000);

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
    assert.equal((await fetch(`http://127.0.0.1:${a.relay.port}/mcp`, { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${a.relay.port}/mcp`, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${a.relay.port}/mcp`, { method: 'POST', body: 'x'.repeat(1_048_577) })).status, 413);
    await assert.rejects(client.callTool({ name: 'map_list', arguments: {} }));
    await a.begin();
    await assert.rejects(a.end({ messagesComplete: true, messages: [] }), /Capture needs/);
    await assert.rejects(a.end({ messagesComplete: false, messages: [], resources: 'undocumented' }), /no Resource support/);
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
    assert.equal(a.record.given[0]!.resources, 'unavailable');
    assert.ok(a.record.missing.includes('events.message'));
    assert.notEqual(judgeAttempt(options.scenario, a.record).outcome, 'pass');
    assert.equal(existsSync(join(a.dir, 'credentials.json')), false);
    const raw = readdirSync(join(a.dir, 'raw')).map(f => readFileSync(join(a.dir, 'raw', f), 'utf8')).join();
    for (const secret of Object.values(a.secrets)) assert.ok(!raw.includes(secret));
  } finally { await client?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('canary upgrade restarts only the owned database; old version refuses without a write', async () => {
  const root = fresh(); const options = attemptOptions(root, 'U-chatgpt-new-chat');
  const a = await ChatGPTAttempt.start(options);
  let client: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
  try {
    await a.begin();
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored-relay-token'));
    const initialTools = (await client.listTools()).tools;
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
    await a.end({ messagesComplete: true, messages: [{ text: 'Ticket created (test double).', afterCall: null }], versionSourceEvidence: 'arbitrary nonempty text is not a snapshot' });
    await client.close(); client = undefined; await a.stop();
    assert.equal(a.record.maps[0]!.history.length, 2);
    assert.deepEqual(a.record.given.map(g => g.phase), ['initial', 'after-restart', 'after-refresh']);
    assert.equal(a.record.maps[0]!.history[1]!.author.clientId, `${options.attemptId}.B`);
    const check = upgradeChecks.find(u => u.id === options.scenario.id)!;
    const reviews = ['fixture-A', 'fixture-B'].map(by => ({ itemId: 'mismatch-as-outage', status: 'holds' as const, reason: 'fixed evidence review', by, role: 'review' as const }));
    const judged = judgeAttempt(asScenario(check), a.record, { reviews });
    assert.equal(judged.outcome, 'insufficient-evidence');
    assert.equal(judged.mustNot.find(i => i.id === 'guessed-version')!.status, 'unknown');
    assert.equal(judged.expect.find(i => i.id === 'writes-new-version')!.status, 'unknown');
    assert.equal(judged.expect.find(i => i.id === 'follows-canary-rule')!.status, 'unknown');
    assert.equal(a.record.given.at(-1)!.rulesSource.kind, 'unknown');
    assert.ok(a.record.missing.includes('given.after-refresh.rulesSource'));
    const visible = structuredClone(a.record);
    for (const phase of visible.given) {
      const snapshot = phase.phase === 'initial' ? initialTools : tools;
      phase.rulesSource = { kind: 'tool-parameter', tool: 'map_apply', description: (snapshot.find(t => t.name === 'map_apply')!.inputSchema.properties!.version as { description: string }).description };
      phase.toolDescriptions = { known: true, value: Object.fromEntries(snapshot.map(t => [t.name, t.description ?? ''])) };
    }
    assert.equal(judgeAttempt(asScenario(check), visible, { reviews }).outcome, 'pass');
    visible.given.at(-1)!.toolDescriptions = { known: true, value: { map_apply: 'canary rule was not in the client snapshot' } };
    assert.equal(judgeAttempt(asScenario(check), visible, { reviews }).expect.find(i => i.id === 'follows-canary-rule')!.status, 'unknown');
  } finally { await client?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('manual command uses fake cloudflared and owned listeners only, ignores daily environment, cleans up on SIGTERM', async () => {
  const root = fresh(); const fixtureOptions = fixture(root); const tunnelId = fixtureOptions.id;
  const sentinel = join(root, 'everyday-sentinel.sqlite'); writeFileSync(sentinel, 'not a database; never open');
  const batchId = `verify-cli-${randomUUID()}`; const batchDir = join(runRoot, batchId);
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
    assert.deepEqual(batch.isolation.everydayUnchanged, { known: true, value: true });
    assert.deepEqual(isolation.servedOnlyOwnDatabase, { known: true, value: true });
    assert.deepEqual(isolation.listeningOnlyOnOwnPorts, { known: true, value: true });
    assert.deepEqual(isolation.avoidedEverydayPorts, { known: true, value: true });
    assert.equal(existsSync(join(batchDir, 'tunnel.yml')), false);
    assert.equal(existsSync(join(runRoot, `opencode-${tunnelId}.lock`)), false);
    assert.equal(existsSync(join(root, 'fake-connector.json')), false);
    assert.match(readFileSync(join(batchDir, 'report.md'), 'utf8'), /incomplete/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'not a database; never open');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    rmSync(root, { recursive: true, force: true }); rmSync(batchDir, { recursive: true, force: true });
  }
}, 30_000);

test('missing inventories and missing Attempt metadata remain unknown', () => {
  const unavailable = () => ({ known: false as const, reason: 'test inventory unavailable' });
  const observed = observeIsolation('/owned/maps.sqlite', 22001, 22002, unavailable);
  assert.equal(observed.servedOnlyOwnDatabase.known, false);
  assert.equal(observed.listeningOnlyOnOwnPorts.known, false);
  assert.equal(observed.avoidedEverydayPorts.known, false);
  assert.equal(everydayListener(unavailable).known, false);
  assert.equal(unchangedListener(unavailable(), { known: true, value: [] }).known, false);
  assert.deepEqual(unchangedListener({ known: true, value: ['1'] }, { known: true, value: ['2'] }), { known: true, value: false });
  assert.deepEqual(clientVisibility(null), { known: false, reason: 'Attempt not recorded' });
});

test('invalid approval, Batch ID and counts fail before any tunnel or service starts', async () => {
  const options = { batch: 'never-created', scenarios: ['F11'], count: 1, ceiling: 1, surface: 'app' as const, model: 'fake',
    approval: 'fake-only', hostname: 'test.example.com', configPath: '/not-read', fake: true };
  const input = async function* () {};
  for (const [patch, message] of [[{ approval: '' }, /approval/], [{ batch: 'a'.repeat(65) }, /Batch ID/],
    [{ count: 0 }, /positive integers/], [{ ceiling: 0 }, /positive integers/]] as const)
    await assert.rejects(runBatch({ ...options, ...patch }, input(), () => {}), message);
});

test('the ceiling stops at its limit and preserves the remaining plan as not-run', async () => {
  const f = await cliFixture(undefined, 'F11,S1');
  try {
    f.child.stdin.write('next\n'); await f.exited;
    assert.equal(f.child.exitCode, 0, f.output());
    const batch = JSON.parse(readFileSync(join(f.batchDir, 'batch.json'), 'utf8'));
    assert.deepEqual(batch.outcomes.map((o: { completeness: string }) => o.completeness), ['cancelled', 'not-run']);
    const report = JSON.parse(readFileSync(join(f.batchDir, 'report.json'), 'utf8'));
    assert.equal(report.chatgptAcceptance.visibility[0].phases[0].compatibilityMode, 'toolsOnly');
    assert.equal(report.chatgptAcceptance.visibility[0].phases[0].instructions.known, false);
    assert.equal(report.chatgptAcceptance.visibility[1].phases.known, false);
    assert.match(readFileSync(join(f.batchDir, 'report.md'), 'utf8'), /S1-1: mode unknown/);
  } finally { await f.cleanup(); }
}, 30_000);

test('an old chat is refused after upgrade and cannot take a Resource recovery path', async () => {
  const root = fresh(); const options = attemptOptions(root, 'U-chatgpt-old-chat');
  const a = await ChatGPTAttempt.start(options);
  let client: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
  try {
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored'));
    const oldTools = (await client.listTools()).tools;
    const oldSource = listedSource(a);
    await a.begin();
    await client.callTool({ name: 'map_create', arguments: { version: options.version, mapId: 'ChatGPTUpgrade', title: 'Upgrade', destination: 'Test upgrade', notes: '' } });
    await a.end({ messagesComplete: true, messages: [{ text: 'Created.', afterCall: null }], toolsShown: oldTools, toolsShownSource: oldSource });
    await client.close(); client = undefined;
    await a.upgrade(); a.operator('refresh-tools');
    await a.begin();
    ({ client } = await createHttpTestClient(a.relay.port, 'ignored'));
    const refusal = await client.callTool({ name: 'map_apply', arguments: { version: options.version, mapId: 'ChatGPTUpgrade', expectedRevision: 1, commands: [] } });
    assert.equal((refusal.structuredContent as { code: string }).code, 'version_mismatch');
    await a.end({ messagesComplete: true, messages: [{ text: 'Refresh tools and open a new chat.', afterCall: null }], toolsShown: oldTools, toolsShownSource: oldSource });
    await client.close(); client = undefined; await a.stop();
    assert.equal(a.record.maps[0]!.history.length, 1);
    assert.equal(a.record.given[0]!.rulesSource.kind, 'tool-parameter');
    assert.equal(a.record.given[0]!.toolDescriptions.known, true);
    assert.equal(a.record.given.at(-1)!.rulesSource.kind, 'unknown'); // A prior service/session's artifact cannot fill this phase.
    const scenario = asScenario(upgradeChecks.find(u => u.id === options.scenario.id)!);
    const judged = judgeAttempt(scenario, a.record);
    assert.equal(judged.expect.find(g => g.id === 'refused-unwritten')!.status, 'holds');
    assert.equal(judged.expect.find(g => g.id === 'asks-refresh')!.status, 'pending-review');
    const altered = structuredClone(a.record);
    const refusalEvent = altered.events.find(e => e.kind === 'tool-call' && e.tool === 'map_apply')!;
    assert.equal(refusalEvent.kind, 'tool-call');
    const seq = altered.events.length;
    altered.events.push({ seq, at: '', actor: 'agent', session: 'A', turn: 1, kind: 'resource-read', uri: 'wayfinder://workflow/exploration', ok: true },
      { ...refusalEvent, seq: seq + 1, kind: 'tool-call', tool: 'map_read' } as typeof refusalEvent,
      { ...refusalEvent, seq: seq + 2 } as typeof refusalEvent);
    assert.equal(judgeAttempt(scenario, altered).expect.find(g => g.id === 'asks-refresh')!.status, 'violated');
  } finally { await client?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

for (const variant of ['matched', 'no-list', 'no-reference', 'different-version', 'different-rule', 'other-session', 'stale-reference', 'late-list'] as const)
  test(`canary snapshot import ${variant} is checked against its own pre-turn wire evidence`, async () => {
    const root = fresh(); const options = attemptOptions(root, 'U-chatgpt-new-chat');
    const a = await ChatGPTAttempt.start(options);
    let client: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
    let other: Awaited<ReturnType<typeof createHttpTestClient>>['client'] | undefined;
    try {
      ({ client } = await createHttpTestClient(a.relay.port, 'ignored'));
      const initialTools = (await client.listTools()).tools;
      const initialSource = listedSource(a);
      await a.begin();
      await client.callTool({ name: 'map_create', arguments: { version: options.version, mapId: 'ChatGPTUpgrade', title: 'Upgrade', destination: 'Test upgrade', notes: '' } });
      await a.end({ messagesComplete: true, otherToolsComplete: true, messages: [{ text: 'Created (fixed test evidence).', afterCall: null }],
        toolsShown: initialTools, toolsShownSource: initialSource });
      assert.equal(a.record.given[0]!.rulesSource.kind, 'tool-parameter');
      await client.close(); client = undefined;
      await a.upgrade(); a.operator('refresh-tools'); a.operator('new-chat');
      ({ client } = await createHttpTestClient(a.relay.port, 'ignored'));
      // Controller data is deliberately supplied in the no-list negative case: shape alone proves nothing.
      let tools: NonNullable<Capture['toolsShown']> = JSON.parse(readFileSync(join(a.dir, 'raw/controller-tools-after-restart.json'), 'utf8'));
      let source: string | undefined;
      if (!['no-list', 'late-list'].includes(variant)) {
        tools = (await client.listTools()).tools;
        source = listedSource(a);
      }
      if (variant === 'other-session') {
        ({ client: other } = await createHttpTestClient(a.relay.port, 'ignored'));
        await other.listTools(); source = listedSource(a);
      }
      if (variant === 'stale-reference') await client.listTools(); // Same content, superseded wire reference.
      if (variant === 'no-reference') source = undefined;
      if (variant === 'different-version') tools.find(t => t.name === 'map_apply')!.inputSchema.properties!.version!.description = 'Use version 8.8.8';
      if (variant === 'different-rule') tools.find(t => t.name === 'map_apply')!.description += ' Extra operator-invented rule.';
      await a.begin();
      if (variant === 'late-list') { tools = (await client.listTools()).tools; source = listedSource(a); }
      await client.callTool({ name: 'map_apply', arguments: { version: '9.9.9', mapId: 'ChatGPTUpgrade', expectedRevision: 1,
        commands: [{ kind: 'ticket.create', ticket: { id: 'TimeZones', title: 'v2: Time zones', question: 'Which zones?', type: 'research' } }] } });
      await a.end({ messagesComplete: true, otherToolsComplete: true, messages: [{ text: 'Ticket created (fixed test evidence).', afterCall: null }],
        toolsShown: tools, ...(source ? { toolsShownSource: source } : {}), versionSourceEvidence: 'Operator assertion alone is not proof.' });
      await client.close(); client = undefined; await other?.close(); other = undefined; await a.stop();
      const verdict = judgeAttempt(options.scenario, a.record, { reviews: ['A', 'B'].map(by => ({ itemId: 'mismatch-as-outage', status: 'holds',
        reason: 'fixed test review', by, role: 'review' })) });
      const verified = variant === 'matched';
      assert.equal(a.record.given.at(-1)!.toolDescriptions.known, verified);
      assert.equal(a.record.given.at(-1)!.rulesSource.kind, verified ? 'tool-parameter' : 'unknown');
      assert.equal(a.record.missing.includes('given.after-refresh.rulesSource'), !verified);
      assert.equal(JSON.parse(readFileSync(join(a.dir, 'raw/tool-snapshot-1.json'), 'utf8')).verified, verified);
      assert.equal(verdict.outcome, verified ? 'pass' : 'insufficient-evidence');
      for (const id of ['writes-new-version', 'follows-canary-rule']) assert.equal(verdict.expect.find(i => i.id === id)!.status, verified ? 'holds' : 'unknown');
      assert.equal(verdict.mustNot.find(i => i.id === 'guessed-version')!.status, verified ? 'holds' : 'unknown');
    } finally { await client?.close(); await other?.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

test('a session DELETE cannot fabricate a JSON-RPC tool call', async () => {
  const root = fresh(); const a = await ChatGPTAttempt.start(attemptOptions(root, 'F11'));
  const { client, transport } = await createHttpTestClient(a.relay.port, 'ignored');
  try {
    await a.begin();
    const response = await fetch(`http://127.0.0.1:${a.relay.port}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': transport.sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'map_apply', arguments: { version: '9.9.9' } } }) });
    assert.equal(response.status, 400);
    const deleted = await fetch(`http://127.0.0.1:${a.relay.port}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': transport.sessionId! } });
    assert.equal(deleted.status, 200);
    assert.equal(a.record.events.some(e => e.kind === 'tool-call'), false);
    const exchange = wireOf(a).at(-1)!;
    assert.equal(exchange.httpMethod, 'DELETE'); assert.deepEqual(exchange.request, {});
  } finally { await client.close(); await a.stop('cancelled'); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('aborted POST and tools/call without params do not crash the full fake-tunnel CLI', async () => {
  const f = await cliFixture();
  try {
    const socket = connect(f.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{');
    socket.destroy();
    f.child.stdin.write('begin\n'); await f.waitFor(/Send this Scenario message/);
    for (const params of [undefined, null, [], { name: null }]) {
      const response = await fetch(`http://127.0.0.1:${f.port}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
      assert.equal(response.status, 400);
    }
    assert.equal(f.child.exitCode, null);
    f.child.stdin.end(); await f.exited;
    assert.equal(f.child.exitCode, 0, f.output());
    assert.equal(existsSync(join(f.batchDir, 'tunnel.yml')), false);
    assert.equal(existsSync(join(runRoot, `opencode-${f.config.id}.lock`)), false);
    assert.equal(existsSync(join(f.root, 'fake-connector.json')), false);
  } finally { await f.cleanup(); }
}, 30_000);

for (const fault of ['throw', 'reject', 'exit'] as const) test(`${fault} path stops the owned connector and removes the lease/config`, async () => {
  const f = await cliFixture(fault);
  try {
    writeFileSync(f.trigger, 'go'); await f.exited;
    assert.equal(f.child.exitCode, fault === 'exit' ? 7 : 1, f.output());
    await eventually(() => !existsSync(join(f.root, 'fake-connector.json')));
    assert.equal(existsSync(join(runRoot, `opencode-${f.config.id}.lock`)), false);
    assert.equal(existsSync(join(f.batchDir, 'tunnel.yml')), false);
    if (fault !== 'exit') {
      const record = JSON.parse(readFileSync(join(f.batchDir, 'F11-1/attempt.json'), 'utf8'));
      assert.equal(record.run.completeness, 'driver-failed');
      assert.ok(record.events.some((e: { action?: string }) => e.action === (fault === 'throw' ? 'uncaught-exception' : 'unhandled-rejection')));
    }
  } finally { await f.cleanup(); }
}, 30_000);

test('new competing connector is rejected before forwarding, recorded, and aborts the Batch', async () => {
  const f = await cliFixture();
  try {
    f.child.stdin.write('begin\n'); await f.waitFor(/Send this Scenario message/);
    const statePath = join(f.root, 'fake-connector.json');
    const own = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify([...own, { id: randomUUID(), conns: [] }]));
    const response = await fetch(`http://127.0.0.1:${f.port}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(response.status, 503);
    await f.exited;
    assert.equal(f.child.exitCode, 1, f.output());
    const record = JSON.parse(readFileSync(join(f.batchDir, 'F11-1/attempt.json'), 'utf8'));
    assert.equal(record.run.completeness, 'driver-failed');
    assert.match(record.run.detail, /ownership lost/);
    assert.equal(existsSync(join(f.batchDir, 'tunnel.yml')), false);
  } finally { await f.cleanup(); }
}, 30_000);

for (const action of ['begin', 'monitor'] as const) test(`ownership loss at ${action} is fatal even without an HTTP call`, async () => {
  const f = await cliFixture();
  try {
    const path = join(f.root, 'fake-connector.json');
    const own = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify([...own, { id: randomUUID(), conns: [] }]));
    if (action === 'begin') f.child.stdin.write('begin\n');
    await f.exited;
    assert.equal(f.child.exitCode, 1, f.output());
    const record = JSON.parse(readFileSync(join(f.batchDir, 'F11-1/attempt.json'), 'utf8'));
    assert.equal(record.run.completeness, 'driver-failed');
    assert.ok(record.events.some((e: { action?: string }) => e.action === 'tunnel-ownership-lost'));
    assert.equal(existsSync(join(f.batchDir, 'tunnel.yml')), false);
  } finally { await f.cleanup(); }
}, 30_000);

test('SIGINT cleans up; SIGKILL leftovers are refused with owner inspection instructions', async () => {
  const graceful = await cliFixture();
  try {
    graceful.child.kill('SIGINT'); await graceful.exited;
    assert.equal(existsSync(join(graceful.root, 'fake-connector.json')), false);
    assert.equal(existsSync(join(runRoot, `opencode-${graceful.config.id}.lock`)), false);
  } finally { await graceful.cleanup(); }
  const killed = await cliFixture();
  try {
    killed.child.kill('SIGKILL'); await killed.exited;
    assert.equal(existsSync(join(killed.root, 'fake-connector.json')), true);
    await assert.rejects(acquireTunnel({ ...killed.config, root: runRoot, dir: killed.batchDir }), /inspect .*owner.json.*confirmed orphan/);
    const owner = JSON.parse(readFileSync(join(runRoot, `opencode-${killed.config.id}.lock/owner.json`), 'utf8'));
    assert.equal(owner.pid, killed.child.pid);
    assert.equal(typeof owner.connectorPid, 'number');
  } finally { await killed.cleanup(); }
}, 30_000);
