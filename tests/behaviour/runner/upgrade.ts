// Upgrade-only observation. The Controller never fills a version, reads rules for the agent or repairs a write.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { canaryContract } from '../../helpers/canary-release.mjs';
import type { CanaryContract } from '../../helpers/canary-release.mjs';
import type { AttemptRecord, EventRecord, GivenRules } from '../evidence.ts';
import type { RolloutFacts } from './normalize.ts';
import { initialRules, shown } from './normalize.ts';
import type { RelayObservation, RpcRequest } from './relay.ts';
import { structuredReply, rpcReply } from './relay.ts';
import { checkoutRoot } from './service.ts';
import { upgradeAnchors } from './upgrade-position.ts';

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
  const channels = { outputs: '' };
  const discoveries: { fromSeq: number; instructions: string; tools: string }[] = [];
  const nativeEvents = events.filter(e => e.actor === 'agent' && e.session === session && e.turn === turn);
  let nextSeq = fromSeq;
  let positioned = true;
  let unpositionedDiscovery = false;
  let unpositionedFromSeq = Infinity;
  const lines = rollout?.text.split('\n') ?? [];
  const anchors = upgradeAnchors(lines, nativeEvents);
  const relevant = nativeEvents.filter(e => e.kind === 'tool-call' || (e.kind === 'message' && e.role === 'assistant'));
  const place = (match: EventRecord | undefined) => {
    positioned = !!match;
    if (match) {
      nextSeq = Math.max(nextSeq, match.seq + 1);
      // Resource reads have a derived event immediately after the native tool call.
      if (nativeEvents.some(event => event.seq === nextSeq && event.kind === 'resource-read')) nextSeq++;
    }
  };
  const discover = (line: number, instructions: string, tools: string) => {
    if (![before, after].some(c => shown(instructions, c.instructions)
      || Object.values(c.toolDescriptions).some(text => shown(tools, text)))) return;
    // Missing Events between the surrounding anchors leave more than one legal
    // exposure boundary. Neither the earliest nor the latest is evidence.
    const following = [...anchors].find(([n, event]) => n > line && (!event || event.seq >= nextSeq));
    const skipped = relevant.some(e => e.seq >= nextSeq && e.seq < (following?.[1]?.seq ?? Infinity));
    if (!positioned || skipped || (following && !following[1])) {
      unpositionedDiscovery = true;
      unpositionedFromSeq = Math.min(unpositionedFromSeq, nextSeq);
      return;
    }
    const previous = discoveries.at(-1);
    discoveries.push({ fromSeq: nextSeq, instructions: (previous?.instructions ?? '') + instructions,
      tools: (previous?.tools ?? '') + tools });
  };
  for (const [lineNumber, line] of lines.entries()) {
    try {
      const e = JSON.parse(line);
      const p = e.payload;
      if (anchors.has(lineNumber)) place(anchors.get(lineNumber));
      if (e.type !== 'response_item' || !p) continue;
      if (p.type === 'message' && p.role === 'developer') discover(lineNumber, line + '\n', '');
      if (p.type === 'additional_tools') discover(lineNumber, '', line + '\n');
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
            if (descriptions.length) {
              discover(lineNumber, JSON.stringify(descriptions) + '\n', JSON.stringify(descriptions) + '\n');
            }
          } catch { /* Non-JSON exec output does not expose tool definitions. */ }
        }
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || (p.type === 'message' && p.role === 'tool')) channels.outputs += line + '\n';
    } catch { /* Missing native channel remains unknown. */ }
  }
  const phase = (contract: typeof before, seq: number, initial: boolean): GivenRules => {
    const instructionDiscovery = discoveries.find(d => d.fromSeq <= seq && shown(d.instructions, contract.instructions));
    const toolDiscovery = discoveries.find(d => d.fromSeq <= seq && Object.values(contract.toolDescriptions).every(text => shown(d.tools, text)));
    const rules = initialRules(contract.version, contract.instructions, contract.toolDescriptions,
      rollout && { ...rollout, text: instructionDiscovery?.instructions ?? '' });
    rules.toolDescriptions = rollout && toolDiscovery
      ? { known: true, value: contract.toolDescriptions } : { known: false, reason: 'tool descriptions not found in native additional_tools or code-mode discovery' };
    if (seq >= unpositionedFromSeq) {
      const reason = 'unpositioned Wayfinder discovery: its first exposure cannot be established from native Events';
      if (!rules.instructions.known) rules.instructions = { known: false, reason };
      if (!rules.toolDescriptions.known) rules.toolDescriptions = { known: false, reason };
    }
    const tools = log.flatMap(e => {
      if (e.turn !== turn || e.phase !== 'response' || e.method !== 'tools/list' || e.status !== 200) return [];
      try { const list = (rpcReply(e.body, e.requestId)?.result as { tools?: unknown[] } | undefined)?.tools; return Array.isArray(list) ? [list] : []; } catch { return []; }
    }).find(list => list.every(t => t !== null && typeof t === 'object' && 'name' in t && typeof t.name === 'string'
      && 'description' in t && t.description === contract.toolDescriptions[t.name]));
    return { ...rules, session, turn, fromSeq: seq, phase: initial ? 'initial' : 'after-restart', serviceVersion: contract.version,
      resources: 'available', toolDefinitions: tools ? { known: true, value: tools } : { known: false, reason: 'No matching tools/list response in this native turn' } };
  };
  const phases = (contract: typeof before, seq: number, initial: boolean): GivenRules[] => {
    // Instructions can be visible in the first batch before the complete tool set arrives.
    // Emit each knowledge change instead of delaying both channels to the last discovery.
    const instructionSeq = discoveries.find(d => shown(d.instructions, contract.instructions))?.fromSeq;
    const toolSeq = discoveries.find(d => Object.values(contract.toolDescriptions).every(text => shown(d.tools, text)))?.fromSeq;
    const boundaries = [...new Set([instructionSeq, toolSeq].filter((n): n is number => n !== undefined).map(n => Math.max(seq, n)))];
    // Later proven exposure is useful, but cannot erase an earlier interval whose
    // start is unknown. That interval remains a separate phase with its reason.
    if (unpositionedDiscovery && (!initial || restart === undefined || unpositionedFromSeq < restart))
      boundaries.push(Math.max(seq, unpositionedFromSeq));
    return (boundaries.length ? [...new Set(boundaries)].sort((a, b) => a - b) : [seq]).map(n => phase(contract, n, initial));
  };
  const result: GivenRules[] = [];
  if (restart === undefined || restart >= fromSeq) result.push(...phases(before, fromSeq, true));
  if (restart !== undefined) {
    const fresh = phases(after, Math.max(fromSeq, restart), false);
    // In-process Codex can retain the original instructions and tools even though the service reinitialized.
    // Preserve exactly that exposure until a successful Resource read, rather than claiming a refresh.
    if (!unpositionedDiscovery && !fresh.some(g => g.instructions.known) && upgrade.mode === 'process') {
      result.push(...phases(before, Math.max(fromSeq, restart), false).map(g => ({ ...g, serviceVersion: after.version })));
    } else result.push(...fresh);
    const reads = events.filter(e => e.kind === 'resource-read' && e.actor === 'agent' && e.session === session && e.turn === turn
      && e.seq > restart && e.ok && e.uri === 'wayfinder://workflow/exploration');
    for (const read of reads) {
      // A later read's wire/native text cannot locate an earlier Resource exposure.
      // The normalizer derives each Resource Event immediately from its own call.
      const call = nativeEvents.find(e => e.seq === read.seq - 1 && e.kind === 'tool-call' && !e.failed
        && e.server === 'wayfinder' && ['read_mcp_resource', 'read_resource', 'resources/read'].includes(e.tool));
      const native = call?.kind === 'tool-call' && call.result.known
        && resourceText(JSON.stringify({ jsonrpc: '2.0', id: 0, result: call.result.value }), 0) === currentResource;
      const delivered = log.some(e => e.turn === turn && e.phase === 'response' && e.method === 'resources/read' && e.status === 200
        && (call?.kind !== 'tool-call' || !call.requestId.known || String(e.requestId) === call.requestId.value)
        && resourceText(e.body, e.requestId) === currentResource);
      const exposed = native && delivered && rollout && shown(channels.outputs, currentResource);
      const current = phase(after, read.seq, false);
      const atRead = !unpositionedDiscovery && !current.instructions.known && upgrade.mode === 'process'
        ? { ...phase(before, read.seq, false), serviceVersion: after.version } : current;
      result.push({ ...atRead,
        rulesSource: exposed ? { kind: 'resource', uri: 'wayfinder://workflow/exploration', versionLine: `version: ${after.version}` } : { kind: 'unknown', reason: 'Resource reply not corroborated by wire and native output' },
        resourceText: exposed ? { known: true, value: currentResource } : { known: false,
          reason: 'unpositioned Resource exposure: this read lacks corroborated current native contents' } });
    }
  }
  return result.sort((a, b) => a.fromSeq - b.fromSeq);
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
