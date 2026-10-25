import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { openSQLite } from '../../dist/sqlite-storage.js';
import { mapTools, workflowContract } from '../../dist/mcp-tools.js';

export function createCodexMcpHarness(options) {
  const { root, directoryPrefix, port, serverName, actorId, clientId, workingDirectory, startupTimeoutSeconds = 30 } = options;
  assert(root && port, 'Explicit private root and fixed port required');
  assert(/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535, 'Invalid fixed port');
  const directory = realpathSync(mkdtempSync(join(root, directoryPrefix)));
  const control = realpathSync(mkdtempSync(join(tmpdir(), `${directoryPrefix}control-`)));
  const cwd = workingDirectory ?? control;
  const databasePath = join(directory, 'private', 'maps.sqlite');
  const protocolPath = join(control, 'protocol.jsonl');
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env, WAYFINDER_DATABASE_PATH: databasePath, WAYFINDER_PORT: port,
    WAYFINDER_TOKEN: token, WAYFINDER_ACTOR_ID: actorId, WAYFINDER_CLIENT_ID: clientId,
    WAYFINDER_ALLOWED_ORIGINS: '[]', WAYFINDER_PROTOCOL_REPORT: protocolPath };
  const schemas = new Map(mapTools.map(tool => [tool.name, new Ajv({ strict: false }).compile(tool.outputSchema)]));
  const configuration = ['--ignore-user-config', '--json', '--skip-git-repo-check',
    '-c', `mcp_servers.${serverName}.url="http://127.0.0.1:${port}/mcp"`,
    '-c', `mcp_servers.${serverName}.required=true`,
    '-c', `mcp_servers.${serverName}.startup_timeout_sec=${startupTimeoutSeconds}`,
    '-c', `mcp_servers.${serverName}.bearer_token_env_var="WAYFINDER_TOKEN"`,
    '-c', `mcp_servers.${serverName}.default_tools_approval_mode="approve"`];
  let host;

  function safe(value) {
    const text = JSON.stringify(value);
    for (const secret of [token, directory, control, databasePath]) assert(!text.includes(secret), 'Sensitive material in evidence');
  }

  async function start() {
    const child = fork(fileURLToPath(new URL('../../dist/mcp-start.js', import.meta.url)), [], {
      execArgv: ['--import', fileURLToPath(new URL('./codex-acceptance-observer.mjs', import.meta.url))],
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    let logs = '';
    const ready = new Promise(resolve => {
      child.stdout.on('data', data => { logs += data; if (logs.includes('Wayfinder local MCP ready')) resolve(); });
      child.stderr.on('data', data => { logs += data; });
    });
    host = { child, exit, logs: () => logs };
    await Promise.race([ready, exit.then(() => { throw new Error('Service startup failed'); })]);
    assert.match(logs, new RegExp(`ready version=${workflowContract.version.replaceAll('.', '\\.')}`));
  }

  async function stop() {
    if (!host) return;
    const current = host; host = undefined;
    current.child.kill('SIGTERM');
    assert.deepEqual(await current.exit, { code: 0, signal: null });
    safe(current.logs());
  }

  async function execute({ label, prompt, resume, expectSuccess = true, requireCalls = true,
    allowedCompletedItemTypes = ['agent_message', 'mcp_tool_call'] }) {
    const args = resume ? ['exec', 'resume', ...configuration, resume, '-']
      : ['exec', ...configuration, '-C', cwd, '-s', 'read-only', '-'];
    const child = spawn('codex', args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(prompt);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    safe({ stdout, stderr });
    if (expectSuccess) assert.equal(code, 0, 'Codex process failed');
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (expectSuccess) assert(events.some(event => event.type === 'turn.completed'), 'Codex turn incomplete');
    const items = events.filter(event => event.type === 'item.completed').map(event => event.item);
    assert(items.every(item => allowedCompletedItemTypes.includes(item.type)), 'Unexpected Codex operation');
    const calls = items.filter(item => item.type === 'mcp_tool_call');
    if (requireCalls) assert(calls.length > 0, 'No actual Codex tool calls');
    for (const call of calls) {
      assert.equal(call.server, serverName);
      assert.equal(call.error, null);
      assert.deepEqual(call.result.content, []);
      assert(schemas.get(call.tool)?.(call.result.structured_content), 'Codex result violates output schema');
      assert.equal(call.status === 'failed', call.result.structured_content.kind === 'infrastructure_error');
    }
    const record = { label, threadId: events.find(event => event.type === 'thread.started')?.thread_id ?? resume,
      calls: calls.map(({ tool, arguments: args, result, status }) => ({ tool, arguments: args, result, status })),
      finalMessage: items.filter(item => item.type === 'agent_message').at(-1)?.text };
    safe(record);
    if (expectSuccess) console.log(`Installed Codex ${label}: ${calls.length} real MCP calls completed`);
    return { code, events, items, calls, record };
  }

  async function known(mapId) {
    const storage = openSQLite(databasePath);
    try {
      const current = await storage.adapter.readCurrent(mapId);
      assert.equal(current.kind, 'found');
      const history = await Promise.all(Array.from({ length: current.value.currentRevision }, (_, index) => storage.adapter.readRevision(mapId, index + 1)));
      assert(history.every(item => item.kind === 'found'));
      return { current, history, catalog: storage.listMaps(), next: await storage.adapter.readRevision(mapId, current.value.currentRevision + 1) };
    } finally { storage.close(); }
  }

  function cleanup() {
    rmSync(directory, { recursive: true });
    rmSync(control, { recursive: true });
  }

  return { databasePath, protocolPath, env, safe, start, stop, execute, known, cleanup };
}
