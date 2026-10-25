// Opt-in live check, not part of `npm test`: does one open Codex or Claude Code conversation adopt a new
// release when the service restarts underneath it? It drives a real client through a launcher that
// supports the WAYFINDER_AGENT_* overrides (the workspace `wayfinder` command), against a disposable
// database and a canary build of the same checkout whose rules a model can only follow if it saw them.
//
//   WAYFINDER_LAUNCHER=scripts/wayfinder-agent/wayfinder \
//     node tests/helpers/upgrade-live.mjs <codex|claude> <live|resume> [model] [effort]
//
// live:   one client process creates a Map, sleeps while the service restarts as the canary, then adds a Ticket.
// resume: the first process creates the Map and exits; the canary starts; the same conversation resumes and adds the Ticket.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canaryVersion, writeCanaryCheckout } from './canary-release.mjs';

const [client, mode, model = client === 'codex' ? 'gpt-6-astra' : 'sonnet', effort = 'low'] = process.argv.slice(2);
assert(['codex', 'claude'].includes(client) && ['live', 'resume'].includes(mode), 'usage: <codex|claude> <live|resume> [model] [effort]');
const launcher = process.env.WAYFINDER_LAUNCHER;
assert(launcher, 'WAYFINDER_LAUNCHER must name a launcher with WAYFINDER_AGENT_* overrides');
const checkout = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const port = process.env.WAYFINDER_UPGRADE_PORT ?? '18866';
assert(port !== '18766', 'never test against the real service port');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = realpathSync(mkdtempSync(join(homedir(), 'Library/Application Support/Wayfinder/upgrade-live-')));
const databasePath = join(root, 'db', 'maps.sqlite');
mkdirSync(join(root, 'db'), { mode: 0o700 }); mkdirSync(join(root, 'work'));
const { initializeSQLite } = await import(pathToFileURL(join(checkout, 'dist/sqlite-storage.js')).href);
await initializeSQLite(databasePath);
const canary = join(root, 'canary');
const { before: workflowContract } = await writeCanaryCheckout(checkout, canary);

const env = (from) => ({ ...process.env, WAYFINDER_AGENT_CHECKOUT: from, WAYFINDER_AGENT_DATABASE: databasePath,
  WAYFINDER_AGENT_STATE_ROOT: join(root, 'state'), WAYFINDER_AGENT_SERVICE_DIR: join(root, 'svc'),
  WAYFINDER_AGENT_OUTPUTS: join(root, 'outputs'), WAYFINDER_AGENT_PORT: port });
const command = (from, ...args) => {
  const out = spawnSync(launcher, args, { env: env(from), cwd: join(root, 'work'), encoding: 'utf8' });
  assert.equal(out.status, 0, `${args.join(' ')} failed: ${out.stdout}${out.stderr}`);
  return out.stdout + out.stderr;
};

const createStep = 'The human has confirmed this Destination. Create the Wayfinder Map `Upgrade.Probe` titled "Upgrade probe" '
  + 'with destination "Learn how this client behaves across a service upgrade" (page `map_list` first, as the tools require).';
const ticketStep = 'Add one research Ticket `Probe.One` to `Upgrade.Probe` with the question '
  + '"Does the client pick up new rules after an upgrade?" Then tell the human what you did.';
const prompts = mode === 'live'
  ? [`Three steps, in order. 1. ${createStep} 2. Run the shell command \`sleep 75\` and wait for it to finish. 3. ${ticketStep}`]
  : [`${createStep} Then tell the human what you did and stop.`, ticketStep];

function clientArgs(prompt, sessionId) {
  const base = ['--harness', client, '--model', model, '--effort', effort, '--'];
  if (client === 'codex') {
    return [...base, 'exec', ...(sessionId ? ['resume', sessionId] : []), '--skip-git-repo-check', '--json', prompt];
  }
  return [...base, '-p', '--output-format', 'stream-json', '--verbose', ...(sessionId ? ['--resume', sessionId] : []), prompt];
}

