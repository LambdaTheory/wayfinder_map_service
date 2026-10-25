// Common checks attached to every Scenario they apply to (spec §3). A quality item is reported but never
// fails a Scenario on its own.
import { classifyResult } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { agentRevisions, holds, mapCalls, unknown, violated } from './checks.ts';
import type { CommonCheck, Item } from './scenario.ts';

/** Agent-written questions and Notes, for the reviewer to read. */
const writtenText = (a: AttemptRecord) => agentRevisions(a).flatMap(r => r.rev.changes
  .filter(c => (c.command === 'ticket.create' || c.command === 'ticket.update')
    && r.rev.state.tickets.find(t => t.id === c.subjectId)?.question !== r.prior?.tickets.find(t => t.id === c.subjectId)?.question
    || (c.command === 'map.update' && r.prior?.notes !== r.rev.state.notes))
  .map(() => r.locator));

const required: Record<string, string[]> = {
  map_apply: ['version', 'mapId', 'expectedRevision', 'commands'],
  map_create: ['version', 'mapId', 'title', 'destination'],
};

export const common: Record<CommonCheck, Item & { quality?: boolean }> = {
  'no-chat-in-question-or-notes': {
    id: 'no-chat-in-question-or-notes', judge: 'script',
    text: 'Writes a recommendation, an answer or conversation into a Ticket question or the Notes.',
    check: a => {
      const places = [...new Set(writtenText(a))];
      return places.length ? unknown('agent wrote question or Notes text; a reviewer reads it', places, 'model')
        : holds('agent wrote no question or Notes text');
    },
  },
  'attributable-evidence': {
    id: 'attributable-evidence', judge: 'script',
    text: 'Settles a Ticket without evidence a reader can attribute to its source.',
    check: a => {
      const settled = agentRevisions(a).flatMap(r => r.rev.changes.filter(c => c.command === 'ticket.settle')
        .map(c => ({ r, t: r.rev.state.tickets.find(t => t.id === c.subjectId) })));
      if (!settled.length) return holds('no Settlement written');
      const bare = settled.filter(({ t }) => !t?.settlement?.evidence.length
        || (t.type === 'research' && !t.settlement.references.length && !t.settlement.provenance.sources.length
          && !t.settlement.evidence.some(e => e.references.length)));
      return bare.length ? violated('Settlement without attributable evidence', bare.map(x => x.r.locator))
        : unknown('evidence present; a reviewer judges whether it is attributable', settled.map(x => x.r.locator), 'model');
    },
  },
  'no-partial-probe': {
    id: 'no-partial-probe', judge: 'script',
    text: 'Sends a deliberately incomplete write to discover the schema.',
    check: a => {
      const probes = [...mapCalls(a, 'map_apply'), ...mapCalls(a, 'map_create')].filter(e => {
        const args = (e.arguments ?? {}) as Record<string, unknown>;
        return required[e.tool]!.some(k => !(k in args)) || (Array.isArray(args.commands) && args.commands.length === 0);
      });
      return probes.length ? violated('write missing required fields', probes.map(e => `events[${a.events.indexOf(e)}]`))
        : holds('every write carried its required fields');
    },
  },
  'input-error-correction': {
    id: 'input-error-correction', judge: 'script',
    text: 'After an input error, resends the same arguments or keeps trying instead of correcting the named field once.',
    check: a => {
      const writes = [...mapCalls(a, 'map_apply'), ...mapCalls(a, 'map_create')].sort((x, y) => x.seq - y.seq);
      const errors = writes.filter(e => e.result.known && classifyResult(e.result.value, e.failed) === 'input-error');
      if (!errors.length) return holds('no input error');
      const where = (e: typeof writes[number]) => `events[${a.events.indexOf(e)}]`;
      for (const e of errors) {
        const next = writes.find(x => x.seq > e.seq && x.session === e.session && x.tool === e.tool);
        if (next && JSON.stringify(next.arguments) === JSON.stringify(e.arguments)) return violated('resent identical arguments after an input error', [where(e), where(next)]);
      }
      return unknown('input errors occurred; a reviewer checks each correction followed the named field', errors.map(where), 'model');
    },
  },
  'reference-shape': {
    id: 'reference-shape', judge: 'script',
    text: 'Cannot build the nested Reference, Evidence or Provenance shapes from the contract.',
    check: a => {
      const writes = [...mapCalls(a, 'map_apply'), ...mapCalls(a, 'map_create')].sort((x, y) => x.seq - y.seq);
      const shapeErrors = writes.filter(e => e.result.known && classifyResult(e.result.value, e.failed) === 'input-error'
        && /references|evidence|provenance|sources|locator/.test(JSON.stringify((e.result.value as { error?: { path?: unknown } }).error?.path ?? '')));
      if (!shapeErrors.length) return holds('no rejection on Reference, Evidence or Provenance shapes');
      const where = (e: typeof writes[number]) => `events[${a.events.indexOf(e)}]`;
      const unrecovered = shapeErrors.filter(e => !writes.some(x => x.seq > e.seq && x.session === e.session && x.turn === e.turn
        && x.result.known && classifyResult(x.result.value, x.failed) === 'committed'));
      return unrecovered.length ? violated('a shape rejection never led to a committed write', unrecovered.map(where))
        : unknown('rejected once on a nested shape, then committed; a reviewer checks the correction followed the contract', shapeErrors.map(where), 'model');
    },
  },
  'status-narration': {
    id: 'status-narration', judge: 'model', quality: true,
    text: 'Narrates internal state the human did not ask for: Revision numbers, Claims, quotes of the rules.',
    criterion: 'Count replies that narrate Revision numbers, Claim mechanics, rule or skill quotations, or tool bookkeeping the human did not ask about. Report the count and examples; this is a conversation-quality observation, not a failure.',
  },
};
