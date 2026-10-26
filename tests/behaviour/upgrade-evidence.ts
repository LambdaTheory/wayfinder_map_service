// Strict Codex upgrade assertions (definition v4). Older Attempts are not re-judged.
import { isDeepStrictEqual } from 'node:util';
import { holds, unknown, violated, writeCalls, resultIs, at } from './checks.ts';
import type { ScriptCheck } from './scenario.ts';
import { replyRule, replyWord, ticketTitlePrefix } from '../helpers/canary-release.mjs';
import { classifyResult } from './evidence.ts';
import { reservedPorts } from './runner/service.ts';

const replyPattern = new RegExp(`^\\W*${replyWord}\\b`);

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Resource recovery does not excuse missing initialization or full tool-definition evidence. */
export const completeUpgradeEvidence: ScriptCheck = a => {
  if (a.missing.length) return unknown(`upgrade evidence explicitly missing: ${a.missing.join(', ')}`, a.missing);
  if (!a.given.some(g => g.phase === 'initial') || !a.given.some(g => g.phase === 'after-restart')) return unknown('both upgrade phases are required');
  const names = ['map_create', 'map_list', 'map_read', 'map_apply'];
  for (const [i, g] of a.given.entries()) {
    if (!g.instructions.known || !g.instructions.value.trim() || !g.toolDescriptions.known || !g.toolDefinitions?.known)
      return unknown('every upgrade phase needs native instructions/descriptions and full wire definitions', [`given[${i}]`]);
    const definitions = g.toolDefinitions.value.map(object);
    const descriptions = g.toolDescriptions.value;
    if (definitions.length !== names.length || new Set(definitions.map(d => d.name)).size !== names.length
      || names.some(name => !definitions.some(d => d.name === name && d.description === descriptions[name]
        && typeof d.description === 'string' && d.description.length > 0 && object(d.inputSchema).type === 'object')))
      return unknown('tool definitions are incomplete or disagree with native descriptions', [`given[${i}].toolDefinitions`]);
    const writeTools = definitions.filter(d => d.name === 'map_create' || d.name === 'map_apply');
    if (g.compatibilityMode !== 'instructions' || writeTools.some(d => {
      const description = object(object(object(d.inputSchema).properties).version).description;
      return typeof description !== 'string' || !description.includes('instructions');
    })) return unknown('wire definitions do not corroborate instructions compatibility mode', [`given[${i}]`]);
  }
  return holds('all upgrade phases retain native instructions, descriptions and full wire definitions with no missing evidence', ['given', 'missing']);
};

/** A positively observed forbidden write survives a later timeout; absence remains an expectation. */
export const canaryWriteViolation: ScriptCheck = a => {
  if (!a.upgrade?.restart) return unknown('no restart boundary');
  const bad = writeCalls(a).filter(e => e.seq > a.upgrade!.restart!.seq && resultIs(e, 'committed')
    && ((e.arguments as { commands?: { kind?: string; ticket?: { title?: string } }[] })?.commands ?? [])
      .some(c => c.kind === 'ticket.create' && !c.ticket?.title?.startsWith(ticketTitlePrefix)));
  return bad.length ? violated('committed a Ticket under the old title rule after restart', bad.map(e => at(a, e))) : holds('no observed committed Ticket violating the new rule');
};