function runClient(prompt, sessionId, onLine) {
  return new Promise(resolve => {
    const child = spawn(launcher, clientArgs(prompt, sessionId), { env: env(checkout), cwd: join(root, 'work'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let buffered = '';
    child.stdout.on('data', data => {
      out += data; buffered += data;
      const lines = buffered.split('\n'); buffered = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on('data', data => { err += data; });
    child.on('exit', code => resolve({ code, out, err }));
  });
}

function query(sql) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
const probeExists = () => query("SELECT 1 FROM catalog WHERE map_id = 'Upgrade.Probe'").length > 0;

// What reached the database, written by whom: the evidence that does not depend on the client's own account.
function mapEvidence() {
  return query('SELECT map_id, revision, record FROM revisions ORDER BY map_id, revision').map(row => {
    const record = JSON.parse(row.record);
    return { mapId: row.map_id, revision: row.revision, clientId: record.author?.clientId,
      tickets: (record.state?.tickets ?? []).map(ticket => ({ id: ticket.id, title: ticket.title })) };
  });
}

// Tool calls and replies from the client's own event stream, kept short.
function events(transcript) {
  const found = [];
  for (const line of transcript.out.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (client === 'codex' && event.item) {
      const item = event.item;
      if (event.type === 'item.completed' && item.type === 'mcp_tool_call') {
        found.push({ call: `${item.server}.${item.tool}`, arguments: item.arguments, status: item.status,
          result: JSON.stringify(item.result ?? item.error ?? null).slice(0, 400) });
      } else if (event.type === 'item.completed' && item.type === 'agent_message') found.push({ reply: item.text });
      else if (event.type === 'item.completed' && item.type === 'command_execution') found.push({ command: item.command });
    }
    if (client === 'claude' && event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_use') found.push({ call: part.name, arguments: part.input });
        if (part.type === 'text') found.push({ reply: part.text });
      }
    }
    if (client === 'claude' && event.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_result') found.push({ result: JSON.stringify(part.content).slice(0, 400), isError: part.is_error });
      }
    }
  }
  return found;
}

const restartAsCanary = () => command(canary, 'restart');

command(checkout, 'serve');
const transcripts = [];
let restartLog = '';
if (mode === 'live') {
  // Restart once the Map exists, while the client sleeps between its two writes.
  let exited = false;
  const restarting = (async () => {
    while (!exited && !probeExists()) await sleep(500);
    if (exited) return;
    await sleep(5000);
    restartLog = restartAsCanary();
  })();
  transcripts.push(await runClient(prompts[0]));
  exited = true;
  await restarting;
} else {
  const first = await runClient(prompts[0]);
  transcripts.push(first);
  const sessionId = client === 'codex'
    ? JSON.parse(first.out.split('\n').find(line => line.includes('"thread.started"')) ?? '{}').thread_id
    : JSON.parse(first.out.split('\n').find(line => line.includes('"session_id"')) ?? '{}').session_id;
  assert(sessionId, 'no session id in the first transcript');
  restartLog = restartAsCanary();
  transcripts.push(await runClient(prompts[1], sessionId));
}
const status = command(canary, 'status');
command(canary, 'stop');

writeFileSync(join(root, 'transcripts.json'), JSON.stringify(transcripts, null, 2));
const maps = mapEvidence();
const ticket = maps.filter(row => row.mapId === 'Upgrade.Probe').flatMap(row => row.tickets).find(t => t.id === 'Probe.One');
const replies = transcripts.flatMap(events).filter(e => e.reply).map(e => e.reply);
const summary = { client, mode, model, effort, versions: { before: workflowContract.version, after: canaryVersion },
  exitCodes: transcripts.map(t => t.code), restartLog: restartLog.trim(), maps,
  verdict: { ticketWritten: Boolean(ticket), ticketFollowsNewRule: ticket ? ticket.title.startsWith('v2: ') : null,
    lastReplyFollowsNewRule: replies.length ? /^\W*LANTERN/.test(replies.at(-1)) : null },
  events: transcripts.map(events), status };
writeFileSync(join(root, 'run.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ root, ...summary.verdict, exitCodes: summary.exitCodes }));
