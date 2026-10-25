#!/usr/bin/env node
// A stand-in for `codex exec` in tests: makes real MCP calls to the run's service and prints Codex-shaped JSON
// events, so the runner, normalizer and receipts are exercised without a model. It plays S0b: the first turn
// pages the catalog and asks to confirm the Destination; a reply creates one Map and publishes a Ticket.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
// The account's real home, not the private HOME the runner gives the client.
const realHome = userInfo().homedir;
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
const url = /mcp_servers\.wayfinder\.url="([^"]+)"/.exec(args.join(' '))[1];
const resume = args[1] === 'resume' ? args.at(-2) : null;
const thread = resume ?? randomUUID();
const prompt = await new Promise(resolve => { let text = ''; process.stdin.on('data', d => { text += d; }); process.stdin.on('end', () => resolve(text)); });
const emit = event => console.log(JSON.stringify(event));
// Failure drills for the runner's tests.
if (prompt.includes('FAKE-CRASH')) { console.error('fake launch failure'); process.exit(3); }
if (prompt.includes('FAKE-SLEEP')) await new Promise(resolve => setTimeout(resolve, 30_000));
let session; let n = 0;
async function rpc(method, params, notify = false) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WAYFINDER_TOKEN}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++n }) }) });
  session ??= response.headers.get('mcp-session-id');
  return notify ? null : (await response.json()).result;
}
const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } });
await rpc('notifications/initialized', {}, true);
const version = /^version: (\S+)$/m.exec(init.instructions)[1];
const rollout = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '25');
mkdirSync(rollout, { recursive: true });
const log = join(rollout, `rollout-2026-10-25T00-00-00-${thread}.jsonl`);
const record = e => appendFileSync(log, JSON.stringify(e) + '\n');
if (!resume) record({ type: 'session_meta', payload: { id: thread, cli_version: '0.0.0-fake' } });
record({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'fake-model', reasoning_effort: 'low' } } });
const tools = await rpc('tools/list', {});
record({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: init.instructions }] } });
record({ type: 'response_item', payload: { type: 'additional_tools', tools: tools.tools.map(t => ({ name: t.name, description: t.description })) } });
emit({ type: 'thread.started', thread_id: thread });
emit({ type: 'turn.started' });
let item = 0;
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'mcp_tool_call', server: 'wayfinder', tool: name, arguments: args,
    result: { content: [], structured_content: result.structuredContent }, error: null, status: 'completed' } });
  return result.structuredContent;
}
// Real file access, so a sandboxed run shows what the agent can and cannot reach.
const tryFile = (command, action) => { let code = 0; try { action(); } catch { code = 1; }
  emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'command_execution', command, aggregated_output: '', exit_code: code, status: 'completed' } }); };
tryFile("/bin/zsh -lc 'cat README.md'", () => { if (existsSync('README.md')) readFileSync('README.md'); });
tryFile(`/bin/zsh -lc 'cat ${realHome}/workspace/AGENTS.md'`, () => readFileSync(join(realHome, 'workspace/AGENTS.md')));
tryFile("/bin/zsh -lc 'echo note > fake-note.txt'", () => writeFileSync('fake-note.txt', 'note\n'));
if (!/只用考虑飞书/.test(prompt)) {
  await tool('map_list', { limit: 100 });
  emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text: '建议目的地：飞书侧接入方案。请确认这个目的地和范围。' } });
} else {
  await tool('map_list', { limit: 100 });
  const created = await tool('map_create', { version, mapId: 'Feishu.Fake', title: '飞书侧接入', destination: '飞书侧接入方案，Agent 系统视为已有。' });
  await tool('map_apply', { version, mapId: 'Feishu.Fake', expectedRevision: created.revision,
    commands: [{ kind: 'ticket.create', ticket: { id: 'entry', title: '任务入口', question: '用户从飞书的什么入口发起任务？', type: 'grilling' } }] });
  emit({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text: '已建图，第一题：任务入口用什么？' } });
}
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