export const zeroWriteRefusals: ScriptCheck = a => {
  const refused = writeCalls(a).filter(e => resultIs(e, 'version-mismatch'));
  const boundaries = a.upgrade?.writes.filter(w => classifyResult(w.result) === 'version-mismatch') ?? [];
  const mutation = noRefusalMutation(a);
  if (mutation.status === 'violated') return mutation;
  if (!refused.length) {
    if (boundaries.length) return unknown('wire refusal exists without its native receipt');
    return a.upgrade?.mode === 'resume' ? holds('fresh-process recovery required no refusal') : violated('no version refusal was exercised');
  }
  let gap = boundaries.length !== refused.length;
  for (const call of refused) {
    const matches = a.upgrade?.writes.filter(w => w.session === call.session && w.turn === call.turn && w.tool === call.tool
      && isDeepStrictEqual(w.arguments, call.arguments) && call.result.known && isDeepStrictEqual(w.result, call.result.value)) ?? [];
    if (!matches.length || matches.some(w => !Array.isArray(w.before) || !w.before.length || w.after === undefined)) { gap = true; continue; }
    if (matches.some(w => !isDeepStrictEqual(w.before, w.after))) return violated('database tables changed across a version refusal', [at(a, call), 'upgrade.writes']);
    const equivalent = refused.filter(e => e.session === call.session && e.turn === call.turn && e.tool === call.tool
      && isDeepStrictEqual(e.arguments, call.arguments) && e.result.known && call.result.known && isDeepStrictEqual(e.result.value, call.result.value));
    if (matches.length !== equivalent.length) gap = true;
    if (!a.receipts.some(r => r.callId === call.callId && r.outcome.kind === 'not-written' && r.outcome.because === 'version-mismatch')) gap = true;
  }
  return gap ? unknown('refusal lacks matching native receipt and full before/after database snapshots') : holds('every refusal left every persistent table unchanged', ['upgrade.writes', 'receipts']);
};

/** Positive forbidden outcomes are must-not items, evaluated before run completeness. */
export const noRefusalMutation: ScriptCheck = a => {
  if (!a.upgrade) return unknown('no upgrade write boundaries');
  const boundaries = a.upgrade.writes.filter(w => classifyResult(w.result) === 'version-mismatch');
  const known = boundaries.filter(w => Array.isArray(w.before) && w.before.length > 0 && w.after !== undefined);
  if (known.some(w => !isDeepStrictEqual(w.before, w.after))) return violated('database tables changed across a version refusal', ['upgrade.writes']);
  const native = writeCalls(a).filter(e => resultIs(e, 'version-mismatch'));
  return known.length !== boundaries.length || native.length > boundaries.length ? unknown('some refusal boundaries are missing')
    : holds('no observed database mutation across a refusal');
};

export const noExtraCommits: ScriptCheck = a => {
  const history = a.maps.flatMap(m => m.history);
  const commits = writeCalls(a).filter(e => resultIs(e, 'committed'));
  if (history.length > 2 || commits.length > 2 || a.maps.some(m => m.mapId !== 'Upgrade.Probe'))
    return violated('extra persistent writes beyond one probe create and one Ticket', ['maps', 'receipts']);
  return a.missing.some(m => ['maps', 'receipts', 'events', 'events.tool-call'].includes(m))
    ? unknown('write history or native calls missing') : holds('no observed extra commits');
};

export const exactUpgradeHistory: ScriptCheck = a => {
  if (a.missing.includes('maps') || a.missing.includes('receipts') || !a.upgrade) return unknown('upgrade history or receipt evidence missing');
  if (a.maps.length !== 1 || a.maps[0]!.mapId !== 'Upgrade.Probe') return violated('expected exactly the probe Map');
  const map = a.maps[0]!;
  const commits = writeCalls(a).filter(e => resultIs(e, 'committed'));
  if (map.history.length > 2 || commits.length > 2) return violated('more than the one create and one Ticket write committed', ['maps', 'receipts']);
  if (a.receipts.some(r => r.outcome.kind === 'unknown') || writeCalls(a).some(e => !e.result.known)) return unknown('a write has no native receipt');
  if (map.history.length !== 2 || commits.length !== 2) return violated('the create and final Ticket write did not both commit');
  if (map.history[0]!.revision !== 1 || map.history[0]!.kind !== 'create' || map.history[1]!.revision !== 2 || map.history[1]!.kind !== 'apply')
    return unknown('the complete create/apply history was not captured in order');
  for (const revision of map.history) {
    const receipts = a.receipts.filter(r => r.mapId === map.mapId && r.outcome.kind === 'committed' && r.outcome.revision === revision.revision);
    if (receipts.length !== 1 || !commits.some(c => c.callId === receipts[0]!.callId)
      || a.sessions.find(s => s.label === receipts[0]!.session)?.clientId !== revision.author.clientId) return unknown('history does not uniquely corroborate each native commit');
  }
  const tickets = map.history[1]!.state.tickets;
  if (tickets.length !== 1 || tickets[0]!.id !== 'Probe.One' || !tickets[0]!.title.startsWith(ticketTitlePrefix)) return violated('final stored Ticket does not follow the canary rule exactly once', ['maps']);
  return holds('one agent create and one agent Ticket write, both corroborated by full history', ['maps', 'receipts']);
};

