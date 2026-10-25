import { expect, test } from 'vitest';
import { createMemoryAdapter, decodeApplyRequest, prepareApply, prepareCreate } from '../src/index.js';
import type { CreateMapInput, MapId, Revision, StoredTicket, TicketId } from '../src/index.js';
import { classify, destinationHistory, fogAppearedAt, layerTickets, projectMap } from '../src/viewer-projection.js';
import type { MapView } from '../src/viewer-projection.js';

// Shaped like the real Map "Wayfinder MCP self-contained workflow" (12 Revisions); texts are synthetic.
const author = (minute: number) => ({ actorId: 'operator', clientId: 'ChatGPT-Test', occurredAt: `2026-09-19T11:${String(minute).padStart(2, '0')}:00Z` });
const content = (identity: string, text: string) => ({ id: identity, text, references: [] });
const settle = (ticketId: string, ticketType: string) => ({ kind: 'ticket.settle', ticketId, ticketType, claimantId: 'session:a',
  settlement: { outcome: ticketType === 'research' ? { kind: 'finding', statement: `${ticketId} found` }
    : { kind: 'decision', statement: `${ticketId} decided`, rationale: 'Human verdict' },
  evidence: [], references: [{ locator: `fixture:${ticketId}` }], provenance: { method: 'Fixture', sources: [] }, extensions: {} } });
const claim = (ticketId: string) => ({ kind: 'claim.acquire', ticketId, claimantId: 'session:a' });
const ticket = (identity: string, title: string, type: string) => ({ kind: 'ticket.create', ticket: { id: identity, title, question: `${title}?`, type } });
const depend = (dependentId: string, prerequisiteId: string) => ({ kind: 'dependency.add', dependentId, prerequisiteId });
const selfContained: unknown[][] = [
  [ticket('ClientCapabilityEvidence', 'Client capability', 'research'), ticket('WorkflowContract', 'Workflow contract', 'grilling'),
    ticket('PublicationVersioning', 'Publication versioning', 'grilling'), ticket('AcceptanceContract', 'Acceptance contract', 'grilling'),
    ticket('RepositoryImpact', 'Repository impact', 'research'),
    depend('WorkflowContract', 'ClientCapabilityEvidence'), depend('PublicationVersioning', 'WorkflowContract'),
    depend('AcceptanceContract', 'ClientCapabilityEvidence'), depend('AcceptanceContract', 'WorkflowContract'),
    depend('AcceptanceContract', 'PublicationVersioning'), depend('RepositoryImpact', 'WorkflowContract'),
    depend('RepositoryImpact', 'PublicationVersioning'),
    { kind: 'content.add', section: 'fog', item: content('PromptUx', 'Prompt experience is unclear') },
    { kind: 'content.add', section: 'scopeExclusions', item: content('ImplementationExecution', 'Implementation') },
    { kind: 'content.add', section: 'scopeExclusions', item: content('ProductionExpansion', 'Production') }],
  [claim('ClientCapabilityEvidence')],
  [settle('ClientCapabilityEvidence', 'research'), { kind: 'content.remove', section: 'fog', itemId: 'PromptUx' }],
  [claim('WorkflowContract')], [settle('WorkflowContract', 'grilling')],
  [claim('PublicationVersioning')], [settle('PublicationVersioning', 'grilling')],
  [claim('AcceptanceContract')], [settle('AcceptanceContract', 'grilling')],
  [claim('RepositoryImpact')], [settle('RepositoryImpact', 'research')],
];

async function history(batches: unknown[][], mapId = 'Wayfinder.McpSelfContained'): Promise<Revision[]> {
  const adapter = createMemoryAdapter();
  const created = prepareCreate({ id: mapId, title: 'Self-contained workflow', destination: 'Clients run the workflow alone',
    author: author(0) } as unknown as CreateMapInput);
  if (created.kind !== 'ok') throw new Error('Invalid fixture Map');
  const revisions: Revision[] = [];
  let commit = await adapter.commit(created.value);
  for (const [index, commands] of [[], ...batches].entries()) {
    if (index > 0) {
      const request = decodeApplyRequest({ mapId, expectedRevision: index, author: author(index), commands });
      const current = await adapter.readCurrent(mapId as MapId);
      if (request.kind !== 'ok' || current.kind !== 'found') throw new Error('Invalid fixture batch');
      const prepared = prepareApply(current.value, request.value);
      if (prepared.kind !== 'prepared') throw new Error(`Rejected fixture batch ${index}: ${JSON.stringify(prepared)}`);
      commit = await adapter.commit(prepared.change);
    }
    if (commit.kind !== 'committed') throw new Error('Fixture commit failed');
    revisions.push(commit.revision);
  }
  return revisions;
}
const view = (revisions: Revision[], revision: number) => projectMap(revisions[revision - 1]!, revisions[revision - 2] ?? null);
const states = (map: MapView) => Object.fromEntries(map.tickets.map(ticket => [ticket.id, ticket.state]));

