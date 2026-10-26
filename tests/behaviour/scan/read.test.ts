import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze.ts';
import { loadInputs, nativeSessions } from './read.ts';
import type { Manifest } from './types.ts';

const fixtures = fileURLToPath(new URL('../fixtures/scan/', import.meta.url));
const manifest: Manifest = { schema: 'wayfinder-usage-input/1', sources: [
  { id: 'codex-current', kind: 'codex', path: 'codex-mcp-0.164.jsonl' },
] };

describe('Codex 0.164.x MCP completion records (Issue #102 shape, synthetic values)', () => {
  it('retains all four tools, call IDs, turns, result classes and native locators without function_call items', () => {
    const data = loadInputs(manifest, fixtures);
    expect(data.sessions).toHaveLength(1);
    const calls = data.sessions[0]!.calls;
    expect(calls.map(({ id, tool, turnId, result }) => ({ id, tool, turnId, result }))).toEqual([
      { id: 'create', tool: 'map_create', turnId: 'turn-write', result: 'committed' },
      { id: 'apply', tool: 'map_apply', turnId: 'turn-write', result: 'committed' },
      { id: 'list', tool: 'map_list', turnId: 'turn-read', result: 'read' },
      { id: 'read', tool: 'map_read', turnId: 'turn-read', result: 'read' },
      { id: 'refusal', tool: 'map_apply', turnId: 'turn-refused', result: 'command-rejected' },
      { id: 'conflict', tool: 'map_apply', turnId: 'turn-refused', result: 'conflict' },
      { id: 'service', tool: 'map_apply', turnId: 'turn-failed', result: 'service-failure' },
      { id: 'service-failed', tool: 'map_read', turnId: 'turn-failed', result: 'service-failure' },
      { id: 'error-only', tool: 'map_read', turnId: 'turn-failed', result: 'transport-failure' },
      { id: 'failed', tool: 'map_apply', turnId: 'turn-failed', result: 'transport-failure' },
    ]);
    for (const call of calls) {
      expect(call.ref).toMatch(/^codex-current\/codex-mcp-0\.164\.jsonl#L\d+$/);
      expect(call.resultRef).toBe(call.ref);
      expect(call.requestId).toBeNull();
      expect(call.requestIdType).toBeNull();
    }
  });

  it('marks MCP activity and emits the same pending write/refusal/Conflict/failure leads as Claude', () => {
    const data = loadInputs(manifest, fixtures);
    const report = analyze(data, manifest);
    expect(report.inventory[0]).toMatchObject({ nativeId: 'synthetic-codex-current', activity: 'mcp', authorization: 'not-assessed' });
    expect(report.inventory[0]!.calls).toEqual(data.sessions[0]!.calls);
    const expected = ['conflict', 'failure', 'refusal', 'write'];
    const signals = report.leads.filter(l => l.kind !== 'missing-evidence');
    expect(signals.map(l => l.kind).sort()).toEqual(expected);
    for (const lead of signals) {
      expect(lead).toMatchObject({ status: 'pending', hasHumanWords: true, requestHumanWords: false });
      expect(lead.evidenceRefs.some(r => r.role === 'tool')).toBe(true);
    }
    expect(report.summary).toMatchObject({ newFailures: 0, modelsStarted: 0 });

    // Feed identical synthetic outcomes through the existing Claude envelope.
    const rows = readFileSync(new URL('../fixtures/scan/codex-mcp-0.164.jsonl', import.meta.url), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { payload: { type: string; item?: { id: string; tool: string; result: unknown } } });
    const claude = nativeSessions(rows.filter(row => row.payload.type === 'item_completed').flatMap((row, i) => {
      const item = row.payload.item!;
      return [
        { ref: `claude#${i}-call`, value: { type: 'assistant', sessionId: 'synthetic-claude', message: {
          content: [{ type: 'tool_use', id: item.id, name: `mcp__wayfinder__${item.tool}`, input: {} }],
        } } },
        { ref: `claude#${i}-result`, value: { type: 'user', sessionId: 'synthetic-claude', message: {
          content: [{ type: 'tool_result', tool_use_id: item.id, content: JSON.stringify(item.result) }],
        } } },
      ];
    }), 'claude', 'claude');
    const comparison = analyze({ sessions: claude, calls: [], launches: [], gaps: [], sources: [] }, manifest);
    expect(comparison.leads.filter(l => l.kind !== 'missing-evidence').map(l => l.kind).sort()).toEqual(expected);
    expect(claude[0]!.calls.map(c => c.result)).toEqual(data.sessions[0]!.calls.map(c => c.result));
  });

  it.each([
    ['cua_repl', 'map_read', 'completed', 'McpToolCall', 'item_completed'],
    ['codex_app', 'map_apply', 'completed', 'McpToolCall', 'item_completed'],
    ['codex_apps', 'wayfinder_save.map_read', 'completed', 'McpToolCall', 'item_completed'],
    ['wayfinder_save', 'map_read', 'failed', 'McpToolCall', 'item_completed'],
    ['wayfinder', 'wayfinder_save.map_read', 'completed', 'McpToolCall', 'item_completed'],
    ['wayfinder', 'map_delete', 'completed', 'McpToolCall', 'item_completed'],
    ['wayfinder', ['map_read'], 'completed', 'McpToolCall', 'item_completed'],
    ['wayfinder', 'map_read', 'in_progress', 'McpToolCall', 'item_completed'],
    ['wayfinder', 'map_read', 'completed', 'OtherToolCall', 'item_completed'],
    ['wayfinder', 'map_read', 'completed', 'McpToolCall', 'item_started'],
  ])('ignores %s / %s / %s / %s / %s', (server, tool, status, type, event) => {
    const sessions = nativeSessions([
      { ref: 'negative#1', value: { type: 'session_meta', payload: { id: 'negative' } } },
      { ref: 'negative#2', value: { type: 'event_msg', payload: { type: event, turn_id: 'negative-turn', item: {
        type, id: 'negative-call', server, tool, status, result: { structuredContent: { kind: 'committed' } },
      } } } },
    ], 'codex', 'negative');
    expect(sessions[0]!.calls).toEqual([]);
    expect(sessions[0]!.fragments).toEqual([]);
    const report = analyze({ sessions, calls: [], launches: [], gaps: [], sources: [] }, manifest);
    expect(report.inventory[0]!.activity).toBe('unrelated');
    expect(report.leads).toEqual([]);
  });

  it.each(['completed', 'failed'].flatMap(status => [false, true].map(completionFirst => ({ status, completionFirst }))))
    ('merges a shared call ID and keeps its $status result (completion first: $completionFirst)', ({ status, completionFirst }) => {
    const call = { ref: 'mixed#call', value: { type: 'response_item', payload: {
        type: 'function_call', call_id: 'same-call', name: 'mcp__wayfinder__map_read', arguments: '{"mapId":"Synthetic.Current"}',
      } } };
    const completion = { ref: 'mixed#completion', value: { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'mixed-turn', item: {
        type: 'McpToolCall', id: 'same-call', server: 'wayfinder', tool: 'map_read', status,
        arguments: { mapId: 'Synthetic.Current' },
        result: { content: [], structuredContent: { kind: 'infrastructure_error' } },
      } } } };
    const sessions = nativeSessions([
      { ref: 'mixed#1', value: { type: 'session_meta', payload: { id: 'mixed' } } },
      ...(completionFirst ? [completion, call] : [call, completion]),
      { ref: 'mixed#output', value: { type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'same-call', output: '{"kind":"found"}',
      } } },
    ], 'codex', 'mixed');
    expect(sessions[0]!.calls).toEqual([{
      id: 'same-call', tool: 'map_read', turnId: 'mixed-turn', mapId: 'Synthetic.Current',
      ref: 'mixed#call', resultRef: 'mixed#completion', result: 'service-failure', requestId: null, requestIdType: null,
    }]);
    expect(sessions[0]!.fragments).toEqual([
      { ref: 'mixed#call', role: 'tool', text: JSON.stringify({ name: 'map_read', arguments: { mapId: 'Synthetic.Current' } }) },
      { ref: 'mixed#completion', role: 'tool', text: JSON.stringify(completion.value.payload.item.result) },
    ]);
    expect(sessions[0]!.fragments.some(f => f.ref === 'mixed#output')).toBe(false);
  });
});