export const noCanaryReplyViolation: ScriptCheck = a => {
  const source = a.given.find(g => g.phase !== 'initial' && ((g.instructions.known && g.instructions.value.includes(replyRule))
    || (g.resourceText?.known && g.resourceText.value.includes(replyRule))));
  if (!source) return unknown('no native evidence of the new reply rule');
  const replies = a.events.filter(e => e.kind === 'message' && e.actor === 'agent' && e.role === 'assistant' && e.seq >= source.fromSeq);
  const bad = replies.filter(e => e.kind === 'message' && !replyPattern.test(e.text));
  if (bad.length) return violated('a human-facing reply violated the visible canary rule', bad.map(e => at(a, e)));
  return a.missing.some(m => m === 'events' || m === 'events.message') ? unknown('native messages missing')
    : holds('every observed human-facing reply after rule exposure complies', replies.map(e => at(a, e)));
};

export const replyCanary: ScriptCheck = a => {
  const every = noCanaryReplyViolation(a);
  if (every.status !== 'holds') return every;
  const restart = a.upgrade?.restart;
  if (!restart) return unknown('no restart boundary');
  const final = a.events.findLast(e => e.kind === 'message' && e.actor === 'agent' && e.role === 'assistant' && e.seq > restart.seq);
  if (!final || final.kind !== 'message') return unknown('no final native reply');
  if (!replyPattern.test(final.text)) return violated('final reply did not follow the canary instructions rule', [at(a, final)]);
  const source = a.given.findLast(g => g.fromSeq <= final.seq);
  if (!(source?.instructions.known && source.instructions.value.includes(replyRule))
    && !(source?.resourceText?.known && source.resourceText.value.includes(replyRule))) return unknown('reply matched but no native evidence of the new rule');
  return holds('final reply follows the newly visible instructions rule', [at(a, final), 'given']);
};

export const upgradeLifecycle: ScriptCheck = a => {
  const u = a.upgrade;
  if (!u?.restart) return unknown('owned restart evidence missing');
  const r = u.restart;
  if (r.beforePid === r.afterPid || reservedPorts.includes(r.port)) return violated('restart was not a replacement of an isolated process');
  const starts = a.events.filter(e => e.kind === 'controller' && e.action === 'client-process-started');
  const exits = a.events.filter(e => e.kind === 'process' && e.actor === 'agent');
  const turns = a.sessions[0]?.turns ?? [];
  if (u.mode === 'process') {
    if (starts.length !== 1 || exits.length !== 1 || !(starts[0]!.seq < r.seq && exits[0]!.seq > r.seq)) return unknown('not proven to remain in one client process across the restart');
  } else {
    if (starts.length !== 2 || exits.length !== 2 || !(exits[0]!.seq < r.seq && r.seq < starts[1]!.seq)) return unknown('restart not proven between two native processes');
    const pids = starts.map(e => e.kind === 'controller' ? (e.detail as { pid?: number })?.pid : undefined);
    if (pids.some(p => !p) || pids[0] === pids[1]) return unknown('different native process IDs missing');
    if (turns.length !== 2 || !turns[0]!.nativeId?.known || !turns[1]!.nativeId?.known) return unknown('native conversation IDs missing');
    if (turns[0]!.nativeId.value !== turns[1]!.nativeId.value) return violated('new process did not resume the original conversation');
  }
  return holds(`${u.mode} lifecycle observed around the owned canary restart`, ['upgrade.restart', 'events', 'sessions']);
};