test('V01: Revision 2 draws the route, one Fog item and two Scope Exclusions; only the first Ticket can start', async () => {
  const map = view(await history(selfContained), 2);
  expect(states(map)).toEqual({ ClientCapabilityEvidence: 'available', WorkflowContract: 'waiting', PublicationVersioning: 'waiting',
    AcceptanceContract: 'waiting', RepositoryImpact: 'waiting' });
  expect(map.fog.map(item => item.id)).toEqual(['PromptUx']);
  expect(map.scopeExclusions.map(item => item.id)).toEqual(['ImplementationExecution', 'ProductionExpansion']);
  expect(map.routeClear).toBe(false);
  expect(map.latest.map(item => item.kind)).toEqual([...Array(5).fill('ticket.create'), ...Array(7).fill('dependency.add'),
    'fog.add', 'scope.add', 'scope.add']);
  expect(map.latest.at(-3)).toEqual({ kind: 'fog.add', subjectId: 'PromptUx', label: 'Prompt experience is unclear' });
  expect(map.tickets.find(ticket => ticket.id === 'AcceptanceContract')).toMatchObject({
    prerequisites: ['ClientCapabilityEvidence', 'WorkflowContract', 'PublicationVersioning'], dependents: [], settlement: null });
  expect(map.tickets.find(ticket => ticket.id === 'WorkflowContract')!.dependents).toEqual(['PublicationVersioning', 'AcceptanceContract', 'RepositoryImpact']);
});

test('V02: Revision 3 shows the claimed Ticket in progress with its Claimant', async () => {
  const map = view(await history(selfContained), 3);
  expect(map.tickets[0]).toMatchObject({ state: 'inProgress', claimantId: 'session:a' });
  expect(map.latest).toEqual([{ kind: 'claim.acquire', subjectId: 'ClientCapabilityEvidence', label: 'Client capability' }]);
  expect(map).toMatchObject({ revision: 3, clientId: 'ChatGPT-Test', occurredAt: '2026-09-19T11:02:00Z' });
});

test('V03: Revision 4 settles one Ticket and clears the Fog; the next Ticket can start', async () => {
  const map = view(await history(selfContained), 4);
  expect(map.latest).toEqual([
    { kind: 'ticket.settle', subjectId: 'ClientCapabilityEvidence', label: 'Client capability' },
    { kind: 'fog.remove', subjectId: 'PromptUx', label: 'Prompt experience is unclear' },
  ]);
  expect(states(map)).toMatchObject({ ClientCapabilityEvidence: 'settled', WorkflowContract: 'available' });
  expect(map.tickets[0]!.settlement).toMatchObject({ outcome: { kind: 'finding' }, introducedAtRevision: 4 });
  expect(map.fog).toEqual([]);
  expect(map.routeClear).toBe(false);
});

test('V04: with every Ticket settled and no Fog, the route reaches the Destination', async () => {
  const revisions = await history(selfContained);
  expect(view(revisions, 11).routeClear).toBe(false);
  expect(view(revisions, 12).routeClear).toBe(true);
  expect(Object.values(states(view(revisions, 12)))).toEqual(Array(5).fill('settled'));
});

test('V05: an empty Map has not reached its Destination', async () => {
  const map = view(await history([]), 1);
  expect(map).toMatchObject({ tickets: [], fog: [], routeClear: false, latest: [{ kind: 'map.create', subjectId: 'Wayfinder.McpSelfContained' }] });
});

