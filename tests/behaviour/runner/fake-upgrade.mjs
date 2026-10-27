#!/usr/bin/env node
// Deterministic Codex stand-in: real MCP over the shared sandbox route, no model or personal state.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
const requestedModel = args[args.indexOf('-m') + 1];
const model = requestedModel.replace('fake-upgrade-text-', 'fake-upgrade-');
const codeMode = model === 'fake-upgrade-code-mode';
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
record({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: requestedModel, reasoning_effort: 'low' } } });
if (codeMode) {
  // Codex 0.164 exposes MCP metadata through exec output, not native tool definitions.
  record({ type: 'response_item', payload: { type: 'additional_tools', tools: [{ name: 'functions' }, { name: 'clock' }, { name: 'collaboration' }] } });
  record({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'discover-tools', output: [
    { type: 'input_text', text: 'Script completed' },
    { type: 'input_text', text: JSON.stringify(definitions.tools.map(t => ({ name: `mcp__wayfinder__${t.name}`,
      description: `${init.instructions}\n\nversion: ${version}\n\n${t.description}` }))) },
  ] } });
} else record({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: init.instructions }] } });
// Only this fake's owned rollout: force a refused old request after resume for Resource-recovery probes.
const oldInstructions = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  .find(e => e.type === 'response_item' && e.payload?.role === 'developer')?.payload.content[0].text ?? init.instructions;
const oldVersion = /^version: (\S+)$/m.exec(oldInstructions)[1];
if (!codeMode && definitions && model !== 'fake-upgrade-no-native-tools') record({ type: 'response_item', payload: { type: 'additional_tools', tools: definitions.tools } });
emit({ type: 'thread.started', thread_id: thread }); emit({ type: 'turn.started' });
const say = text => emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } });
const done = () => emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
// Tests expire the parent deadline only after the intended evidence has actually been emitted.
const pauseForTimeout = () => {
  emit({ type: 'fixture.timeout-ready' });
  return new Promise(() => { setInterval(() => {}, 60_000); }); // Stay alive until the owned parent terminates us.
};
async function call(name, arguments_, resource = false, nativeComplete = true) {
  if (codeMode && ['map_create', 'map_apply'].includes(name)) arguments_ = { ...arguments_, includeSnapshot: true };
  const base = { id: `item_${item++}`, type: 'mcp_tool_call', server: 'wayfinder', tool: name, arguments: arguments_ };
  emit({ type: 'item.started', item: base });
  const result = await rpc(resource ? 'resources/read' : 'tools/call', resource ? arguments_ : { name, arguments: arguments_ });
  const content = resource ? result : result.structuredContent;
  // Codex read_mcp_resource returns a JSON payload in text content, with no structured_content.
  const resourceText = resource ? JSON.stringify({ server: 'wayfinder', uri: arguments_.uri, ...result }) : null;
  const nativeResult = resource && model !== 'fake-upgrade-structured-resource'
    ? { content: [{ type: 'text', text: resourceText }], structured_content: null }
    : { content: [], structured_content: content };
  // A negative fixture: the native helper fails to deliver the Resource, yet the fake still retries.
  const resourceFailed = resource && model === 'fake-upgrade-failed-resource';
  if (nativeComplete) emit({ type: 'item.completed', item: { ...base, result: resourceFailed ? null : nativeResult,
    error: resourceFailed ? { message: 'Synthetic Resource delivery failure' } : null, status: resourceFailed ? 'failed' : 'completed' } });
  if (resource) record({ type: 'response_item', payload: { type: 'function_call_output', call_id: base.id,
    output: resourceFailed ? 'Synthetic Resource delivery failure' : resourceText } });
  return content;
}
if (model.startsWith('fake-upgrade-no-trigger')) {
  say('Stopped without creating the Map.');
  if (model.endsWith('-timeout')) await pauseForTimeout();
  done(); process.exit(0);
}
if (!resume) {
  await call('map_list', { limit: 100 });
  await call('map_create', { version, mapId: 'Upgrade.Probe', title: 'Upgrade probe', destination: 'Learn how this client behaves across a service upgrade' });
  if (model === 'fake-upgrade-early-ticket') await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: 1,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.One', title: 'Early probe', question: 'Too early?', type: 'research' } }] });
  if (!prompt.includes('in this same turn')) { say('Created the probe Map.'); done(); process.exit(0); }
}
let head = await call('map_read', { mapId: 'Upgrade.Probe' });
let learned = init.instructions;
if (resume && (requestedModel.startsWith('fake-upgrade-text-') || ['fake-upgrade-lost-resource', 'fake-upgrade-stale-lost-resource', 'fake-upgrade-failed-resource'].includes(model))) version = oldVersion;
const write = (expectedRevision = head.revision.revision) => call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision,
  commands: [{ kind: 'ticket.create', ticket: { id: model.includes('wrong-ticket') ? 'Probe.Uno' : 'Probe.One', title: `${learned.includes('LANTERN') ? 'v2: ' : ''}Probe`, question: 'Does the client pick up new rules after an upgrade?', type: 'research' } },
    ...(model.includes('two-tickets') ? [{ kind: 'ticket.create', ticket: { id: 'Probe.Two', title: 'v2: Extra', question: 'Extra?', type: 'research' } }] : [])] });
