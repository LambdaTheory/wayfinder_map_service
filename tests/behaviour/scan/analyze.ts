import { createHash } from 'node:crypto';
import { blankSession, digest } from './read.ts';
import type { Call, CaptureDraft, Inputs, Inventory, Lead, Manifest, Match, Review, ScanState, Session } from './types.ts';

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const requestHash = (id: string) => createHash('sha256').update(`wayfinder-call-request/1\0${id}`).digest('hex');
const rpcSession = (c: Call) => c.mcpSessionId ?? c.presentedMcpSessionId;

function mergeSessions(input: Session[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const original of input) {
    const s = structuredClone(original);
    const old = byKey.get(s.key);
    if (!old) { byKey.set(s.key, s); continue; }
    for (const field of ['sources', 'skill', 'mcpSessionIds', 'fingerprints', 'usageBasis', 'gaps'] as const) old[field] = unique([...old[field], ...s[field]]);
    old.calls = [...new Map([...old.calls, ...s.calls].map(c => [c.ref, c])).values()];
    old.fragments = [...new Map([...old.fragments, ...s.fragments].map(f => [f.ref + f.role + f.text, f])).values()];
    for (const field of ['model', 'effort'] as const) {
      if (old[field] && s[field] && old[field] !== s[field]) { old.gaps.push(`Conflicting ${field} evidence`); old[field] = null; }
      else if (!old.gaps.some(g => g.includes(`${field} evidence`) || g.startsWith(`Multiple ${field}`))) old[field] ??= s[field];
    }
    if (old.entry === 'unknown') old.entry = s.entry;
    if (old.usage === 'unknown') old.usage = s.usage;
    else if (s.usage !== 'unknown' && old.usage !== s.usage) { old.usage = 'unknown'; old.gaps.push('Conflicting usage evidence'); }
  }
  return [...byKey.values()];
}

export interface ScanReport {
  schema: 'wayfinder-usage-scan/1'; sources: Inputs['sources']; gaps: string[];
  inventory: Inventory[]; matches: Match[]; leads: Lead[]; captureDrafts: CaptureDraft[];
  reviews: Review[];
  summary: { sessions: number; serviceCalls: number; pending: number; confirmed: number; newFailures: number; reminders: number; modelsStarted: 0 };
  state: ScanState;
}

