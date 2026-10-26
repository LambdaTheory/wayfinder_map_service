#!/usr/bin/env node
// Deterministic Codex stand-in: real MCP over the shared sandbox route, no model or personal state.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
const model = args[args.indexOf('-m') + 1];
const conflictReplay = model.startsWith('fake-upgrade-conflict-');
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
const definitions = model === 'fake-upgrade-no-tools' ? null : await rpc('tools/list', {});
let version = /^version: (\S+)$/m.exec(init.instructions)[1];
const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '26');
mkdirSync(dir, { recursive: true });
const log = join(dir, `rollout-2026-10-26-${thread}.jsonl`);
const record = e => appendFileSync(log, JSON.stringify(e) + '\n');
if (!resume) record({ type: 'session_meta', payload: { id: thread, cli_version: '0.0.0-fake' } });
record({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: 'low' } } });
record({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: init.instructions }] } });
if (definitions && model !== 'fake-upgrade-no-native-tools') record({ type: 'response_item', payload: { type: 'additional_tools', tools: definitions.tools } });
emit({ type: 'thread.started', thread_id: thread }); emit({ type: 'turn.started' });
const say = text => emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } });
const done = () => emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
async function call(name, arguments_, resource = false, nativeComplete = true) {
  const base = { id: `item_${item++}`, type: 'mcp_tool_call', server: 'wayfinder', tool: name, arguments: arguments_ };
  emit({ type: 'item.started', item: base });
  const result = await rpc(resource ? 'resources/read' : 'tools/call', resource ? arguments_ : { name, arguments: arguments_ });
  const content = resource ? result : result.structuredContent;
  if (nativeComplete) emit({ type: 'item.completed', item: { ...base, result: { structured_content: content }, error: null, status: 'completed' } });
  if (resource) record({ type: 'response_item', payload: { type: 'function_call_output', call_id: base.id, output: JSON.stringify(result) } });
  return content;
}
if (model === 'fake-upgrade-no-trigger') { say('Stopped without creating the Map.'); done(); process.exit(0); }
if (!resume) {
  await call('map_list', { limit: 100 });
  await call('map_create', { version, mapId: 'Upgrade.Probe', title: 'Upgrade probe', destination: 'Learn how this client behaves across a service upgrade' });
  if (model === 'fake-upgrade-early-ticket') await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: 1,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.One', title: 'Early probe', question: 'Too early?', type: 'research' } }] });
  if (!prompt.includes('in this same turn')) { say('Created the probe Map.'); done(); process.exit(0); }
}
let head = await call('map_read', { mapId: 'Upgrade.Probe' });
let learned = init.instructions;
const write = (expectedRevision = head.revision.revision) => call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision,
  commands: [{ kind: 'ticket.create', ticket: { id: model.includes('wrong-ticket') ? 'Probe.Uno' : 'Probe.One', title: `${learned.includes('LANTERN') ? 'v2: ' : ''}Probe`, question: 'Does the client pick up new rules after an upgrade?', type: 'research' } },
    ...(model.includes('two-tickets') ? [{ kind: 'ticket.create', ticket: { id: 'Probe.Two', title: 'v2: Extra', question: 'Extra?', type: 'research' } }] : [])] });
let result = await write(conflictReplay && resume ? head.revision.revision + 1 : head.revision.revision);
if (result.code === 'version_mismatch') {
  if (model === 'fake-upgrade-stop') { say('Please refresh the tools.'); done(); process.exit(0); }
  const resource = await call('read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, true);
  const text = resource.contents[0].text;
  version = /^version: (\S+)$/m.exec(text)[1];
  if (model !== 'fake-upgrade-version-only') learned = text;
  head = await call('map_read', { mapId: 'Upgrade.Probe' });
  if (model === 'fake-upgrade-repeat-refusal') {
    const current = version;
    version = /^version: (\S+)$/m.exec(init.instructions)[1];
    await write();
    version = current; // Deliberately skip both reads after the second refusal.
  }
  result = await write(conflictReplay ? head.revision.revision + 1 : head.revision.revision);
}
if (conflictReplay && result.kind === 'conflict') {
  head = await call('map_read', { mapId: 'Upgrade.Probe' });
  result = await write();
}
if (model === 'fake-upgrade-bad-reply') say('Recovered under the new rules.');
say(`${learned.includes('LANTERN') ? 'LANTERN ' : ''}Added the probe Ticket (${result.kind}).`);
if (model === 'fake-upgrade-conflict-unknown-timeout' || model === 'fake-upgrade-conflict-two-tickets-timeout') {
  // The server rejects this duplicate Ticket, but its native completion is deliberately lost.
  await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: result.revision,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.One', title: 'v2: Duplicate', question: 'Again?', type: 'research' } }] }, false, false);
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
if (model === 'fake-upgrade-two-tickets-timeout' || model === 'fake-upgrade-wrong-ticket-timeout')
  await new Promise(resolve => setTimeout(resolve, 30_000));
if (model === 'fake-upgrade-extra-timeout') {
  await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: result.revision,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.Two', title: 'v2: Extra', question: 'An extra write?', type: 'research' } }] });
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
done();
