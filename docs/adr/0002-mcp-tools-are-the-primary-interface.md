---
status: accepted
---

# MCP tools are the primary interface

The stable product seam is a small set of headless MCP tools. ChatGPT skills, Codex skills, browser views, and MCP Apps UI act as adapters around that seam, which preserves the same map semantics across products with different rendering capabilities.

## Considered options

- A ChatGPT-specific UI would optimize one client while tying state transitions to that client's lifecycle.
- A browser-first interface would force agents to automate UI flows instead of applying explicit semantic commands.
- Headless MCP tools provide the portable core, while UI resources and ordinary URLs remain optional projections.

## Consequences

Every operation must remain usable without embedded UI. Visual editing is deferred until it can call the same semantic commands rather than introduce a second mutation path.

[ADR 0006](0006-answer-desk-in-the-map-viewer.md), accepted on 2026-10-26, amends this boundary for the viewer's keyed Answer Desk; general Map editing remains with MCP agents.
