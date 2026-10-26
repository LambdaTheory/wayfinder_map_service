import { CaptureError } from './errors.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Revision } from '../../../src/types.ts';
import type { Scenario, Seed } from '../scenario.ts';
import { validateScenario } from '../scenario.ts';
import { readRevisions } from './database.ts';
import { historyMap, replayVisible, visibleMap } from './seed.ts';
import type { ClaimChoice, HistoryOverride } from './seed.ts';

export interface Reproduction {
  batch: string; attempt: string; combination: string; entry: string; effort: string;
  result: 'reproduced' | 'not-reproduced' | 'incomplete'; evidence: string;
  /** Empty means the captured wording/environment; list every added context or environment comparison. */
  changedConditions: string[];
}
export interface RedactionRule { id: string; value: string; replacement: string }
export interface CaptureInput {
  id: string; title: string; origin: string; date: string;
  mapId: string; revision: number; restores: 'current-visible-state' | 'history';
  sessionRef: string; humanWords: string | null;
  /** Context supplied to resume the Map, kept distinct from the verbatim human line. */
  replayContext: string;
  originalCombination: string;
  originalConditions: { entry: string; effort: string };
  applies: Scenario['applies'];
  purpose: string;
  claims: ClaimChoice[];
  redactions: RedactionRule[];
  historyOverrides?: HistoryOverride[];
  verdict: null | { target: string; basis: string;
    mustNot: { id: string; text: string; criterion: string }[];
    expect: { id: string; text: string; criterion: string }[] };
  reproductions: Reproduction[];
}
export interface CaptureRecord {
  schema: 'wayfinder-problem-capture/1'; scenarioId: string;
  source: { mapId: string; revision: number; date: string; sessionRef: string; humanWords: string | null };
  purpose: string; restores: Seed['restores'];
  conversion: string[];
  claims: (ClaimChoice & { claimant: string })[];
  redactions: { rule: string; location: string; replacement: string; occurrences: number }[];
  verification: { seedSha256: string; sourceRevisionsVerified: number[] };
  history: { revision: number; author: Revision['author']; changes: Revision['changes'] }[];
  verdict: { status: 'specified' | 'paused'; reasons: string[]; basis: string | null };
  reproduction: { status: 'reproduced' | 'not-reproduced-twice' | 'pending'; originalCombination: string;
    originalConditions: CaptureInput['originalConditions']; attempts: Reproduction[] };
  library: { retain: true; status: 'skeleton' | 'paused-draft'; structuralErrors: string[] };
}
export interface CaptureBundle { seed: Seed; scenario: Scenario; record: CaptureRecord }

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validate(input: CaptureInput) {
  for (const field of ['id', 'title', 'origin', 'date', 'mapId', 'sessionRef', 'originalCombination', 'purpose'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new CaptureError(`Capture requires ${field}`);
  }
  if (!/^[A-Z][A-Za-z0-9]*$/.test(input.id)) throw new CaptureError('Invalid Scenario ID');
  if (!['current-visible-state', 'history'].includes(input.restores)) throw new CaptureError('Explicit seed restoration mode required');
  if (input.humanWords !== null && typeof input.humanWords !== 'string') throw new CaptureError('humanWords must be a string or null');
  if (typeof input.replayContext !== 'string') throw new CaptureError('replayContext must be explicit, possibly empty');
  if (!input.originalConditions?.entry?.trim() || !input.originalConditions.effort?.trim()) throw new CaptureError('Original Entry and effort must be stated (or explicitly unknown)');
  if (!Array.isArray(input.claims) || !Array.isArray(input.redactions) || !Array.isArray(input.reproductions)) throw new CaptureError('Explicit Claim, redaction and reproduction lists required');
  if (new Set(input.claims.map(c => c.ticketId)).size !== input.claims.length
    || input.claims.some(c => !['keep', 'clear'].includes(c.action) || !c.reason?.trim())) throw new CaptureError('Each Claim needs one keep/clear choice and its purpose-based reason');
  if (new Set(input.redactions.map(r => r.id)).size !== input.redactions.length || input.redactions.some(r => !/^[a-z0-9-]+$/.test(r.id)
    || !r.value || !r.replacement || r.replacement.includes(r.value))) throw new CaptureError('Redactions need unique public rule IDs and literal values/replacements');
  const keys = input.reproductions.map(r => `${r.batch}/${r.attempt}`);
  if (new Set(keys).size !== keys.length) throw new CaptureError('A reproduction Attempt cannot be counted twice');
  if (input.reproductions.some(r => !r.batch?.trim() || !r.attempt?.trim() || !r.evidence?.trim()
    || !r.combination?.trim() || !r.entry?.trim() || !r.effort?.trim()
    || !['reproduced', 'not-reproduced', 'incomplete'].includes(r.result) || !Array.isArray(r.changedConditions)
    || r.changedConditions.some(c => !c.trim()))) throw new CaptureError('Each reproduction needs its conditions, result and evidence');
  if (input.verdict && (!input.verdict.basis?.trim() || !input.verdict.target?.trim()
    || !input.verdict.mustNot?.length || !input.verdict.expect?.length
    || [...input.verdict.mustNot, ...input.verdict.expect].some(i => !i.id?.trim() || !i.text?.trim() || !i.criterion?.trim()))) {
    throw new CaptureError('A specified verdict needs its basis, must-not items and positive expectations; otherwise use null');
  }
}

/** Explicit literal redaction over the entire artifact; never record the secret or its original path. */
function redact<T>(value: T, rules: RedactionRule[], log: CaptureRecord['redactions'], root: string): T {
  function walk(v: unknown, location: string): unknown {
    if (typeof v === 'string') {
      let text = v;
      for (const rule of [...rules].sort((a, b) => b.value.length - a.value.length)) {
        const occurrences = text.split(rule.value).length - 1;
        if (occurrences) {
          text = text.split(rule.value).join(rule.replacement);
          log.push({ rule: rule.id, location, replacement: rule.replacement, occurrences });
        }
      }
      return text;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${location}/${i}`));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, item]) => {
      if (rules.some(r => key.includes(r.value))) throw new CaptureError('Private object key needs manual sanitization before capture');
      return [key, walk(item, `${location}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)];
    }));
    return v;
  }
  return walk(value, root) as T;
}

