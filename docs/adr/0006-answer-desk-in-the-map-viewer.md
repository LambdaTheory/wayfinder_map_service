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

This is a narrow amendment to [ADR 0002](0002-mcp-tools-are-the-primary-interface.md): the viewer is no longer exclusively a projection, but it does not become a general Map editor or an embedded assistant. One keyed route accepts a human's response to a particular Question Version; it cannot post questions, change Dependencies, reopen a Ticket or settle it. Read-only access remains available without the key. The service validates answers and subsequent agent Settlements against the same authoritative state.

The `wayfinder` launcher opens the desk with a key in a URL fragment, and the page sends the key in a request header on the answer route. Fragments are not sent in HTTP requests; this does not by itself exclude them from browser history. Keys stay out of Map state, logs and errors. The loopback Host, same-origin and tunnel exclusions remain; this does not deliver OAuth, sharing or public access.

The viewer's original acceptance and implementation record remain evidence for the read-only release. This ADR authorizes no implementation or release until the specification gate is satisfied.