let result = await write(conflictReplay && resume ? head.revision.revision + 1 : head.revision.revision);
if (result.code === 'version_mismatch') {
  if (model === 'fake-upgrade-stop') { say('Please refresh the tools.'); done(); process.exit(0); }
  if (model === 'fake-upgrade-pre-exposure-timeout') say('I will read the new rules.');
  const resource = await call('read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, true, model !== 'fake-upgrade-lost-resource');
  const text = resource.contents[0].text;
  version = /^version: (\S+)$/m.exec(text)[1];
  if (model !== 'fake-upgrade-version-only') learned = text;
  head = await call('map_read', { mapId: 'Upgrade.Probe' }, false, model !== 'fake-upgrade-lost-reread');
  if (['fake-upgrade-repeat-refusal', 'fake-upgrade-stale-recovered-timeout', 'fake-upgrade-stale-lost-resource'].includes(model)) {
    const current = version;
    version = oldVersion;
    await write();
    version = current;
    if (model === 'fake-upgrade-stale-recovered-timeout' || model === 'fake-upgrade-stale-lost-resource') {
      await call('read_mcp_resource', { uri: 'wayfinder://workflow/exploration' }, true, model !== 'fake-upgrade-stale-lost-resource');
      head = await call('map_read', { mapId: 'Upgrade.Probe' });
    } // repeat-refusal deliberately skips both reads after the second refusal.
  }
  result = await write(conflictReplay ? head.revision.revision + 1 : head.revision.revision);
}
if (conflictReplay && result.kind === 'conflict') {
  head = await call('map_read', { mapId: 'Upgrade.Probe' });
  result = await write();
}
if (model === 'fake-upgrade-bad-reply') say('Recovered under the new rules.');
if (model !== 'fake-upgrade-pre-exposure-timeout') say(`${learned.includes('LANTERN') ? 'LANTERN ' : ''}Added the probe Ticket (${result.kind}).`);
if (model === 'fake-upgrade-pre-exposure-timeout' || model === 'fake-upgrade-stale-recovered-timeout')
  await pauseForTimeout();
if (model === 'fake-upgrade-conflict-unknown-timeout' || model === 'fake-upgrade-conflict-two-tickets-timeout') {
  // The server rejects this duplicate Ticket, but its native completion is deliberately lost.
  await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: result.revision,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.One', title: 'v2: Duplicate', question: 'Again?', type: 'research' } }] }, false, false);
  await pauseForTimeout();
}
if (model === 'fake-upgrade-two-tickets-timeout' || model === 'fake-upgrade-wrong-ticket-timeout')
  await pauseForTimeout();
if (model === 'fake-upgrade-extra-timeout') {
  await call('map_apply', { version, mapId: 'Upgrade.Probe', expectedRevision: result.revision,
    commands: [{ kind: 'ticket.create', ticket: { id: 'Probe.Two', title: 'v2: Extra', question: 'An extra write?', type: 'research' } }] });
  await pauseForTimeout();
}
done();
