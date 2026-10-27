import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { immutableClone } from './immutable.js';
import { workflowContract } from './workflow.generated.js';

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
const literal = (value: string | null): Schema => ({ const: value });
const string: Schema = { type: 'string' };
const text: Schema = { type: 'string', pattern: '\\S' };
const id: Schema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\\s\\S])', maxLength: 128 };
const revision: Schema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
// Writes attest which release's rules the caller follows; the value comes from its instructions, not from here.
const version: Schema = { type: 'string', maxLength: 32, description: 'The `version:` line of the Wayfinder instructions you are following.' };
// Compatibility mode, for clients that show their model no server instructions (ChatGPT): the tool definition states the release.
const statedVersion: Schema = { type: 'string', maxLength: 32,
  description: `The Wayfinder release of this tool definition. This client shows you no Wayfinder instructions, so set it to "${workflowContract.version}".` };
const json: Schema = { $ref: '#/$defs/json' };
const jsonObject: Schema = { type: 'object', additionalProperties: json };
const extensions: Schema = { ...jsonObject, propertyNames: { pattern: '^[a-z][a-z0-9_-]*\\.[a-z][a-z0-9_.-]*$(?![\\s\\S])' } };
const reference = object({ locator: text, label: string }, ['locator']);
const references = array(reference);
const provenance = object({ method: text, sources: references });
const evidence = { ...object({ statement: text, references, provenance, extensions }, ['statement', 'references', 'extensions']),
  allOf: [{ if: { properties: { references: { maxItems: 0 } } }, then: { required: ['provenance'] } }] };
const deskCitation = { ...object({ answerId: id, questionVersion: revision }), description: 'deskAnswer {answerId,questionVersion} cites the current Taken answer on the active publication; it is retained in the Settlement.' };
const optionIndex: Schema = { type: 'integer', minimum: 1, maximum: 3 };
const deskQuestionFields = { questionId: id, options: array(object({ label: text, description: text }), { minItems: 2, maxItems: 3 }),
  recommendedOption: optionIndex, recommendedAnswer: text, whyKun: text, triage: { enum: ['needsKun', 'followRecommendation'] }, triageReason: text, gatesResearch: { type: 'boolean' } };
const deskQuestionInput = { ...object(deskQuestionFields), allOf: [{ if: { properties: { recommendedOption: { const: 3 } } }, then: { properties: { options: { minItems: 3 } } } }] };
const publicationFields = { ...deskQuestionFields, question: text, ticketId: id, questionVersion: revision, postedAt: string };
const publication = { oneOf: [object({ ...publicationFields, state: { enum: ['published', 'superseded_by_reopen'] } }),
  object({ ...publicationFields, state: literal('withdrawn'), withdrawnReason: text })] };
const deskChoice = { oneOf: [object({ option: optionIndex, label: text }), object({ text })] };
const reopenChoice = { oneOf: [object({ option: optionIndex, label: text, questionId: id, questionVersion: revision }), object({ text })] };
const answerFields = { kind: literal('answer'), answerId: id, questionId: id, questionVersion: revision, ticketId: id, choice: deskChoice, answeredAt: string };
const answerItem = object(answerFields);
const count = { type: 'integer', minimum: 0 };
const currentQuestionFields = { ...publicationFields, state: { enum: ['pending', 'answered', 'taken', 'settled', 'withdrawn', 'superseded_by_reopen'] },
  currentAnswer: { anyOf: [answerItem, literal(null)] }, answerHistory: array(object({ ...answerFields, state: { enum: ['answered', 'taken'] }, stale: { type: 'boolean' } })),
  immediateUnlocks: count, downstreamUnsettled: count };
const currentQuestion = object({ ...currentQuestionFields, withdrawnReason: text, requestedOption: optionIndex }, Object.keys(currentQuestionFields));
const reopenRequest = object({ requestId: id, ticketId: id, settlementIntroducedAtRevision: revision, requested: reopenChoice,
  affectedTickets: array(id), affectedSettlementRevisions: { type: 'object', additionalProperties: revision }, requestedAt: string,
  state: { enum: ['pending', 'taken'] }, stale: { type: 'boolean' } });
