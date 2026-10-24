# Changelog

All notable project changes are recorded here. Historical implementation evidence remains in `docs/implementation/` and is not rewritten into this log.

## Unreleased

### Workflow

- `2.2.0` (2026-10-24): carry the Wayfinder method, not only the safety rules, after a 2026-10-23 Codex method experiment and stress run (`docs/implementation/wayfinder-method-experiment.md`). Settle the Destination before `map_create`; plan rather than build; settle at most one non-research Ticket per human turn, instead of one per session; Ticket questions hold only the question; Notes hold no decisions; out-of-scope Tickets become Scope Exclusions, never Settlements. A HITL Settlement needs the human's reply to the specific proposed answer, including when a reopened Ticket is settled again; "continue", a scope instruction or blanket delegation is not one. Keep a Claim across turns only while waiting for that reply, release it with a reason otherwise, and clear another session's Claim only when the human explicitly asks. An input-stage rejection may be corrected and resent once; Conflicts still stop. The `map_apply` description now states every command shape, because Codex runs could not build `ticket.create` or `dependency.add` from the nested schema and fell back to reading this repository's source.
- `2.1.0` (2026-10-23): `map_create` and `map_read` results may carry `viewerUrl`, the local read-only viewer link; agents give it to the human once when they create or resume a Map. Backward compatible; tool inputs, Map state and `map_apply`/`map_list` results are unchanged.
- `2.0.0` (2026-09-20): change mandatory Conflict handling after a real ChatGPT acceptance attempt automatically resubmitted a stale intention at the reread head. A Conflict now voids that request; the client must reread, report the new Revision and stop until the human issues a new request after seeing it. The four tools, schemas and Map state semantics are unchanged.
- `1.2.0` (2026-09-20): make nested Reference, Provenance and Evidence object shapes explicit after the `1.1.0` diagnostic exposed a string-source mismatch. No Map tool, schema or state semantics changed.
- `1.1.0` (2026-09-20): add backward-compatible complete-command construction guidance after the first isolated Codex journey exposed partial validation probing. No Map tool, schema or state semantics changed.
- `1.0.0` (2026-09-19): publish the Wayfinder exploration workflow through MCP initialization instructions and locally sufficient descriptions for the four Map tools, with complete stable/versioned Resources and an optional side-effect-free Prompt. The contract is generated from `docs/agents/exploration-mcp.md`, remains immutable for one service process and removes repository-file or installed-Skill requirements from compatible clients.

### Skills

- Replace the 30-line project `wayfinder` adapter with the MCP method skill used in the 2026-10-23 experiment, aligned with workflow 2.2.0, and allow implicit invocation. In the experiment both skill-only runs passed every check, and in the stress run the upstream body failed three scenarios this skill passed.

### Commands

- `claim.release` accepts an optional nonblank `reason`, recorded in the Revision change like the reasons of `claim.clear` and `ticket.reopen`. Existing requests without it behave as before.

### Viewer

- Serve a local read-only Map viewer from the MCP service: the route of Tickets laid out by prerequisites, Fog in front of the Destination, Scope Exclusions outside the Map, details on request, and a page that follows new Revisions every two seconds and shows when it is stale. `/mcp` keeps its token; the ChatGPT test relay still forwards only `/mcp`.

### Architecture

- Record ADR 0003: the MCP service carries the independently versioned exploration workflow.
- Return expected structured domain outcomes such as Conflict, Rejected and Not Found without MCP `isError`, preventing ChatGPT from collapsing them into generic runtime exceptions; infrastructure and protocol failures remain errors.

### Documentation

- Add the accepted post-adoption self-contained workflow slice and its client-capability and repository-impact research.
- Align real-client acceptance with the exercised ChatGPT Desktop synchronized remote connector plus independent Codex CLI sessions; record the distinct persistent Codex-host configuration regression as not applicable rather than claiming it passed.
- Record the explicit live-human acceptance of workflow 2.0.0 and the final Grilling Settlement at Map Revision 8.
