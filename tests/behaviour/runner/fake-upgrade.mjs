#!/usr/bin/env node
// Deterministic Codex stand-in: real MCP over the shared sandbox route, no model or personal state.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
const model = args[args.indexOf('-m') + 1];
const resume = args[1] === 'resume' ? args.at(-2) : null;
const thread = resume ?? randomUUID();
const url = /mcp_servers\.wayfinder\.url="([^"]+)"/.exec(args.join(' '))[1];
const prompt = await new Promise(resolve => { let text = ''; process.stdin.on('data', d => { text += d; }); process.stdin.on('end', () => resolve(text)); });
let session; let request = 0; let item = 0;
const emit = e => console.log(JSON.stringify(e));
async function rpc(method, params, notify = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++request }) }) });
  if (response.status === 404 && session) {
    session = undefined;
    await initialize(); // Transport reconnect; the process deliberately retains its original model context.
    return rpc(method, params, notify);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  session ??= response.headers.get('mcp-session-id');
  return notify ? null : (await response.json()).result;
}
async function initialize() {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-upgrade', version: '0' } });
  await rpc('notifications/initialized', {}, true);
  return init;
}
const init = await initialize();
const definitions = await rpc('tools/list', {});
let version = /^version: (\S+)$/m.exec(init.instructions)[1];
const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '26');
mkdirSync(dir, { recursive: true });
const log = join(dir, `rollout-2026-10-26-${thread}.jsonl`);
const record = e => appendFileSync(log, JSON.stringify(e) + '\n');
if (!resume) record({ type: 'session_meta', payload: { id: thread, cli_version: '0.0.0-fake' } });
record({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: 'low' } } });
record({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: init.instructions }] } });
record({ type: 'response_item', payload: { type: 'additional_tools', tools: definitions.tools } });
emit({ type: 'thread.started', thread_id: thread }); emit({ type: 'turn.started' });
const say = text => emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } });
const done = () => emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
async function call(name, arguments_, resource = false) {
  const base = { id: `item_${item++}`, type: 'mcp_tool_call', server: 'wayfinder', tool: name, arguments: arguments_ };
  emit({ type: 'item.started', item: base });
  const result = await rpc(resource ? 'resources/read' : 'tools/call', resource ? arguments_ : { name, arguments: arguments_ });
  const content = resource ? result : result.structuredContent;
  emit({ type: 'item.completed', item: { ...base, result: { structured_content: content }, error: null, status: 'completed' } });
  if (resource) record({ type: 'response_item', payload: { type: 'function_call_output', call_id: base.id, output: JSON.stringify(result) } });
  return content;
}
if (model === 'fake-upgrade-no-trigger') { say('Stopped without creating the Map.'); done(); process.exit(0); }
if (!resume) {
  await call('map_list', { limit: 100 });
  await call('map_create', { version, mapId: 'Upgrade.Probe', title: 'Upgrade probe', destination: 'Learn how this client behaves across a service upgrade' });
  if (!prompt.includes('in this same turn')) { say('Created the probe Map.'); done(); process.exit(0); }
}
let head = await call('map_read', { mapId: 'Upgrade.Probe' });
let learned = init.instructions;
const write = () => call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: head.revision.revision,
  commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.One', title: `${learned.includes('LANTERN') ? 'v2: ' : ''}Probe`, question: 'Does the client pick up new rules after an upgrade?', type: 'research' } }] });
let result = await write();
if (result.code === 'version_mismatch') {
  if (model === 'fake-upgrade-stop') { say('Please refresh the tools.'); done(); process.exit(0); }
  const resource = await call('read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, true);
  const text = resource.contents[0].text;
  version = /^version: (\S+)$/m.exec(text)[1];
  if (model !== 'fake-upgrade-version-only') learned = text;
  head = await call('map_read', { mapId: 'Upgrade.Probe' });
  result = await write();
}
say(`${learned.includes('LANTERN') ? 'LANTERN ' : ''}Added the probe Ticket (${result.kind}).`);
done();