const reopenContext = object({ ticketId: id, requestId: id, requested: reopenChoice, handledAtRevision: revision });
const types = ['grilling', 'prototype', 'research', 'task'] as const;
const ticketType: Schema = { enum: types };
const outcome = (type: typeof types[number]) => type === 'grilling' || type === 'prototype'
  ? object({ kind: literal('decision'), statement: text, rationale: text })
  : type === 'research' ? object({ kind: literal('finding'), statement: text, limitations: string }, ['kind', 'statement'])
    : object({ kind: literal('completion'), statement: text, resultingFacts: jsonObject }, ['kind', 'statement']);
function settlement(type: typeof types[number], stored = false): Schema {
  return { ...object({ outcome: outcome(type), evidence: array(evidence), references, provenance, extensions,
    ...(stored ? { introducedAtRevision: revision, deskAnswer: deskCitation } : {}) }, ['outcome', 'evidence', 'references', 'provenance', 'extensions', ...(stored ? ['introducedAtRevision'] : [])]),
  ...(type === 'research' ? { anyOf: [{ properties: { evidence: { minItems: 1 } } }, { properties: { references: { minItems: 1 } } }] } : {}) };
}
const content = object({ id, text, references });
const ticketFields = { id, title: text, question: text, type: ticketType, extensions };
const ticketInput = object(ticketFields, ['id', 'title', 'question', 'type']);
const mapPatch = { ...object({ title: text, destination: text, notes: string, extensions }, []), minProperties: 1 };
const ticketPatch = { ...object({ title: text, question: text, type: ticketType, extensions }, []), minProperties: 1 };
const command = (kind: string, fields: Record<string, Schema>, optional: string[] = []) =>
  object({ kind: literal(kind), ...fields }, ['kind', ...Object.keys(fields).filter(key => !optional.includes(key))]);
const commands: Schema[] = [
  command('map.update', { patch: mapPatch }), command('ticket.create', { ticket: ticketInput }),
  command('ticket.update', { ticketId: id, patch: ticketPatch, claimantId: id }, ['claimantId']),
  ...['dependency.add', 'dependency.remove'].map(kind => command(kind, { dependentId: id, prerequisiteId: id, claimantId: id }, ['claimantId'])),
  command('claim.acquire', { ticketId: id, claimantId: id }),
  command('claim.release', { ticketId: id, claimantId: id, reason: text }, ['reason']),
  command('claim.clear', { ticketId: id, expectedClaimantId: id, reason: text }),
  { ...command('deskQuestion.post', { ticketId: id, claimantId: id, question: deskQuestionInput }), description: 'deskQuestion.post {ticketId,claimantId,question:{questionId,options:[{label,description}],recommendedOption,recommendedAnswer,whyKun,triage,triageReason,gatesResearch}}. Publish on the claimed Ticket with two or three options and a 1-based recommendedOption; the service assigns questionVersion and postedAt. Reuse questionId on later versions of the same Ticket.' },
  { ...command('deskQuestion.withdraw', { ticketId: id, claimantId: id, questionId: id, questionVersion: revision, reason: text }), description: 'deskQuestion.withdraw {ticketId,claimantId,questionId,questionVersion,reason}. Withdraw the exact active publication on the claimed Ticket with a nonblank reason before posting a replacement version.' },
  { ...command('reopenRequest.close', { requestId: id, reason: text }), description: 'reopenRequest.close {requestId,reason}. Close an unhandled request with a nonblank reason only after its recorded target Settlement no longer exists; earlier commands in this batch may reopen it. This creates a Revision even in a close-only batch.' },
  command('ticket.reopen', { ticketId: id, reason: text }),
  ...['content.add', 'content.update'].map(kind => command(kind, { section: { enum: ['fog', 'scopeExclusions'] }, item: content })),
  command('content.remove', { section: { enum: ['fog', 'scopeExclusions'] }, itemId: id }),
  ...types.map(type => command('ticket.settle', { ticketId: id, ticketType: literal(type), claimantId: id, settlement: settlement(type), deskAnswer: deskCitation }, ['deskAnswer'])),
];
const storedTicket = { oneOf: types.flatMap(type => [
  object({ ...ticketFields, type: literal(type), prerequisites: array(id), status: literal('open'), claim: { anyOf: [id, literal(null)] }, reopenedAtRevision: revision }, [...Object.keys(ticketFields), 'prerequisites', 'status', 'claim']),
  object({ ...ticketFields, type: literal(type), prerequisites: array(id), status: literal('settled'), claim: literal(null), settlement: settlement(type, true) }),
]) };
const state = object({ id, title: text, destination: text, notes: string, fog: array(content), scopeExclusions: array(content),
  tickets: array(storedTicket), extensions, currentRevision: revision, deskQuestions: array(publication) },
  ['id', 'title', 'destination', 'notes', 'fog', 'scopeExclusions', 'tickets', 'extensions', 'currentRevision']);