test('V06: layers follow the longest prerequisite chain; rows keep Map order', async () => {
  const revisions = await history(selfContained);
  expect(Object.fromEntries(layerTickets(revisions[11]!.state.tickets))).toEqual({
    ClientCapabilityEvidence: { layer: 0, row: 0 }, WorkflowContract: { layer: 1, row: 0 }, PublicationVersioning: { layer: 2, row: 0 },
    AcceptanceContract: { layer: 3, row: 0 }, RepositoryImpact: { layer: 3, row: 1 },
  });
  const chain = Array.from({ length: 20_000 }, (_, i) => ({ id: `T${i}` as TicketId, prerequisites: i ? [`T${i - 1}` as TicketId] : [] }));
  expect(layerTickets(chain.reverse() as unknown as StoredTicket[]).get('T19999' as TicketId)).toEqual({ layer: 19_999, row: 0 });
});

test('V07: content changes are classified by section, and map.update only names the Destination when it changed', async () => {
  const revisions = await history([
    [{ kind: 'content.add', section: 'fog', item: content('F', 'Unknown') }],
    [{ kind: 'map.update', patch: { title: 'Renamed' } }],
    [{ kind: 'map.update', patch: { destination: 'Moved destination' } }],
    [{ kind: 'content.remove', section: 'fog', itemId: 'F' }, { kind: 'content.add', section: 'scopeExclusions', item: content('F', 'Excluded now') }],
    [{ kind: 'content.update', section: 'scopeExclusions', item: content('F', 'Excluded later') }],
    [{ kind: 'map.update', patch: { title: 'Renamed again' } }, { kind: 'map.update', patch: { destination: 'Moved again' } }],
  ]);
  expect(view(revisions, 3).latest).toEqual([{ kind: 'map.update', subjectId: 'Wayfinder.McpSelfContained' }]);
  expect(view(revisions, 4).latest).toEqual([{ kind: 'destination.update', subjectId: 'Wayfinder.McpSelfContained' }]);
  expect(view(revisions, 5).latest).toEqual([{ kind: 'fog.remove', subjectId: 'F', label: 'Unknown' },
    { kind: 'scope.add', subjectId: 'F', label: 'Excluded now' }]);
  expect(view(revisions, 6).latest).toEqual([{ kind: 'scope.update', subjectId: 'F', label: 'Excluded later' }]);
  // Changes name no patched field, so a Revision reports one Destination change at most.
  expect(view(revisions, 7).latest.map(item => item.kind)).toEqual(['destination.update', 'map.update']);
  expect(classify({ commandIndex: 0, command: 'content.remove', subjectId: 'Missing' }, revisions[0]!.state)).toEqual({ kind: 'content.remove', subjectId: 'Missing' });
});

test('V08: Destination history names the creating Revision and every later change', async () => {
  const revisions = await history([
    [{ kind: 'map.update', patch: { title: 'Renamed' } }],
    [{ kind: 'map.update', patch: { destination: 'Second destination' } }],
  ]);
  expect(destinationHistory(revisions)).toEqual({
    created: { revision: 1, occurredAt: '2026-09-19T11:00:00Z', clientId: 'ChatGPT-Test', destination: 'Clients run the workflow alone' },
    changes: [{ revision: 3, occurredAt: '2026-09-19T11:02:00Z', clientId: 'ChatGPT-Test', destination: 'Second destination',
      previous: 'Clients run the workflow alone' }],
  });
  expect(destinationHistory(revisions.slice(0, 2)).changes).toEqual([]);
});

test('V09: Fog appearance is the start of its current presence; cleared Fog has none', async () => {
  const revisions = await history(selfContained);
  expect(fogAppearedAt(revisions.slice(0, 3), 'PromptUx')).toMatchObject({ revision: 2 });
  expect(fogAppearedAt(revisions.slice(0, 4), 'PromptUx')).toBeNull();
  const returned = await history([
    [{ kind: 'content.add', section: 'fog', item: content('F', 'Unknown') }],
    [{ kind: 'content.remove', section: 'fog', itemId: 'F' }],
    [{ kind: 'content.add', section: 'fog', item: content('F', 'Unknown again') }],
    [{ kind: 'map.update', patch: { notes: 'Later' } }],
  ]);
  expect(fogAppearedAt(returned, 'F')).toMatchObject({ revision: 4 });
});
