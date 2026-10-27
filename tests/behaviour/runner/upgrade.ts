// Upgrade-only observation. The Controller never fills a version, reads rules for the agent or repairs a write.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canaryContract } from '../../helpers/canary-release.mjs';
import type { CanaryContract } from '../../helpers/canary-release.mjs';
import type { AttemptRecord, EventRecord, GivenRules } from '../evidence.ts';
import type { RolloutFacts } from './normalize.ts';
import { initialRules, shown } from './normalize.ts';
import type { RelayObservation, RpcRequest } from './relay.ts';
import { structuredReply, rpcReply } from './relay.ts';
import { checkoutRoot } from './service.ts';

/** All persistent tables, not merely the head Revision or the refused response's claim. */
export function databaseState(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    const snapshot = tables.map(table => ({ ...table, rows: db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"', '""')}" ORDER BY rowid`).all() }));
    db.exec('COMMIT');
    return snapshot;
  } finally { db.close(); }
}

export async function upgradeEvidence(mode: 'process' | 'resume'): Promise<NonNullable<AttemptRecord['upgrade']>> {
  const { workflowContract } = await import(pathToFileURL(join(checkoutRoot, 'dist/workflow.generated.js')).href) as { workflowContract: CanaryContract };
  if (workflowContract.version === canaryContract(workflowContract).version) throw new Error('Canary must differ from the starting release');
  return { mode, contracts: { before: workflowContract, after: canaryContract(workflowContract) }, writes: [] };
}

export const isWrite = (rpc: RpcRequest) => rpc.method === 'tools/call' && ['map_create', 'map_apply'].includes(rpc.params?.name ?? '');

/** Join raw wire definitions to native evidence without turning server delivery into model visibility. */
export function upgradeRules(upgrade: NonNullable<AttemptRecord['upgrade']>, rollout: RolloutFacts | null,
  events: EventRecord[], log: (RelayObservation & { turn: number | null })[], session: string, turn: number, fromSeq: number): GivenRules[] {
  const { before, after } = upgrade.contracts;
  const currentResource = `version: ${after.version}\n\n${after.markdown}`;
  const restart = upgrade.restart?.seq;
  // Resource text contains the instructions and tool blocks too. Search their native channels separately,
  // otherwise a Resource read would falsely prove the client refreshed its cached initialization/tools.
  const channels = { instructions: '', tools: '', outputs: '' };
  const discoveries: { fromSeq: number; text: string }[] = [];
  const nativeEvents = events.filter(e => e.actor === 'agent' && e.session === session && e.turn === turn);
  let nextSeq = fromSeq;
  let positioned = true;
  for (const line of rollout?.text.split('\n') ?? []) {
    try {
      const e = JSON.parse(line);
      const p = e.payload;
      // Code-mode exec outputs have no normalized Event of their own. Place discovery
      // between the surrounding native completions, never at the beginning of the turn.
      if (e.type === 'event_msg' && p?.type === 'item_completed') {
        const item = p.item;
        if (item?.type === 'AgentMessage' || item?.type === 'McpToolCall') {
          const message = Array.isArray(item.content) ? item.content.map((c: { text?: string } | null) => c?.text ?? '').join('') : null;
          const match = nativeEvents.find(event => event.seq >= nextSeq && (item.type === 'AgentMessage'
            ? event.kind === 'message' && event.role === 'assistant' && event.text === message
            : event.kind === 'tool-call' && event.server === item.server && event.tool === item.tool && isDeepStrictEqual(event.arguments, item.arguments)));
          positioned = !!match;
          if (match) {
            nextSeq = match.seq + 1;
            // Resource reads have a derived event immediately after the native tool call.
            if (nativeEvents.some(event => event.seq === nextSeq && event.kind === 'resource-read')) nextSeq++;
          }
        }
      }
      if (e.type !== 'response_item' || !p) continue;
      if (p.type === 'message' && p.role === 'developer') channels.instructions += line + '\n';
      if (p.type === 'additional_tools') channels.tools += line + '\n';
      if (p.type === 'custom_tool_call_output') {
        // Code mode discovers MCP metadata through exec. Its output is JSON text, either
        // directly or in input_text blocks; a Resource's contents object is not a tool list.
        const texts = typeof p.output === 'string' ? [p.output] : Array.isArray(p.output)
          ? p.output.filter((b: { type?: string; text?: unknown } | null) => b?.type === 'input_text' && typeof b.text === 'string').map((b: { text: string }) => b.text) : [];
        for (const text of texts) {
          try {
            const list = JSON.parse(text);
            if (!Array.isArray(list)) continue;
            const descriptions = list.filter(t => typeof t?.name === 'string' && t.name.startsWith('mcp__wayfinder__') && typeof t.description === 'string')
              .map(t => t.description);
            if (descriptions.length && positioned) discoveries.push({ fromSeq: nextSeq,
              text: (discoveries.at(-1)?.text ?? '') + JSON.stringify(descriptions) + '\n' });
          } catch { /* Non-JSON exec output does not expose tool definitions. */ }
        }
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || (p.type === 'message' && p.role === 'tool')) channels.outputs += line + '\n';
    } catch { /* Missing native channel remains unknown. */ }
  }
  const phase = (contract: typeof before, seq: number, initial: boolean): GivenRules => {
    const instructionDiscovery = discoveries.find(d => shown(channels.instructions + d.text, contract.instructions));
    const toolDiscovery = discoveries.find(d => Object.values(contract.toolDescriptions).every(text => shown(channels.tools + d.text, text)));
    const nativeInstructions = shown(channels.instructions, contract.instructions);
    const nativeTools = Object.values(contract.toolDescriptions).every(d => shown(channels.tools, d));
    const rules = initialRules(contract.version, contract.instructions, contract.toolDescriptions,
      rollout && { ...rollout, text: channels.instructions + (instructionDiscovery?.text ?? '') });
    rules.toolDescriptions = rollout && (nativeTools || toolDiscovery)
      ? { known: true, value: contract.toolDescriptions } : { known: false, reason: 'tool descriptions not found in native additional_tools or code-mode discovery' };
    const exposedAt = Math.max(seq, nativeInstructions ? seq : instructionDiscovery?.fromSeq ?? seq, nativeTools ? seq : toolDiscovery?.fromSeq ?? seq);
    const tools = log.flatMap(e => {
      if (e.turn !== turn || e.phase !== 'response' || e.method !== 'tools/list' || e.status !== 200) return [];
      try { const list = (rpcReply(e.body, e.requestId)?.result as { tools?: unknown[] } | undefined)?.tools; return Array.isArray(list) ? [list] : []; } catch { return []; }
    }).find(list => list.every(t => t !== null && typeof t === 'object' && 'name' in t && typeof t.name === 'string'
      && 'description' in t && t.description === contract.toolDescriptions[t.name]));
    return { ...rules, session, turn, fromSeq: exposedAt, phase: initial ? 'initial' : 'after-restart', serviceVersion: contract.version,
      resources: 'available', toolDefinitions: tools ? { known: true, value: tools } : { known: false, reason: 'No matching tools/list response in this native turn' } };
  };
  const result: GivenRules[] = [];
  if (restart === undefined || restart >= fromSeq) result.push(phase(before, fromSeq, true));
  if (restart !== undefined) {
    const fresh = phase(after, Math.max(fromSeq, restart), false);
    // In-process Codex can retain the original instructions and tools even though the service reinitialized.
    // Preserve exactly that exposure until a successful Resource read, rather than claiming a refresh.
    if (!fresh.instructions.known && upgrade.mode === 'process') {
      const retained = phase(before, fresh.fromSeq, false);
      retained.serviceVersion = after.version;
      result.push(retained);
    } else result.push(fresh);
    const read = events.find(e => e.kind === 'resource-read' && e.actor === 'agent' && e.session === session && e.turn === turn
      && e.seq > restart && e.ok && e.uri === 'wayfinder://workflow/exploration');
    const delivered = log.some(e => e.turn === turn && e.phase === 'response' && e.method === 'resources/read' && e.status === 200
      && resourceText(e.body, e.requestId) === currentResource);
    if (read) {
      const exposed = delivered && rollout && shown(channels.outputs, currentResource);
      result.push({ ...result.at(-1)!, fromSeq: read.seq,
        rulesSource: exposed ? { kind: 'resource', uri: 'wayfinder://workflow/exploration', versionLine: `version: ${after.version}` } : { kind: 'unknown', reason: 'Resource reply not corroborated by wire and native output' },
        resourceText: exposed ? { known: true, value: currentResource } : { known: false, reason: 'Successful read recorded, but its current rules text is missing' } });
    }
  }
  return result;
}

export function resourceText(body: string, requestId?: unknown): string | null {
  try {
    const contents = (rpcReply(body, requestId)?.result as { contents?: { uri?: string; text?: string }[] } | undefined)?.contents;
    return contents?.find(c => c.uri === 'wayfinder://workflow/exploration')?.text ?? null;
  } catch { return null; }
}

/** Unanswered HTTP 404 is kept in raw relay evidence, not manufactured into a native write receipt. */
export function captureWrite(upgrade: NonNullable<AttemptRecord['upgrade']>, rpc: RpcRequest, body: string,
  before: unknown, after: unknown, session: string, turn: number) {
  upgrade.writes.push({ session, turn, requestId: String(rpc.id), tool: rpc.params!.name!, arguments: rpc.params!.arguments,
    result: structuredReply(body) ?? null, before, after });
}
