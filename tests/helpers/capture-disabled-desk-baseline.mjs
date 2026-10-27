// Regenerate with Node 26.3.0: build an exported v3.1.0 checkout using the
// pinned dependencies, then pass its absolute path as the sole argument.
// No database, listener, tunnel or model is used.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const checkout = process.argv[2];
const release = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version;
assert.equal(release, '3.1.0');
const { createMapMcpServer } = await import(pathToFileURL(join(checkout, 'dist/mcp-tools.js')));
const mapId = 'Acceptance.Alpha';
const ordinary = { kind: 'map.update', patch: { notes: 'unchanged on rejection' } };
const apply = commands => ({ version: release, mapId, expectedRevision: 1, commands });
const cases = [
  ...['deskQuestion.post', 'deskQuestion.withdraw', 'reopenRequest.close'].flatMap(kind => [
    { label: kind, name: 'map_apply', arguments: apply([{ kind }]) },
    { label: `${kind} after an ordinary command`, name: 'map_apply', arguments: apply([ordinary, { kind }]) },
  ]),
  ...[{}, { answerId: 'Answer', questionVersion: 1 }].map(deskAnswer => ({
    label: `ticket.settle deskAnswer ${JSON.stringify(deskAnswer)}`, name: 'map_apply',
    arguments: apply([{ kind: 'ticket.settle', deskAnswer }]),
  })),
  ...['Request', null].map(reopenRequestId => ({
    label: `reopenRequestId ${JSON.stringify(reopenRequestId)}`, name: 'map_apply',
    arguments: { ...apply([ordinary]), reopenRequestId },
  })),
  ...[{ claimantId: 'work' }, { version: release }, { claimantId: 'work', version: release },
    { version: release, claimantId: 'work' }, { revision: 1, claimantId: 'work', version: release }].map(fields => ({
    label: `map_read ${Object.keys(fields).join(',')}`, name: 'map_read', arguments: { mapId, ...fields },
  })),
  { label: 'invalid map identity precedes command syntax', name: 'map_apply',
    arguments: { ...apply([{ kind: 'deskQuestion.post' }]), mapId: '' } },
  { label: 'earlier invalid command precedes desk command', name: 'map_apply',
    arguments: apply([{ kind: 'map.update', patch: {} }, { kind: 'deskQuestion.post' }]) },
  { label: 'snapshot shape precedes desk command', name: 'map_apply',
    arguments: { ...apply([{ kind: 'deskQuestion.post' }]), includeSnapshot: 'invalid' } },
];
const storage = new Proxy({}, { get() { throw new Error('Rejected syntax must not access storage'); } });
const server = createMapMcpServer(storage, { actorId: 'operator', clientId: 'baseline' });
const client = new Client({ name: 'baseline-capture', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  await client.listTools();
  for (const entry of cases) {
    entry.result = await client.callTool({ name: entry.name, arguments: entry.arguments });
    assert.equal(entry.result.structuredContent?.rejection?.error?.code, 'invalid_input');
  }
  writeFileSync(new URL('./mcp-disabled-desk-v3.1.0.json', import.meta.url), JSON.stringify({
    release, commit: '033b6f910c9102af8ea3d934b7e6bcbabe260bd4', cases,
  }, null, 2) + '\n');
} finally { await client.close(); await server.close(); }