/** This is a guard, not an automatic secret detector. Maintainers still review all output before admission. */
function guardPrivate(value: unknown) {
  const text = JSON.stringify(value);
  if (/(?:file:\/\/|\/Users\/|\/home\/|\/private\/|~\/|[A-Za-z]:\\\\Users\\\\)/i.test(text)
    || /Bearer\s+[A-Za-z0-9._-]{8,}/i.test(text)) throw new CaptureError('Unredacted private path or credential; add an explicit redaction rule');
}

export function captureProblem(database: string, input: CaptureInput): CaptureBundle {
  validate(input);
  const raw = readRevisions(database, input.mapId, input.revision, input.restores === 'history');
  const redactions: CaptureRecord['redactions'] = [];
  const records = redact(raw, input.redactions, redactions, '/source/revisions');
  // Redact metadata too, but never emit the redaction inputs themselves or the database path.
  const { redactions: _private, ...metadata } = input;
  const safe = redact(metadata, input.redactions, redactions, '/input');
  guardPrivate([records, safe, redactions]);
  const head = records.at(-1)!;
  const live = head.state.tickets.filter(t => t.claim);
  if (live.length !== safe.claims.length || live.some(t => !safe.claims.some(c => c.ticketId === t.id))) {
    throw new CaptureError('Record a purpose-based keep/clear choice for every current Claim, and no nonexistent Claims');
  }
  const claims = safe.claims.map(c => ({ ...c, claimant: live.find(t => t.id === c.ticketId)!.claim! }));
  const converted = structuredClone(head.state);
  const cleared = new Set(claims.filter(c => c.action === 'clear').map(c => c.ticketId));
  const expected = { ...converted, tickets: converted.tickets.map(t => cleared.has(t.id) ? { ...t, claim: null } : t) } as Revision['state'];
  const conversion = [input.restores === 'history'
    ? 'History: one reconstructed map_apply per source apply Revision, preserving each snapshot and source client label; original command arguments are not stored in SQLite. Creation uses the Controller. Actor IDs, timestamps and semantic summaries are audit metadata, not restored by the seed.'
    : 'Current visible state only: creation, Tickets, Dependencies, content, Settlements and Claims are rebuilt; source Revision numbers, Settlement introduction Revisions and history are not restored.',
  'Empty Map/Ticket/Settlement extension containers omitted by B01; nonempty containers are refused. Evidence extensions are kept.',
  ...claims.map(c => `Claim ${c.ticketId}: ${c.action} (${c.claimant}). ${c.reason}`)];
  let map = visibleMap(expected);
  let verified: number[] = [];
  if (input.restores === 'history') {
    const history = historyMap(records, safe.historyOverrides ?? []);
    map = history.map;
    verified = history.verified;
    for (const override of safe.historyOverrides ?? []) conversion.push(`Revision ${override.revision} uses supplied command evidence ${override.evidence}: ${override.reason}`);
    if (cleared.size) {
      map.history!.push({ author: 'controller', commands: claims.filter(c => c.action === 'clear').map(c => ({ kind: 'claim.clear',
        ticketId: c.ticketId, expectedClaimantId: c.claimant, reason: c.reason })) });
      map.tickets = visibleMap(expected).tickets;
      conversion.push('Requested Claim clearances are an additional Controller Revision after restored history; no historical Claim was removed.');
    }
  } else {
    if (safe.historyOverrides?.length) throw new CaptureError('History overrides require restores: history');
    if (!isDeepStrictEqual(visibleMap(replayVisible(map)), visibleMap(expected))) throw new CaptureError('Visible-state replay differs from converted source');
    verified = [head.revision];
  }
  conversion.push(`Redaction: ${redactions.reduce((sum, r) => sum + r.occurrences, 0)} literal replacements; see the location-by-location redaction record.`);
  const seed: Seed = { restores: input.restores, maps: [map], fixtures: [],
    derivedFrom: { mapId: safe.mapId, revision: safe.revision, date: safe.date, conversion } };
  const reasons = [!safe.humanWords?.trim() ? 'Original human words missing; verdict paused, no replay turn invented.' : '',
    !safe.verdict ? 'Correct behaviour unresolved; verdict paused, no criterion invented.' : ''].filter(Boolean);
  const scenario: Scenario = { id: safe.id, version: 1, title: safe.title,
    source: { kind: 'real-problem', origin: safe.origin, originalCombination: safe.originalCombination,
      refs: [safe.sessionRef, `Map ${safe.mapId} Revision ${safe.revision}, ${safe.date}`, `Capture ${safe.id}/capture.json`] },
    target: safe.verdict?.target ?? '', applies: safe.applies, seed,
    turns: safe.humanWords?.trim() ? [{ session: 'A', kind: 'opening', say: [safe.replayContext, safe.humanWords].filter(Boolean).join('\n\n') }] : [],
    controller: [], requiredEvents: [],
    mustNot: (safe.verdict?.mustNot ?? []).map(i => ({ ...i, judge: 'model' as const, ...(reasons.length ? { paused: reasons.join(' ') } : {}) })),
    expect: (safe.verdict?.expect ?? []).map(i => ({ id: `${i.id}-group`, text: i.text, anyOf: [{ ...i, judge: 'model' as const,
      ...(reasons.length ? { paused: reasons.join(' ') } : {}) }] })), common: [],
    pending: reasons.length ? reasons : ['Maintainer must review this skeleton, wire available script checks, and admit it to the library.'] };
  const attempts = safe.reproductions;
  const original = attempts.filter(a => a.combination === safe.originalCombination);
  const status = original.some(a => a.result === 'reproduced') ? 'reproduced'
    : original.filter(a => a.result === 'not-reproduced' && !a.changedConditions.length
      && a.entry === safe.originalConditions.entry && a.effort === safe.originalConditions.effort).length >= 2 ? 'not-reproduced-twice' : 'pending';
  const record: CaptureRecord = { schema: 'wayfinder-problem-capture/1', scenarioId: safe.id,
    source: { mapId: safe.mapId, revision: safe.revision, date: safe.date, sessionRef: safe.sessionRef, humanWords: safe.humanWords },
    purpose: safe.purpose, restores: seed.restores, conversion, claims, redactions,
    verification: { seedSha256: digest(map), sourceRevisionsVerified: verified },
    history: input.restores === 'history' ? records.map(r => ({ revision: r.revision, author: r.author, changes: r.changes })) : [],
    verdict: { status: reasons.length ? 'paused' : 'specified', reasons, basis: safe.verdict?.basis ?? null },
    reproduction: { status, originalCombination: safe.originalCombination, originalConditions: safe.originalConditions, attempts },
    library: { retain: true, status: reasons.length ? 'paused-draft' : 'skeleton', structuralErrors: validateScenario(scenario) } };
  if (!reasons.length && record.library.structuralErrors.length) throw new CaptureError('Generated Scenario is invalid; check input applicability and verdict item IDs');
  return { seed, scenario, record };
}