const changes = array({ oneOf: [
  object({ commandIndex: { type: 'integer', minimum: 0 }, command: { enum: ['claim.clear', 'ticket.reopen', 'claim.release', 'deskQuestion.withdraw', 'reopenRequest.close'] }, subjectId: id, reason: text }),
  object({ commandIndex: { type: 'integer', minimum: 0 }, command: { enum: ['map.create', 'map.update', 'ticket.create', 'ticket.update',
    'deskQuestion.post', 'ticket.settle', 'claim.acquire', 'claim.release', 'dependency.add', 'dependency.remove', 'content.add', 'content.update', 'content.remove'] }, subjectId: id }),
] }, { minItems: 1 });
const fullRevision = object({ mapId: id, revision, priorRevision: { anyOf: [revision, literal(null)] }, kind: { enum: ['create', 'apply'] },
  author: object({ actorId: id, clientId: id, occurredAt: string }), changes, state });
const inputError = object({ code: literal('invalid_input'), path: array({ anyOf: [string, { type: 'integer', minimum: 0 }] }), constraint: string });
const errors: Schema[] = [
  object({ kind: literal('rejected'), code: literal('answer_desk_disabled') }),
  object({ kind: literal('rejected'), rejection: { oneOf: [
    object({ stage: literal('input'), error: inputError }),
    object({ stage: literal('command'), commandIndex: { type: 'integer', minimum: 0 }, code: { enum: ['ticket_already_exists', 'ticket_not_found',
      'ticket_not_open', 'claim_required', 'claim_mismatch', 'ticket_already_claimed', 'unsettled_dependency', 'claim_not_found', 'settlement_type_mismatch',
      'desk_question_active', 'desk_question_not_found', 'desk_question_identity_mismatch', 'desk_answer_required', 'desk_answer_invalid',
      'reopen_request_not_found', 'reopen_request_pending', 'reopen_request_handled', 'reopen_request_inactive', 'reopen_request_stale',
      'reopen_target_omitted', 'reopen_set_mismatch', 'reopen_authorization_exceeded', 'reopen_close_guard',
      'ticket_not_settled', 'self_dependency', 'dependency_already_exists', 'dependency_not_found', 'content_already_exists', 'content_not_found'] }, ticketIds: array(id), uncoveredTickets: array(object({ ticketId: id, reason: { enum: ['not_listed', 'settlement_changed'] } })) }, ['stage', 'commandIndex', 'code', 'ticketIds']),
    object({ stage: literal('final_state'), code: { enum: ['dependency_cycle', 'dangling_dependency', 'settled_ticket_has_open_prerequisite', 'claimed_ticket_has_open_prerequisite'] }, ticketIds: array(id) }),
    object({ stage: literal('final_state'), code: literal('no_changes') }),
  ] } }),
  object({ kind: literal('rejected'), error: inputError }),
  object({ kind: literal('rejected'), code: { enum: ['map_already_exists', 'map_not_found'] }, mapId: id }),
  object({ kind: literal('rejected'), code: literal('version_mismatch'), version: { anyOf: [string, literal(null)] }, rules: literal('wayfinder://workflow/exploration') }),
  object({ kind: literal('not_found'), code: literal('map_not_found'), mapId: id }),
  object({ kind: literal('not_found'), code: literal('revision_not_found'), mapId: id, revision }),
  object({ kind: literal('conflict'), conflict: object({ mapId: id, expectedRevision: revision, currentRevision: revision }) }),
  object({ kind: literal('infrastructure_error'), code: { enum: ['storage_busy', 'storage_failure', 'service_busy', 'service_stopping'] }, outcome: { enum: ['not_published', 'unknown'] }, requiresRestart: { type: 'boolean' } }),
];
const defs = { json: { anyOf: [{ type: ['null', 'boolean', 'number', 'string'] }, array(json), jsonObject] } };
const root = (schema: Schema): Tool['inputSchema'] => ({ type: 'object', ...schema, $defs: defs });
const viewerUrl: Schema = { type: 'string', pattern: '^http://127\\.0\\.0\\.1:[0-9]+/maps/' };
// Only map_create carries the viewer link; map_apply results keep their shape.
const writeOutput = (link: Record<string, Schema>) => [object({ kind: literal('committed'), mapId: id, revision, changes, ...link }, ['kind', 'mapId', 'revision', 'changes']),
  object({ kind: literal('committed'), revision: fullRevision, frontier: array(id), ...link }, ['kind', 'revision', 'frontier'])];
