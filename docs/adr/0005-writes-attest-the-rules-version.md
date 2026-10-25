---
status: accepted
---

# Writes attest the rules version

An open conversation must follow a new release's rules after the service is upgraded underneath it. MCP gives a server no way to replace `instructions` within a session, and the clients in use do not refresh everything on reconnect. In real runs on 2026-10-25, Codex 0.164.0 and Claude Code 2.1.310 both reconnected silently after a restart and resent their write. Codex keeps the tool list and instructions from its first connection, and Claude Code keeps tool definitions it loaded through tool search. Both wrote under the old rules. So `map_create` and `map_apply` carry `version`, the release whose rules the caller follows. Any other value is refused before anything is read or written. The refusal points at the workflow Resource without naming the running version, so a caller writes again only after reading the current rules.

A caller normally takes the value from the `version:` line of its instructions. A ChatGPT run the same day showed that ChatGPT never shows its model the server instructions. After a tool refresh, a new chat held the new tool definition but had to guess the version, so it could not write at all. Kun chose a compatibility mode over changing the source for every client. The operator marks such a client's credential `toolsOnly`, and its sessions get write tools whose `version` parameter states the release. Those callers attest the tool definition they hold instead.

## Considered options

- Hot reload with `listChanged` and `resources/updated` while sessions stay open. Rejected again ([ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md)): it mixes old instructions with new tools in one session, Codex acts on no list change by default, Claude Code never subscribes to Resources, and code changes need a restart anyway.
- Stamping the version on results and asking the model to notice: depends on model diligence, and an automatic resend would still write.
- Taking the version from the tool definition for every client: this would make ChatGPT work, but Claude Code after `--resume` (fresh tools, old instructions) would no longer be stopped.
- Instructions for clients that show them, and the tool definition in compatibility mode for those that do not (chosen).

## Consequences

Every write carries one more field. A caller whose instructions lack the line pays one refusal and one Resource read. In compatibility mode the instructions are not attested, and ChatGPT cannot read Resources: it recovers when the human refreshes its tools and starts a new conversation. Rules that change writes therefore live in both the instructions and the descriptions of the tools they govern (spec section 14.2). Reads stay ungated, because they change nothing. Adding the required input made 2.0.0 incompatible. 2.0.1 adds compatibility mode before 2.0.0 was ever released.
