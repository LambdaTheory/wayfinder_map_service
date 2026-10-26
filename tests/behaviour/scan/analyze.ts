import { createHash } from 'node:crypto';
import { blankSession, digest, mergeUsage, nativeHarness, sessionKey } from './read.ts';
import type { Call, CaptureDraft, Fragment, Inputs, Inventory, Lead, LegacyScanState, Manifest, Match, Review, ScanState, Session } from './types.ts';

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const requestHash = (id: string) => createHash('sha256').update(`wayfinder-call-request/1\0${id}`).digest('hex');
const rpcSession = (c: Call) => c.mcpSessionId ?? c.presentedMcpSessionId;

function mergeSessions(input: Session[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const original of input) {
    const s = structuredClone(original);
    const old = byKey.get(s.key);
    if (!old) { byKey.set(s.key, s); continue; }
    for (const field of ['sources', 'skill', 'mcpSessionIds', 'fingerprints', 'usageBasis', 'gaps', 'ambiguities', 'correlationBasis'] as const) {
      if (field === 'ambiguities') old.ambiguities = unique([...old.ambiguities, ...s.ambiguities]);
      else old[field] = unique([...old[field], ...s[field]]);
    }
    old.calls = [...new Map([...old.calls, ...s.calls].map(c => [c.ref, c])).values()];
    old.fragments = [...new Map([...old.fragments, ...s.fragments].map(f => [f.ref + f.role + f.text, f])).values()];
    for (const field of ['model', 'effort'] as const) {
      if (old[field] && s[field] && old[field] !== s[field]) { old.gaps.push(`Conflicting ${field} evidence`); old.ambiguities.push(field); }
      if (old.ambiguities.includes(field)) old[field] = null;
      else old[field] ??= s[field];
    }
    if (old.entry === 'unknown') old.entry = s.entry;
    mergeUsage(old, s.usage);
    if (old.ambiguities.includes('usage')) old.usage = 'unknown';
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

function scanState(input: ScanState | LegacyScanState): ScanState {
  if (!['wayfinder-scan-state/1', 'wayfinder-scan-state/2'].includes(input.schema)
    || !Array.isArray(input.reminded) || input.reminded.some(x => typeof x !== 'string')) throw new Error('Invalid reminder state');
  if (input.schema === 'wayfinder-scan-state/1') return { schema: 'wayfinder-scan-state/2', reminded: input.reminded, seen: [], confirmations: [] };
  if (!Array.isArray(input.seen) || input.seen.some(s => !s.id || !s.evidenceHash || !['pending', 'screened', 'confirmed', 'dismissed'].includes(s.status))
    || !Array.isArray(input.confirmations) || input.confirmations.some(c => c.disposition !== 'confirmed' || !c.leadId || !c.evidenceHash || !Array.isArray(c.quotes))) throw new Error('Invalid scan history');
  return structuredClone(input);
}

/** Only an incident's call/result, preceding human turn and following reply are eligible quotation sources. */
function incidentFragments(session: Session, refs: string[]): Fragment[] {
  const selected = new Set<string>(refs);
  for (const call of session.calls.filter(c => refs.includes(c.ref))) if (call.resultRef) selected.add(call.resultRef);
  const indices = session.fragments.flatMap((f, i) => selected.has(f.ref) ? [i] : []);
  for (const index of indices) {
    if (session.fragments[index]!.role !== 'user') {
      for (let i = index - 1; i >= 0; i--) if (session.fragments[i]!.role === 'user') { selected.add(session.fragments[i]!.ref); break; }
    }
    for (let i = index + 1; i < session.fragments.length; i++) {
      const next = session.fragments[i]!;
      if (next.role === 'user') break;
      if (next.role === 'assistant') { selected.add(next.ref); break; }
    }
  }
  return session.fragments.filter(f => selected.has(f.ref));
}

export function analyze(inputs: Inputs, manifest: Manifest, previous: ScanState | LegacyScanState = { schema: 'wayfinder-scan-state/2', reminded: [], seen: [], confirmations: [] }, reviews: Review[] = []): ScanReport {
  const state = scanState(previous);
  const sessions = mergeSessions(inputs.sessions);
  const gaps = [...inputs.gaps];
  for (const launch of inputs.launches) {
    let candidates = sessions.filter(s => !s.subagent && launch.nativeSessionId !== null && s.nativeId === launch.nativeSessionId && s.harness === launch.harness);
    if (!candidates.length) {
      const key = launch.credentialFingerprint ? `launch:${launch.credentialFingerprint}` : `launch:${digest(launch.ref)}`;
      let placeholder = sessions.find(s => s.key === key);
      if (!placeholder) {
        placeholder = blankSession(key, nativeHarness(launch.harness), launch.nativeSessionId);
        placeholder.gaps.push('Native conversation unavailable; no attribution by Client ID or time');
        sessions.push(placeholder);
      }
      candidates = [placeholder];
    }
    if (candidates.length !== 1) { gaps.push(`${launch.ref}: ambiguous native session`); continue; }
    const s = candidates[0]!;
    s.correlationBasis.push(s.key.startsWith('launch:') ? `${launch.ref}: launch-only row; native conversation unavailable`
      : `${launch.ref}: native session ID ${launch.nativeSessionId} + harness ${launch.harness}`);
    s.sources.push(launch.ref);
    if (launch.credentialFingerprint) s.fingerprints.push(launch.credentialFingerprint);
    if (!s.ambiguities.includes('model')) s.model ??= launch.model;
    if (!s.ambiguities.includes('effort')) s.effort ??= launch.effort;
    if (s.entry === 'unknown') s.entry = launch.entry;
    if (launch.usage !== 'unknown') mergeUsage(s, launch.usage, [`${launch.ref}: operator launch label ${launch.usage}`]);
  }
  for (const label of manifest.labels ?? []) {
    const matches = sessions.filter(s => s.nativeId === label.nativeId && s.harness === label.harness
      && (label.agentId ? s.key === sessionKey(label.harness, label.nativeId, label.agentId) : !s.subagent || s.harness === 'codex'));
    if (matches.length !== 1) { gaps.push(`Usage label for ${label.harness}:${label.nativeId} is unmatched or ambiguous`); continue; }
    const s = matches[0]!;
    mergeUsage(s, label.usage, [`Operator label: ${label.basis}`]);
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
        if (call.credentialFingerprint && s.fingerprints.includes(call.credentialFingerprint)) m.basis.push('B07 call credential fingerprint matches launch fingerprint');
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
    const { fragments: _privateWords, ...facts } = s;
    const item: Inventory = { ...facts, serviceCalls: calls.map(m => m.call.ref), matchingBasis: unique([...s.correlationBasis, ...calls.flatMap(m => m.basis)]),
      gaps: unique([...s.gaps, ...calls.flatMap(m => m.gaps)]), activity: hasMcp ? 'mcp' : s.skill.length ? 'skill-only-observed' : s.nativeId ? 'unrelated' : 'unknown', authorization: 'not-assessed' };
    if (s.usage === 'unknown') item.gaps.push('Usage purpose unknown');
    if (s.subagent && s.usage === 'unknown') item.gaps.push('Subagent evidence alone does not establish research purpose');
    if (!s.model) item.gaps.push('Model unknown');
    if (!s.effort) item.gaps.push('Effort unknown');
    if (item.activity === 'skill-only-observed') item.gaps.push('No MCP call observed in supplied evidence; absence is not proof of complete logs');
    return item;
  });
  const leads: Lead[] = [];
  const acceptedReviews: Review[] = [];
  for (const s of inventory) {
    const service = matches.filter(m => m.session === s.key && (m.call.tool || m.call.result === 'unauthenticated'));
    const signals = new Map<Lead['kind'], string[]>();
    const add = (kind: Lead['kind'], ref: string) => signals.set(kind, [...signals.get(kind) ?? [], ref]);
    const signal = (tool: string | null, result: string | null, ref: string) => {
      if (result === 'conflict') add('conflict', ref);
      else if (result && ['unauthenticated', 'input-error', 'command-rejected', 'version-mismatch', 'map-exists', 'not-found'].includes(result)) add('refusal', ref);
      else if (result === 'service-failure' || result === 'transport-failure') add('failure', ref);
      else if (tool === 'map_apply' || tool === 'map_create') add('write', ref);
    };
    service.forEach(m => signal(m.call.tool, m.call.result, m.call.ref));
    s.calls.forEach(c => signal(c.tool, c.result, c.ref));
    if (s.activity === 'skill-only-observed') add('skill-only', s.skill[0]!);
    if (s.gaps.length && s.activity !== 'unrelated') add('missing-evidence', s.key);
    for (const [kind, refs] of signals) {
      const id = `lead-${digest([s.key, kind]).slice(0,24)}`;
      const fragments = kind === 'missing-evidence' ? [] : incidentFragments(sessions.find(x => x.key === s.key)!, refs);
      const evidenceHash = digest({ fragments, calls: s.calls.filter(c => refs.includes(c.ref)), service: service.filter(m => refs.includes(m.call.ref)).map(m => m.call),
        ...(kind === 'missing-evidence' ? { gaps: s.gaps } : {}) });
      const lead: Lead = { id, session: s.key, kind, refs: unique(refs), evidenceHash, fragments: [], change: 'new',
        evidenceRefs: fragments.map(({ ref, role }) => ({ ref, role })), hasHumanWords: fragments.some(f => f.role === 'user'),
        status: 'pending', reason: 'Screening candidate only; metadata and missing evidence do not establish a behaviour violation', requestHumanWords: false, reminder: false };
      const decisions = reviews.filter(r => r.leadId === id);
      const quotedFragment = (q: Review['quotes'][number]) => typeof q.quote === 'string' && q.quote.trim()
        ? fragments.find(f => f.ref === q.ref && f.text.includes(q.quote)) : undefined;
      if (decisions.length > 1) gaps.push(`${id}: multiple review decisions; reconcile explicitly`);
      else if (decisions.length === 1) {
        const review = decisions[0]!;
        const quotes = Array.isArray(review.quotes) ? review.quotes : [];
        const quoted = quotes.map(quotedFragment);
        const exact = quoted.length > 0 && quoted.every(f => f !== undefined);
        const human = quoted.some(f => f?.role === 'user');
        const action = quoted.some(f => f !== undefined && f.role !== 'user');
        if (review.evidenceHash !== evidenceHash || !review.by?.trim() || !review.reason?.trim() || !review.basis?.trim()) gaps.push(`${id}: stale or incomplete review`);
        else if (review.disposition === 'confirmed' || review.disposition === 'dismissed') {
          if (kind === 'missing-evidence' || !exact || !human || !action) gaps.push(`${id}: verdict needs original human words and native action evidence; remains pending`);
          else { lead.status = review.disposition; lead.reason = review.reason; acceptedReviews.push(review); }
        } else if (review.disposition === 'screened' || review.disposition === 'needs-human-words') {
          if (quotes.length && !exact) { gaps.push(`${id}: screening quotes are outside incident evidence`); }
          else { lead.status = kind === 'missing-evidence' ? 'pending' : 'screened'; lead.reason = review.reason; acceptedReviews.push(review); }
          // Explicit post-screening verdict need only. Never ask on every ChatGPT write.
          lead.requestHumanWords = lead.status === 'screened' && review.disposition === 'needs-human-words' && !lead.hasHumanWords;
        } else gaps.push(`${id}: unsupported review disposition`);
      }
      const accepted = acceptedReviews.find(r => r.leadId === id);
      // Export only explicitly selected exact excerpts, never the incident window or a whole conversation.
      if (accepted) lead.fragments = accepted.quotes.map(q => ({ ref: q.ref, role: quotedFragment(q)!.role, text: q.quote }));
      const confirmation = accepted?.disposition === 'confirmed' ? accepted : state.confirmations.find(c => c.leadId === id);
      if (confirmation) {
        lead.confirmation = confirmation; lead.status = 'confirmed'; lead.reason = confirmation.reason;
        if (confirmation.evidenceHash !== evidenceHash) gaps.push(`${id}: earlier confirmation retained; current evidence differs`);
      }
      const seen = state.seen.find(x => x.id === id);
      if (!decisions.length && !confirmation && seen?.evidenceHash === evidenceHash && (seen.status === 'screened' || seen.status === 'dismissed')) {
        lead.status = seen.status; lead.reason = 'Retained disposition at the same evidence hash; see the prior scan review';
        lead.requestHumanWords = seen.requestHumanWords ?? false;
      }
      lead.change = !seen ? 'new' : seen.evidenceHash === evidenceHash && seen.status === lead.status ? 'seen' : 'changed';
      lead.reminder = (lead.status === 'confirmed' || lead.status === 'screened') && !state.reminded.includes(id);
      leads.push(lead);
    }
  }
  for (const review of reviews) if (!leads.some(l => l.id === review.leadId)) gaps.push(`${review.leadId}: review has no current lead`);
  const confirmations = [...new Map([...state.confirmations, ...acceptedReviews.filter(r => r.disposition === 'confirmed')].map(r => [r.leadId, r])).values()];
  const nextState: ScanState = { schema: 'wayfinder-scan-state/2', reminded: unique([...state.reminded, ...leads.filter(l => l.reminder).map(l => l.id)]), confirmations,
    seen: [...new Map([...state.seen, ...leads.map(l => ({ id: l.id, evidenceHash: l.evidenceHash, status: l.status, requestHumanWords: l.requestHumanWords }))].map(s => [s.id, s])).values()] };
  return { schema: 'wayfinder-usage-scan/1', sources: inputs.sources, gaps: unique(gaps), inventory, matches, leads, reviews: structuredClone(acceptedReviews),
    captureDrafts: leads.filter(l => l.kind !== 'missing-evidence' && (l.status === 'screened' || l.status === 'confirmed') && l.change !== 'seen')
      .map(l => captureDraft(l, inventory.find(s => s.key === l.session)!, matches)),
    summary: { sessions: inventory.length, serviceCalls: matches.length, pending: leads.filter(l => l.status === 'pending').length,
      confirmed: confirmations.length, newFailures: confirmations.filter(c => !state.confirmations.some(old => old.leadId === c.leadId)).length,
      reminders: leads.filter(l => l.reminder).length, modelsStarted: 0 }, state: nextState };
}

function captureDraft(lead: Lead, session: Inventory, matches: Match[]): CaptureDraft {
  const mapIds = unique([...session.calls.map(c => c.mapId), ...matches.filter(m => m.session === session.key).map(m => m.call.mapId)].filter((m): m is string => m !== null));
  return { schema: 'wayfinder-capture-input-draft/1', leadId: lead.id, ready: false,
    humanQuoteRefs: unique([...(lead.confirmation?.quotes.filter(q => lead.evidenceRefs.some(f => f.role === 'user' && f.ref === q.ref)).map(q => q.ref) ?? []), ...lead.fragments.filter(f => f.role === 'user').map(f => f.ref)]),
    input: { id: `Scan${lead.id.slice(5)}`, title: `Review ${lead.kind} signal`, origin: `Usage scan ${lead.id}; ${lead.status}`, date: '',
      mapId: mapIds.length === 1 ? mapIds[0]! : '', revision: null, restores: null, claims: null,
      sessionRef: session.key, humanWords: null, replayContext: '', originalCombination: `${session.harness}:${session.model ?? 'unknown'}`,
      originalConditions: { entry: session.entry, effort: session.effort ?? 'unknown' }, applies: { entries: ['mcp-only', 'dedicated', 'chatgpt'], needs: [] },
      purpose: '', redactions: [], verdict: null, reproductions: [] },
    missing: ['Select the incident and its exact human turn from the private fragments', 'Incident date and accepted correct behaviour',
      'Verified pre-incident Map and Revision from a consistent private database copy', 'Purpose, restoration mode and every Claim choice',
      'Literal redactions and review of all B04 outputs', 'Two reproductions on the original Combination require a separate approved Batch'] };
}
