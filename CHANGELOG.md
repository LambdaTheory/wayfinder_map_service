# Changelog

All notable project changes are recorded here. Historical implementation evidence remains in `docs/implementation/` and is not rewritten into this log.

Each section is one release. Since `1.0.1` one SemVer in `package.json`, the Release Version, covers the service and the workflow it carries; `docs/spec/mcp-sqlite.md` §14.3 says which part to raise, and each release is tagged `v<version>` on `main` ([ADR 0004](docs/adr/0004-one-release-version.md)). Before that only the workflow had a version, `workflowVersion` (`1.0.0` to `3.0.0` below), and the server reported a fixed `0.1.0`.

## 3.3.0 (2026-10-27)

- Add Answer Desk `map_wait` with task and blocking execution, once-only delivery after the Map Quiet Window, and taking `map_read` for turn-start delivery. Answers and Reopen Requests retain Taken state through interruption and restart.
- Keep Answer Desk **disabled by default** behind `answerDeskEnabled` / `WAYFINDER_ANSWER_DESK_ENABLED=true`: disabled discovery remains four tools with the existing schemas and errors; enabled discovery exposes five tools in both protocol eras. Mandatory workflow text is unchanged until #114.
- Stream blocking-wait progress over SSE with redacted protocol errors, share delivery admission across protocol instances, and raise the dedicated Codex MCP timeout to 1,800 seconds. Real-client journeys remain for the coordinated acceptance run.
- Encode retained Tasks results for the official extension decoder and allow retry after a lost collection response; cancel blocking waits on HTTP disconnect in both eras before they take later answers. Keep enabled tool input schemas free of top-level combinators, with taking-read constraints described in fields and enforced by the service.

## 3.2.0 (2026-10-27)

- Add format-2 Desk Question, Desk Answer and Reopen Request storage; service startup alone explicitly opts into migration, first retains a consistent private backup, then migrates format 1 atomically. Every backup uses a read-only source connection, preserving format 1 or 2 in both source and output, including the ChatGPT runner's initial, scheduled and final backups when attached to an older running service.
- Add versioned question publication/withdrawal, typed Taken-answer Settlement citations and guarded Reopen Request handling/closure. Commit rechecks desk state to prevent stale answers or superseded requests winning a race.
- Expose current/history desk inspection, affected settled dependents and handled-request context through `map_read`; preserve requested options until the target settles again.
- Stage Answer Desk commands, schemas and inspection projections behind the default-off `answerDeskEnabled` service setting (`WAYFINDER_ANSWER_DESK_ENABLED=true` for isolated runs), shared by both protocol eras. Disabled tool definitions match 3.1.0 apart from the Release Version; ordinary reads have no added desk projections. Disabled desk syntax follows the original input-validation path and returns the same declared `invalid_input` results as 3.1.0, including after SDK tool discovery. Four tools and the existing workflow remain; #112/#113 supply delivery and browser UI, and #114 publishes the coordinated workflow and enables the desk by default.
- Refuse disabled startup with `answer_desk_required` if retained desk records show the database has used Answer Desk; the operator message names the enable setting without exposing paths. Migrated but unused databases continue to start normally. Preserve original Revision history in both cases.

## 3.1.0 (2026-10-27)

- Migrate to MCP SDK v2: server/client 2.4.0 and Node adapter 2.1.2. `/mcp` retains sessionful `2025-11-25` initialization and restart-404 recovery, and explicitly enables sessionless `2026-07-28` discovery and per-request metadata. Both eras share the unchanged four tools, schemas, workflow, Resource, Prompt, credential identity and admission limits.
- ChatGPT connectivity on this release is unverified; live check at #114. Missing-header discovery now returns HTTP 400 / `-32020` instead of the previously observed `-32000`; fallback on the new error is unverified.
- The everyday ChatGPT relay and behaviour-test relay share the MCP request-header allowlist, including `Mcp-Method` and `Mcp-Name`, so conforming modern discovery and named calls reach the service. The behaviour relay captures terminal JSON/SSE responses and only the non-secret `MCP-Protocol-Version` header; sessionless tool-snapshot attribution remains insufficient evidence until bound to a native chat.
- SDK v2 classifies malformed tool-call parameters as JSON-RPC `InvalidParams` (`-32602`), replacing SDK v1's `InternalError` (`-32603`). Neither path publishes a Map mutation.

## 3.0.0 (2026-10-27)

- A human question is neither an instruction nor a verdict: answer it and ask before acting. Changing Scope Exclusions, the Destination or Notes, or narrowing a question or removing a Dependency to move work out, requires the human's explicit instruction or agreement. When a Ticket is found beyond the Destination, the agent now releases its Claim and proposes a Scope Exclusion. The initialization instructions carry the answer, ask and proposal steps; both the instructions and the `map_apply` description state the human authorization requirement. The dedicated `wayfinder` skill and full workflow Resource follow that boundary; the four tool schemas and Map model are unchanged.
- F11 reproduced three times on Release Version 2.0.2: agents treated the human's question as their own discovery that work was beyond the Destination, then changed the Map before the human answered. The former self-discovery rule allowed that path, so the new boundary covers both a human question and the agent's own finding ([#87 root cause and proposed wording](https://github.com/kun-g/wayfinder_map_service/issues/87#issuecomment-6405351705), [Kun's approval](https://github.com/kun-g/wayfinder_map_service/issues/87#issuecomment-6405899011)). This is a major release because it changes a mandatory rule.
- F11 Scenario v2 limits its scope-change check to Scope Exclusion additions, updates and removals and Dependency removals; Fog changes no longer fail that item. Earlier Attempts keep their recorded Scenario version and are not re-judged under the revised check.
- Known failures at release, accepted by Kun on 2026-10-27: with Codex gpt-6-astra, S6, S11, S12, S13, W5, W6 and W6b fail and W3 is flaky (F11 passes 2/2); in the ChatGPT App, S0b, S1, S5 and F11 fail, and the F11 Attempt was influenced by ChatGPT carrying context across chats. There is no 2.x baseline, so these are not measured regressions. Each failing Scenario has its own Issue, listed on [#87](https://github.com/kun-g/wayfinder_map_service/issues/87).

## 2.1.0 (2026-10-26)

- Record private call metadata by default for every local MCP service entry, including reads, refusals, Conflicts and failures. Failed metadata writes preserve business results and expose cumulative missing observations.
- Distinguish the SDK's expected GET stream probe from transport failures, retain HTTP and stale-session/request correlation, and persist missing-observation markers plus shutdown summaries. Observation faults preserve client response bytes; the launcher no longer injects service author configuration into the harness environment and marks unstated usage unknown.
- Record dedicated-agent and ChatGPT launcher correlation using the existing Client ID and per-launch credential fingerprint, with explicit gaps for unavailable native session IDs. MCP instructions, tool metadata, results and workflow rules are unchanged apart from the required Release Version.

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