const definitions = (version: Schema): Tool[] => [
  { name: 'map_create', description: workflowContract.toolDescriptions.map_create,
    inputSchema: root(object({ version, mapId: id, title: text, destination: text, notes: string, extensions, includeSnapshot: { type: 'boolean', default: false } }, ['version', 'mapId', 'title', 'destination'])),
    outputSchema: root({ oneOf: [...writeOutput({ viewerUrl }), ...errors] }) },
  { name: 'map_list', description: workflowContract.toolDescriptions.map_list,
    inputSchema: root(object({ limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, afterMapId: id }, [])),
    outputSchema: root({ oneOf: [object({ kind: literal('listed'), maps: array(object({ mapId: id, title: text, destination: text, currentRevision: revision })),
      nextAfterMapId: { anyOf: [id, literal(null)] } }), ...errors] }) },
  { name: 'map_read', description: workflowContract.toolDescriptions.map_read,
    inputSchema: root(object({ mapId: id, revision }, ['mapId'])),
    outputSchema: root({ oneOf: [
      object({ kind: literal('found'), revision: fullRevision, frontier: array(id), viewerUrl, deskQuestions: array(publication) }, ['kind', 'revision', 'frontier', 'deskQuestions']),
      object({ kind: literal('found'), revision: fullRevision, frontier: array(id), viewerUrl, deskQuestions: array(currentQuestion), reopenRequests: array(reopenRequest), reopenContexts: array(reopenContext) }, ['kind', 'revision', 'frontier', 'deskQuestions', 'reopenRequests', 'reopenContexts']), ...errors] }) },
  { name: 'map_apply', description: workflowContract.toolDescriptions.map_apply,
    inputSchema: root(object({ version, mapId: id, expectedRevision: revision, reopenRequestId: { ...id, description: 'Optional Taken Reopen Request authorizing this batch to reopen its target and exactly the currently required settled dependents. The service checks their recorded Settlement bindings and marks the request handled atomically.' }, commands: array({ oneOf: commands }, { minItems: 1, maxItems: 100 }), includeSnapshot: { type: 'boolean', default: false } }, ['version', 'mapId', 'expectedRevision', 'commands'])),
    outputSchema: root({ oneOf: [...writeOutput({}), ...errors] }) },
];
export const mapTools: readonly Tool[] = immutableClone(definitions(version));
export const toolsOnlyMapTools: readonly Tool[] = immutableClone(definitions(statedVersion));