export function analyze(inputs: Inputs, manifest: Manifest, state: ScanState = { schema: 'wayfinder-scan-state/1', reminded: [] }, reviews: Review[] = []): ScanReport {
  if (state.schema !== 'wayfinder-scan-state/1' || !Array.isArray(state.reminded) || state.reminded.some(x => typeof x !== 'string')) throw new Error('Invalid reminder state');
  const sessions = mergeSessions(inputs.sessions);
  const gaps = [...inputs.gaps];
  for (const launch of inputs.launches) {
    let candidates = sessions.filter(s => !s.subagent && launch.nativeSessionId !== null && s.nativeId === launch.nativeSessionId && s.harness === launch.harness);
    if (!candidates.length) {
      const key = launch.credentialFingerprint ? `launch:${launch.credentialFingerprint}` : `launch:${digest(launch.ref)}`;
      let placeholder = sessions.find(s => s.key === key);
      if (!placeholder) {
        placeholder = blankSession(key, launch.harness === 'codex' || launch.harness === 'claude' || launch.harness === 'chatgpt' ? launch.harness : 'unknown', launch.nativeSessionId);
        placeholder.gaps.push('Native conversation unavailable; no attribution by Client ID or time');
        sessions.push(placeholder);
      }
      candidates = [placeholder];
    }
    if (candidates.length !== 1) { gaps.push(`${launch.ref}: ambiguous native session`); continue; }
    const s = candidates[0]!;
    s.sources.push(launch.ref);
    if (launch.credentialFingerprint) s.fingerprints.push(launch.credentialFingerprint);
    if (!s.gaps.some(g => g.includes('model evidence') || g.startsWith('Multiple model'))) s.model ??= launch.model;
    if (!s.gaps.some(g => g.includes('effort evidence') || g.startsWith('Multiple effort'))) s.effort ??= launch.effort;
    if (s.entry === 'unknown') s.entry = launch.entry;
    if (launch.usage !== 'unknown') {
      s.usageBasis.push(`${launch.ref}: operator launch label ${launch.usage}`);
      if (s.usage === 'unknown' && !s.gaps.includes('Conflicting usage evidence')) s.usage = launch.usage;
      else if (s.usage !== launch.usage) { s.usage = 'unknown'; s.gaps.push('Conflicting usage evidence'); }
    }
  }
  for (const label of manifest.labels ?? []) {
    const matches = sessions.filter(s => s.nativeId === label.nativeId && s.harness === label.harness
      && (label.agentId ? s.key === `${label.harness}:${label.nativeId}/subagent/${label.agentId}` : !s.subagent || s.harness === 'codex'));
    if (matches.length !== 1) { gaps.push(`Usage label for ${label.harness}:${label.nativeId} is unmatched or ambiguous`); continue; }
    const s = matches[0]!;
    s.usageBasis.push(`Operator label: ${label.basis}`);
    s.gaps = s.gaps.filter(g => g !== 'Subagent evidence alone does not establish research purpose');
    if (s.usage !== 'unknown' && s.usage !== label.usage || s.gaps.includes('Conflicting usage evidence')) {
      s.usage = 'unknown'; s.gaps.push('Conflicting usage evidence');
    } else s.usage = label.usage;
  }
  const matches: Match[] = [];
  const observations = new Map<string, Call>();
  for (const call of inputs.calls) {
    // Copies of an archived log are one observation; divergent copies are a gap.
    const observation = `${call.serviceStartedAt}/${call.sequence}`;
    const previous = observations.get(observation);
    if (previous) {
      const { ref: _a, ...a } = previous; const { ref: _b, ...b } = call;
      if (digest(a) !== digest(b)) gaps.push(`${call.ref}: conflicting duplicate service observation`);
      continue;
    }
    observations.set(observation, call);
    const id = rpcSession(call);
    const candidates = sessions.filter(s => id !== null && s.mcpSessionIds.includes(id)
      || call.credentialFingerprint !== null && s.fingerprints.includes(call.credentialFingerprint));
    const m: Match = { call, session: null, basis: [], nativeCall: null, gaps: [] };
    if (candidates.length === 1) {
      const s = candidates[0]!;
      if (call.credentialFingerprint && s.fingerprints.length && !s.fingerprints.includes(call.credentialFingerprint)) {
        m.gaps.push('MCP session and credential fingerprint disagree');
      } else {
        m.session = s.key;
        if (id && s.mcpSessionIds.includes(id)) m.basis.push(`MCP session ${id} from Attempt`);
        if (call.credentialFingerprint && s.fingerprints.includes(call.credentialFingerprint)) m.basis.push('Launch credential fingerprint; exact native session ID when available');
        // B01 normalizes request IDs to strings and loses the numeric/string distinction. Require a unique observation.
        const sameRequest = (other: Call) => rpcSession(other) === id && other.requestId === call.requestId && other.requestIdHash === call.requestIdHash;
        const native = s.calls.filter(c => c.requestId !== null && c.tool === call.tool && s.mcpSessionIds.length === 1 && s.mcpSessionIds[0] === id
          && (call.requestId === c.requestId || call.requestIdHash === requestHash(c.requestId)));
        if (native.length === 1 && inputs.calls.filter(sameRequest).length === 1) {
          m.nativeCall = native[0]!.ref; m.basis.push('MCP session + unique JSON-RPC request ID/hash');
        } else if (call.tool) m.gaps.push('No unique native request match; session correlation is not a commit receipt');
      }
    } else m.gaps.push(candidates.length ? 'Ambiguous session/fingerprint join' : 'No native/launch/Attempt bridge');
    if (!m.session) {
      const key = `service:${id ?? call.credentialFingerprint ?? observation}`;
      let s = sessions.find(x => x.key === key);
      if (!s) { s = blankSession(key, 'unknown', null); s.gaps.push('Native conversation unavailable'); sessions.push(s); }
      // An unmatched service group is an inventory row, not an assertion about any native session.
      m.session = s.key;
    }
    matches.push(m);
  }
  const inventory: Inventory[] = sessions.map(s => {
    const calls = matches.filter(m => m.session === s.key);
    const hasMcp = s.calls.length > 0 || calls.some(m => m.call.tool !== null);
    const item: Inventory = { ...s, serviceCalls: calls.map(m => m.call.ref), matchingBasis: unique(calls.flatMap(m => m.basis)),
      gaps: unique([...s.gaps, ...calls.flatMap(m => m.gaps)]), activity: hasMcp ? 'mcp' : s.skill.length ? 'skill-only-observed' : s.nativeId ? 'unrelated' : 'unknown', authorization: 'not-assessed' };
    if (s.usage === 'unknown') item.gaps.push('Usage purpose unknown');
    if (!s.model) item.gaps.push('Model unknown');
    if (!s.effort) item.gaps.push('Effort unknown');
    if (item.activity === 'skill-only-observed') item.gaps.push('No MCP call observed in supplied evidence; absence is not proof of complete logs');
    return item;
  });
  const leads: Lead[] = [];
  for (const s of inventory) {
    const service = matches.filter(m => m.session === s.key && m.call.tool);
    const signals = new Map<Lead['kind'], string[]>();
    const add = (kind: Lead['kind'], ref: string) => signals.set(kind, [...signals.get(kind) ?? [], ref]);
    const signal = (tool: string | null, result: string | null, ref: string) => {
      if (result === 'conflict') add('conflict', ref);
      else if (result && ['input-error', 'command-rejected', 'version-mismatch', 'map-exists', 'not-found'].includes(result)) add('refusal', ref);
      else if (result === 'service-failure' || result === 'transport-failure') add('failure', ref);
      else if (tool === 'map_apply' || tool === 'map_create') add('write', ref);
    };
    service.forEach(m => signal(m.call.tool, m.call.result, m.call.ref));
    s.calls.forEach(c => signal(c.tool, c.result, c.ref));
    if (s.activity === 'skill-only-observed') add('skill-only', s.skill[0]!);
    if (s.gaps.length && s.activity !== 'unrelated') add('missing-evidence', s.key);
    for (const [kind, refs] of signals) {
      const id = `lead-${digest([s.key, kind]).slice(0,24)}`;
      const fragments = s.fragments;
      const evidenceHash = digest({ fragments, calls: s.calls, service: service.map(m => m.call), gaps: s.gaps });
      const lead: Lead = { id, session: s.key, kind, refs: unique(refs), evidenceHash, fragments,
        status: 'pending', reason: 'Screening candidate only; metadata and missing evidence do not establish a behaviour violation', requestHumanWords: false, reminder: false };
      const decisions = reviews.filter(r => r.leadId === id);
      if (decisions.length > 1) gaps.push(`${id}: multiple review decisions; reconcile explicitly`);
      else if (decisions.length === 1) {
        const review = decisions[0]!;
        const quotes = Array.isArray(review.quotes) ? review.quotes : [];
        const exact = quotes.length > 0 && quotes.every(q => typeof q.quote === 'string' && q.quote.trim() && fragments.some(f => f.ref === q.ref && f.text.includes(q.quote)));
        const human = quotes.some(q => fragments.some(f => f.role === 'user' && f.ref === q.ref && f.text.includes(q.quote)));
        const action = quotes.some(q => fragments.some(f => f.role !== 'user' && f.ref === q.ref && f.text.includes(q.quote)));
        if (review.evidenceHash !== evidenceHash || !review.by?.trim() || !review.reason?.trim() || !review.basis?.trim()) gaps.push(`${id}: stale or incomplete review`);
        else if (review.disposition === 'confirmed' || review.disposition === 'dismissed') {
          if (kind === 'missing-evidence' || !exact || !human || !action) gaps.push(`${id}: verdict needs original human words and native action evidence; remains pending`);
          else { lead.status = review.disposition; lead.reason = review.reason; }
        } else if (review.disposition === 'screened' || review.disposition === 'needs-human-words') {
          lead.status = kind === 'missing-evidence' ? 'pending' : 'screened'; lead.reason = review.reason;
          // Explicit post-screening verdict need only. Never ask on every ChatGPT write.
          lead.requestHumanWords = review.disposition === 'needs-human-words' && !fragments.some(f => f.role === 'user');
        } else gaps.push(`${id}: unsupported review disposition`);
      }
      lead.reminder = (lead.status === 'confirmed' || lead.status === 'screened') && !state.reminded.includes(id);
      leads.push(lead);
    }
  }
  for (const review of reviews) if (!leads.some(l => l.id === review.leadId)) gaps.push(`${review.leadId}: review has no current lead`);
  const nextState: ScanState = { schema: 'wayfinder-scan-state/1', reminded: unique([...state.reminded, ...leads.filter(l => l.reminder).map(l => l.id)]) };
  return { schema: 'wayfinder-usage-scan/1', sources: inputs.sources, gaps: unique(gaps), inventory, matches, leads, reviews: structuredClone(reviews),
    captureDrafts: leads.filter(l => l.kind !== 'missing-evidence' && l.status !== 'dismissed').map(l => captureDraft(l, inventory.find(s => s.key === l.session)!, matches)),
    summary: { sessions: inventory.length, serviceCalls: matches.length, pending: leads.filter(l => l.status === 'pending').length,
      confirmed: leads.filter(l => l.status === 'confirmed').length, newFailures: leads.filter(l => l.status === 'confirmed' && l.reminder).length,
      reminders: leads.filter(l => l.reminder).length, modelsStarted: 0 }, state: nextState };
}

