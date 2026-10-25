# Changelog

All notable project changes are recorded here. Historical implementation evidence remains in `docs/implementation/` and is not rewritten into this log.

Each section is one release. Since `1.0.1` one SemVer in `package.json`, the Release Version, covers the service and the workflow it carries; `docs/spec/mcp-sqlite.md` §14.3 says which part to raise, and each release is tagged `v<version>` on `main` ([ADR 0004](docs/adr/0004-one-release-version.md)). Before that only the workflow had a version, `workflowVersion` (`1.0.0` to `3.0.0` below), and the server reported a fixed `0.1.0`.

## 2.0.2 (2026-10-25)

- Behaviour unchanged. The `wayfinder` launcher (the dedicated Codex and Claude Code entry) moved from the workspace into this repository as `scripts/wayfinder-agent/`, so it is versioned with the service and is the entry the behaviour tests exercise. It serves from the repository it lives in by default (`WAYFINDER_AGENT_CHECKOUT` still overrides), and its instruction files are now `agent-instructions.md` and `agent-instructions.matt.md`, installed into each state directory under the name its harness expects. Upstream Matt skills path is overridable with `WAYFINDER_AGENT_MATT_SKILLS`.

## 2.0.1 (2026-10-25)

- Compatibility mode for clients that show their model no server instructions. A ChatGPT run showed that ChatGPT never shows the instructions to its model: after a tool refresh, a new chat had the new tool definition but had to guess the version, so 2.0.0 could not write from ChatGPT at all. A credential marked `toolsOnly` now gets `map_create` and `map_apply` whose `version` parameter states the release. `wayfinder chatgpt` and the ChatGPT runner's own service set it. Other clients still take the version from their instructions ([ADR 0005](docs/adr/0005-writes-attest-the-rules-version.md)).
- The write tool descriptions now also cover callers without instructions. They say a `version_mismatch` is not a tool failure: read the Resource and retry, or, only for a client that cannot read Resources, ask the human to refresh the server's tools and start a new conversation. With a softer wording, Codex stopped instead of reading the Resource.
- Rules that change writes live in both the instructions and the descriptions of the tools they govern (spec section 14.2).
- 2.0.0 was never released.

## 2.0.0 (2026-10-25)

