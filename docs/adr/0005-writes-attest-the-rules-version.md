---
status: accepted
---

# Writes attest the rules version

An open conversation must follow a new release's rules after the service is upgraded underneath it. MCP gives a server no way to replace `instructions` within a session, and the clients in use do not refresh everything on reconnect. In real runs on 2026-10-25, Codex 0.164.0 and Claude Code 2.1.310 both reconnected silently after a restart and resent their write. Codex keeps the tool list and instructions from its first connection; Claude Code refreshes tools but not instructions. Both wrote under the old rules. So `map_create` and `map_apply` now carry `version`, the Release Version whose rules the caller follows, taken from its instructions or from the workflow Resource it read. Any other value is refused before anything is read or written, and the refusal points at the Resource without naming the running version, so a caller can write again only by reading the current rules.

## Considered options

- Hot reload with `listChanged` and `resources/updated` notifications while sessions stay open. This was rejected again ([ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md)). It mixes one session's old instructions with new tools, Codex acts on no list change by default, Claude Code never subscribes to Resources, and code changes need a restart anyway.
- Stamping the version on results and asking the model to notice a difference. The check would depend on model diligence, and a client's automatic resend would still write.
- Rejecting writes from sessions that never listed tools. This is a heuristic about client internals, and it misses Claude Code, which re-lists tools but keeps old instructions.
- A required `version` on writes (chosen).

## Consequences

Every write carries one more field, and a caller whose instructions lack the line pays one refusal and one Resource read. After an upgrade, a client that cannot read Resources (ChatGPT custom connectors) cannot write until the human refreshes the connector. Reads stay ungated, because they change nothing. Adding a required input is incompatible, so this release is `2.0.0`.