function captureDraft(lead: Lead, session: Inventory, matches: Match[]): CaptureDraft {
  const mapIds = unique([...session.calls.map(c => c.mapId), ...matches.filter(m => m.session === session.key).map(m => m.call.mapId)].filter((m): m is string => m !== null));
  return { schema: 'wayfinder-capture-input-draft/1', leadId: lead.id, ready: false,
    input: { id: `Scan${lead.id.slice(5)}`, title: `Review ${lead.kind} signal`, origin: `Usage scan ${lead.id}; ${lead.status}`, date: '',
      mapId: mapIds.length === 1 ? mapIds[0]! : '', revision: null, restores: null, claims: null,
      sessionRef: session.key, humanWords: null, replayContext: '', originalCombination: `${session.harness}:${session.model ?? 'unknown'}`,
      originalConditions: { entry: session.entry, effort: session.effort ?? 'unknown' }, applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
      purpose: '', redactions: [], verdict: null, reproductions: [] },
    missing: ['Select the incident and its exact human turn from the private fragments', 'Incident date and accepted correct behaviour',
      'Verified pre-incident Map and Revision from a consistent private database copy', 'Purpose, restoration mode and every Claim choice',
      'Literal redactions and review of all B04 outputs', 'Two reproductions on the original Combination require a separate approved Batch'] };
}