- Writes attest the rules version. `map_create` and `map_apply` require `version`, the release whose rules the caller follows (its instructions' `version:` line, or the first line of the workflow Resource). A missing or other value returns `{ kind: 'rejected', code: 'version_mismatch', version, rules }` before anything is validated or written, without naming the running version. Real runs on 2026-10-25 showed Codex 0.164.0 and Claude Code 2.1.310 reconnecting silently after a restart and writing under the old rules ([ADR 0005](docs/adr/0005-writes-attest-the-rules-version.md)). Incompatible, because every write needs the new field.
- The workflow Resource text begins with `version: <version>`. The `map_create` and `map_apply` descriptions say what to do on `version_mismatch`: read the Resource, follow it, reread the Map, retry with its version, or ask the human to reconnect.
- How each client behaves across an upgrade, and the manual recovery steps, are in [Open conversations across an upgrade](docs/implementation/client-upgrade.md).

## 1.0.1 (2026-10-25)

- One version for the service and its workflow, starting at `1.0.1`. `package.json` holds it, and the workflow source no longer carries a number. The server reports it in MCP `serverInfo.version`, which was a fixed `0.1.0`. Initialization instructions and the Prompt now say `version: 1.0.1` instead of `workflowVersion: 3.0.0`, Resource metadata uses `wayfinder/version`, and the readiness line reads `ready version=`. Every change to the service or its workflow raises the version, and a test compares shipped files with the last `v*` tag. The workflow rules and the tools are unchanged. PR #55 first numbered this release `3.0.1`; it never ran, and its tag was withdrawn.

## Before 1.0.1

### Workflow

- `3.0.0` (2026-10-25): keep one coherent conversation moving instead of making the human ask for each next Ticket. Real use on 2026-10-24/25 (`contexts/projects/wayfinder_map_service/reviews/20261025_B.html` in Kun's workspace) showed 10 of 29 human messages were only "continue", because 2.2.0 stopped after every Settlement; the same question run with Matt Pocock's original skill took 11 messages and none of them, partly because that agent asked without ending its turn while sub-agents researched. Now the main session holds the conversation, the Claims and every write, and sub-agents, where the client has them, do the reading: AFK Tickets, evidence, prototypes. After a Settlement the agent takes the next Frontier work in the same turn; while a verdict is pending it prepares other Frontier Tickets and rechecks the drafts before asking; independent HITL questions go out together, up to three per message, each with a recommended answer, without ending the turn where the client allows; a reply settles only the answers it covers. "Continue" is still not a verdict, and when the route is clear the Map is done and handed off: "continue" does not start the build, which happens outside the Map unless its Notes say otherwise (a 2026-10-25 session started implementing on "continue"). Reopening a settled decision, on this or another Map, needs the human's agreement, which the verdict request may ask for by naming the decision. Agents report outcomes and questions, not Claims, Revisions or rules; a prototype of something that already exists starts from its current implementation; when the tools fail, an agent stops instead of reaching the service by another route or with another client's credentials. Incompatible because the per-turn stopping rule is removed; the four tools, schemas and Map state are unchanged.
- `2.2.0` (2026-10-24): carry the Wayfinder method, not only the safety rules, after a 2026-10-23 Codex method experiment and stress run (`docs/implementation/wayfinder-method-experiment.md`). Settle the Destination before `map_create`; plan rather than build; settle at most one non-research Ticket per human turn, instead of one per session; Ticket questions hold only the question; Notes hold no decisions; out-of-scope Tickets become Scope Exclusions, never Settlements. A HITL Settlement needs the human's reply to the specific proposed answer, including when a reopened Ticket is settled again; "continue", a scope instruction or blanket delegation is not one. Keep a Claim across turns only while waiting for that reply, release it with a reason otherwise, and clear another session's Claim only when the human explicitly asks. An input-stage rejection may be corrected and resent once; Conflicts still stop. The `map_apply` description now states every command shape, because Codex runs could not build `ticket.create` or `dependency.add` from the nested schema and fell back to reading this repository's source.
- `2.1.0` (2026-10-23): `map_create` and `map_read` results may carry `viewerUrl`, the local read-only viewer link; agents give it to the human once when they create or resume a Map. Backward compatible; tool inputs, Map state and `map_apply`/`map_list` results are unchanged.
- `2.0.0` (2026-09-20): change mandatory Conflict handling after a real ChatGPT acceptance attempt automatically resubmitted a stale intention at the reread head. A Conflict now voids that request; the client must reread, report the new Revision and stop until the human issues a new request after seeing it. The four tools, schemas and Map state semantics are unchanged.
- `1.2.0` (2026-09-20): make nested Reference, Provenance and Evidence object shapes explicit after the `1.1.0` diagnostic exposed a string-source mismatch. No Map tool, schema or state semantics changed.
- `1.1.0` (2026-09-20): add backward-compatible complete-command construction guidance after the first isolated Codex journey exposed partial validation probing. No Map tool, schema or state semantics changed.
- `1.0.0` (2026-09-19): publish the Wayfinder exploration workflow through MCP initialization instructions and locally sufficient descriptions for the four Map tools, with complete stable/versioned Resources and an optional side-effect-free Prompt. The contract is generated from `docs/agents/exploration-mcp.md`, remains immutable for one service process and removes repository-file or installed-Skill requirements from compatible clients.

### Skills

- Align the MCP method skill with workflow 3.0.0: the main session talks, decides and writes while sub-agents do the reading and prepare the next questions; ask independent decisions together without stalling; hand off when the route is clear and never start the build on "continue"; name a settled decision before reopening it; build prototypes of existing things from their implementation; stop when the Wayfinder tools fail instead of calling the service another way, since a client that cannot connect never receives the server instructions; keep Claims, Revisions and quoted rules out of replies.
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
