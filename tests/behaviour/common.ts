// Common checks attached to every Scenario they apply to (spec §3). A quality item is reported but never
// fails a Scenario on its own.
import { inputErrorPath } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { agentRevisions, at, holds, need, resultIs, unknown, violated, writeCalls } from './checks.ts';
import type { CommonCheck, Item, ScriptCheck } from './scenario.ts';

/** Locators of Revisions where the agent wrote a question or the Notes, for the reviewer to read. */
const questionOrNotesWrites = (a: AttemptRecord) => agentRevisions(a).flatMap(r => r.rev.changes
  .filter(c => (c.command === 'ticket.create' || c.command === 'ticket.update')
    && r.rev.state.tickets.find(t => t.id === c.subjectId)?.question !== r.prior?.tickets.find(t => t.id === c.subjectId)?.question
    || (c.command === 'map.update' && r.prior?.notes !== r.rev.state.notes))
  .map(() => r.locator));

const required: Record<string, string[]> = {
  map_apply: ['version', 'mapId', 'expectedRevision', 'commands'],
  map_create: ['version', 'mapId', 'title', 'destination'],
};

/**
 * An input error on a nested shape the contract describes. One correction that commits goes to a reviewer;
 * a rejection that never leads to a committed write in that turn means the contract was not enough.
 */
function shapeCheck(what: string, path: RegExp): ScriptCheck {
  return a => {
    const gap = need(a, what, 'events.tool-call');
    if (gap) return gap;
    const writes = writeCalls(a);
    const rejected = writes.filter(e => path.test(JSON.stringify(inputErrorPath(e.result.known ? e.result.value : null) ?? '')));
    if (!rejected.length) return holds(`no input error on ${what}`);
    const unrecovered = rejected.filter(e => !writes.some(x => x.seq > e.seq && x.session === e.session && x.turn === e.turn && resultIs(x, 'committed')));
    return unrecovered.length ? violated(`an input error on ${what} never led to a committed write`, unrecovered.map(e => at(a, e)))
      : unknown(`input error on ${what}, then a commit; a reviewer checks the correction followed the contract`, rejected.map(e => at(a, e)), 'model');
  };
}

export const common: Record<CommonCheck, Item & { quality?: boolean }> = {
  'no-chat-in-question-or-notes': {
    id: 'no-chat-in-question-or-notes', judge: 'script',
    text: 'Writes a recommendation, an answer or conversation into a Ticket question or the Notes.',
    check: a => {
      const places = [...new Set(questionOrNotesWrites(a))];
      if (places.length) return unknown('agent wrote question or Notes text; a reviewer reads it', places, 'model');
      return need(a, 'question and Notes writes', 'maps') ?? holds('agent wrote no question or Notes text');
    },
  },
  'attributable-evidence': {
    id: 'attributable-evidence', judge: 'script',
    text: 'Settles a Ticket without evidence a reader can attribute to its source.',
    check: a => {
      const gap = need(a, 'Settlement evidence', 'maps');
      if (gap) return gap;
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
      const probes = writeCalls(a).filter(e => {
        const args = (e.arguments ?? {}) as Record<string, unknown>;
        return required[e.tool]!.some(k => !(k in args)) || (Array.isArray(args.commands) && args.commands.length === 0);
      });
      if (probes.length) return violated('write missing required fields', probes.map(e => at(a, e)));
      return need(a, 'partial writes', 'events.tool-call') ?? holds('every write carried its required fields');
    },
  },
  'command-shape': {
    id: 'command-shape', judge: 'script',
    text: 'Cannot build complete commands from the contract, for example a wrong nested field in ticket.create.',
    check: shapeCheck('command fields', /"commands"/),
  },
  'reference-shape': {
    id: 'reference-shape', judge: 'script',
    text: 'Cannot build the nested Reference, Evidence or Provenance shapes from the contract.',
    check: shapeCheck('Reference, Evidence or Provenance shapes', /references|evidence|provenance|sources|locator/),
  },
  'input-error-correction': {
    id: 'input-error-correction', judge: 'script',
    text: 'After an input error, resends the same arguments or keeps trying instead of correcting the named field once.',
    check: a => {
      const gap = need(a, 'input-error corrections', 'events.tool-call');
      if (gap) return gap;
      const writes = writeCalls(a);
      const errors = writes.filter(e => resultIs(e, 'input-error'));
      if (!errors.length) return holds('no input error');
      for (const e of errors) {
        const next = writes.find(x => x.seq > e.seq && x.session === e.session && x.tool === e.tool);
        if (next && JSON.stringify(next.arguments) === JSON.stringify(e.arguments)) return violated('resent identical arguments after an input error', [at(a, e), at(a, next)]);
      }
      return unknown('input errors occurred; a reviewer checks each correction followed the named field', errors.map(e => at(a, e)), 'model');
    },
  },
  'status-narration': {
    id: 'status-narration', judge: 'model', quality: true,
    text: 'Narrates internal state the human did not ask for: Revision numbers, Claims, quotes of the rules.',
    criterion: 'Count replies that narrate Revision numbers, Claim mechanics, rule or skill quotations, or tool bookkeeping the human did not ask about. Report the count and examples; this is a conversation-quality observation, not a failure.',
  },
};
