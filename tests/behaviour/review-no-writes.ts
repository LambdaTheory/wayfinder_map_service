// Derived evidence, not another model reading: reconstruct the complete catalog at each recorded turn boundary.
import { agentRevisions, writeCalls } from './checks.ts';
import { classifyResult } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';

export interface TurnWriteEvidence {
  session: string;
  turn: number;
  heads: { mapId: string; before: number | null; after: number | null }[];
  committedReceipts: number[];
  statement: string;
}

/** Null cells are deliberately unavailable for citation. The indices match sessions[i].turns[j].
 * Turn indices are Scenario-wide, not session-local. Receipts place writes; timestamps never assign one.
 * Ambiguous concurrent ordering, unknown receipts and incomplete histories cannot prove unchanged heads.
 */
export function turnWriteEvidence(a: AttemptRecord): (TurnWriteEvidence | null)[][] {
  const unavailable = () => a.sessions.map(s => s.turns.map(() => null));
  const turns = a.sessions.flatMap(s => s.turns.map(t => ({ ...t, session: s.label }))).sort((x, y) => x.index - y.index);
  const recorded = (session: string, turn: number) => turns.some(t => t.session === session && t.index === turn);
  if (a.missing.some(p => /^(maps|receipts|sessions)(?:\[|\.|$)/.test(p))
    || new Set(turns.map(t => t.index)).size !== turns.length
    || turns.some(t => !Number.isSafeInteger(t.index) || t.index < 0)
    || new Set(a.maps.map(m => m.mapId)).size !== a.maps.length
    || a.receipts.some(r => r.outcome.kind === 'unknown' || !recorded(r.session, r.turn))) return unavailable();
  // Separate sessions need explicit non-overlapping boundaries before a Scenario-wide head order is usable.
  if (new Set(turns.map(t => t.session)).size > 1 && turns.some((t, i) => {
    const start = Date.parse(t.startedAt); const end = Date.parse(t.endedAt);
    return !Number.isFinite(start) || !Number.isFinite(end) || end < start || i > 0 && Date.parse(turns[i - 1]!.endedAt) > start;
  })) return unavailable();
  const calls = writeCalls(a);
  if (calls.some(e => {
    const matching = a.receipts.filter(r => r.callId === e.callId && r.session === e.session && r.turn === e.turn);
    const r = matching[0];
    if (!e.result.known || matching.length !== 1 || !r || r.outcome.kind === 'unknown') return true;
    const cls = classifyResult(e.result.value, e.failed);
    if (r.outcome.kind === 'not-written') return cls === 'committed' || r.outcome.because !== cls;
    if (cls !== 'committed') return true;
    const value = e.result.value as { mapId?: string; revision?: number | { mapId: string; revision: number } };
    const revision = typeof value.revision === 'number' ? value.revision : value.revision?.revision;
    const mapId = value.mapId ?? (typeof value.revision === 'object' ? value.revision.mapId : undefined)
      ?? (e.arguments as { mapId?: string } | null)?.mapId;
    return revision !== r.outcome.revision || mapId !== r.mapId;
  })
    || a.receipts.some(r => !calls.some(e => e.callId === r.callId && e.session === r.session && e.turn === r.turn && e.tool === r.tool))) return unavailable();
  const revisions = agentRevisions(a);
  if (revisions.some(r => r.session === null || r.turn === null || !recorded(r.session, r.turn)
    || !a.sessions.some(s => s.label === r.session && s.clientId === r.rev.author.clientId))) return unavailable();
  const committed = a.receipts.flatMap(r => r.outcome.kind === 'committed' ? [{ receipt: r, revision: r.outcome.revision }] : []);
  const key = (map: string | null, revision: number) => JSON.stringify([map, revision]);
  const keys = committed.map(({ receipt: r, revision }) => key(r.mapId, revision));
  if (new Set(keys).size !== keys.length || committed.some(({ receipt: r, revision }) =>
    !revisions.some(v => v.map === r.mapId && v.rev.revision === revision && v.session === r.session && v.turn === r.turn))) return unavailable();

  const timelines: { mapId: string; seed: number | null; writes: { revision: number; turn: number }[] }[] = [];
  for (const m of a.maps) {
    const seed = m.seedHeadRevision;
    if (!m.history.length || seed !== null && (!Number.isSafeInteger(seed) || seed < 1 || !m.history.some(r => r.revision === seed))
      || m.history.some((r, i) => r.mapId !== m.mapId || r.state.id !== m.mapId || r.state.currentRevision !== r.revision
        || !Number.isSafeInteger(r.revision) || r.revision < 1 || i > 0 && r.revision <= m.history[i - 1]!.revision)) return unavailable();
    let previous = seed; let previousTurn = -1;
    const writes: { revision: number; turn: number }[] = [];
    for (const r of m.history.filter(r => seed === null || r.revision > seed)) {
      const placed = revisions.find(v => v.map === m.mapId && v.rev.revision === r.revision);
      // Post-seed Controller changes have no agent receipt placing them at a turn boundary; do not guess.
      if (!placed || placed.turn === null || r.priorRevision !== previous || r.revision !== (previous ?? 0) + 1
        || placed.turn < previousTurn) return unavailable();
      writes.push({ revision: r.revision, turn: placed.turn });
      previous = r.revision; previousTurn = placed.turn;
    }
    timelines.push({ mapId: m.mapId, seed, writes });
  }
  return a.sessions.map(s => s.turns.map(t => {
    const committedReceipts = a.receipts.flatMap((r, i) => r.session === s.label && r.turn === t.index && r.outcome.kind === 'committed' ? [i] : []);
    const heads = timelines.map(m => ({ mapId: m.mapId,
      before: m.writes.findLast(w => w.turn < t.index)?.revision ?? m.seed,
      after: m.writes.findLast(w => w.turn <= t.index)?.revision ?? m.seed }));
    if (committedReceipts.length || heads.some(h => h.before !== h.after)) return null;
    return { session: s.label, turn: t.index, heads, committedReceipts,
      statement: `No agent writes in session ${s.label} turn ${t.index}; committed receipts: []; catalog heads (before -> after): ${JSON.stringify(heads)}.` };
  }));
}
