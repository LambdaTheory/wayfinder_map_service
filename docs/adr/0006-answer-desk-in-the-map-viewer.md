---
status: accepted
---

# The Map viewer accepts keyed answers

Kun chose an Answer Desk inside the local Wayfinder service on 2026-10-26 ([#108](https://github.com/kun-g/wayfinder_map_service/issues/108)). Wide Maps have many independent questions ready together; answering in the agent's conversation serializes human attention and can block research. The existing Map viewer gains a second write entry for Desk Answers and Reopen Requests, protected by a key. Agents still post and withdraw Desk Questions, edit Maps, manage Claims and settle Tickets through MCP. Kun accepted the detailed decisions on 2026-10-26; [the Answer Desk specification](../spec/answer-desk.md) records them for the design session's transcription check under [#109](https://github.com/kun-g/wayfinder_map_service/issues/109).

## Considered options

- Keep answers in each agent's conversation: no new HTTP write entry, but the human must switch clients and relay answers, and a blocking picker prevents that session from consuming research results.
- Build a separate answer page or service: separates answer UI from the viewer, but duplicates Map context, routing and freshness handling and makes the human move between the route and its questions.
- Add the Answer Desk to the existing viewer (chosen): the question, its place in the route and its resulting Settlement share one view and one state authority.

## Consequences

This narrowly amends [ADR 0002](0002-mcp-tools-are-the-primary-interface.md): the viewer becomes a second write entry for Desk Answers and Reopen Requests, including changes and permitted cancellation, while agent MCP operations retain Map editing. The [browser boundary](../spec/answer-desk.md#7-keyed-browser-boundary) defines the one route, its key and the exact permitted actions; the [Reopen Request contract](../spec/answer-desk.md#reopen-requests) defines the affected-decision authorization.

The service remains the sole state authority. [Revision and storage boundaries](../spec/answer-desk.md#8-revisions-storage-and-required-evidence) distinguish human responses from agent-authored Map history; [Settlement validation](../spec/answer-desk.md#agent-settlement) keeps the second write entry from bypassing the agent's acceptance checks.

The viewer's original acceptance and implementation record remain evidence for the read-only release. This ADR authorizes no implementation or release until the specification gate is satisfied.
