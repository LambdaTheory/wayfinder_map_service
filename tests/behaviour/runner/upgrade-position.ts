import { isDeepStrictEqual } from 'node:util';
import type { EventRecord } from '../evidence.ts';

/** Independent native channels may omit records. An anchor is usable only when
 * every order-preserving match in its channel selects the same Event. Text alone
 * never pairs response/completion records belonging to different messages. */
export function upgradeAnchors(lines: string[], events: EventRecord[]) {
  const anchors = new Map<number, EventRecord | undefined>();
  const channels = new Map<string, { line: number; candidates: EventRecord[] }[]>();
  for (const [line, text] of lines.entries()) {
    try {
      const e = JSON.parse(text), p = e.payload, item = p?.item;
      let channel: string;
      let candidates: EventRecord[];
      if (e.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
        channel = 'response';
        const text = Array.isArray(p.content) ? p.content.filter((c: { type?: string } | null) => c?.type === 'output_text')
          .map((c: { text?: string }) => c.text ?? '').join('') : null;
        candidates = events.filter(e => e.kind === 'message' && e.role === 'assistant' && e.text === text);
      } else if (e.type === 'event_msg' && p?.type === 'item_completed' && ['AgentMessage', 'McpToolCall'].includes(item?.type)) {
        channel = 'completion';
        const text = Array.isArray(item.content) ? item.content.map((c: { text?: string } | null) => c?.text ?? '').join('') : null;
        candidates = events.filter(e => item.type === 'AgentMessage'
          ? e.kind === 'message' && e.role === 'assistant' && e.text === text
          : e.kind === 'tool-call' && e.server === item.server && e.tool === item.tool && isDeepStrictEqual(e.arguments, item.arguments));
        // Rollout IDs (exec-… / msg_…) and stdout item_N IDs are different
        // namespaces. Neither identity nor non-identity can be inferred from them.
      } else continue;
      anchors.set(line, undefined);
      const entries = channels.get(channel) ?? [];
      if (candidates.length) entries.push({ line, candidates });
      channels.set(channel, entries);
    } catch { /* Non-record lines cannot establish an anchor. */ }
  }
  for (const entries of channels.values()) {
    let previous = -Infinity;
    const earliest = entries.map(({ candidates }) => {
      const match = candidates.find(e => e.seq > previous);
      previous = match?.seq ?? Infinity;
      return match;
    });
    let next = Infinity;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const latest = entry.candidates.findLast(e => e.seq < next);
      next = latest?.seq ?? -Infinity;
      if (latest && latest === earliest[i]) anchors.set(entry.line, latest);
    }
  }
  return anchors;
}
