# Local MCP and SQLite implementation specification

Status: accepted implementation handoff, explicitly human-confirmed on 2026-09-18. The live user accepted the consolidated specification and six-slice implementation order. This confirms the contract and authorizes implementation Tickets, not actual service acceptance or exploration adoption.

Date: 2026-09-18. Planning Destination: a minimal client-neutral SQLite-backed MCP service whose real Codex acceptance proves the M1 workflow, immutable history, restart persistence and conflicts before new project exploration Maps rely on it.

## 1. Authority and provenance

Use [GLOSSARY.md](../../GLOSSARY.md) for domain language, [M1](m1.md) for unchanged domain behavior and the [v1 contract](v1.md) for the wider product. This document consolidates the human-confirmed local slice, not completion of v1 or M2–M6.

Sections 1–14 record their original slice and acceptance boundaries. The [Answer Desk follow-on in section 15](#15-answer-desk-follow-on-slice), accepted by Kun on 2026-10-26 under [#109](https://github.com/LambdaTheory/wayfinder_map_service/issues/109), amends the tool/protocol/viewer-write boundaries, §6's net-no-op classification and §8/§9 storage and migration rules. Those amendments take effect after #109 closeout and the respective implementation is delivered; they are not claims about the current service.

| Source | Role |
| --- | --- |
| [Codex MCP and SQLite acceptance planning Map](https://github.com/LambdaTheory/wayfinder_map_service/issues/27) | Destination and human-approved slice boundaries |
| [Research Codex connection and SQLite runtime constraints](https://github.com/LambdaTheory/wayfinder_map_service/issues/28#issuecomment-5725823549) | Sourced facts; [immutable research artifact](https://github.com/LambdaTheory/wayfinder_map_service/blob/ae7d1451494d36e0938b5ce103eecc44ddccaafa/docs/research/mcp-sqlite-runtime.md) |
| [Define the headless MCP and service contract](https://github.com/LambdaTheory/wayfinder_map_service/issues/29#issuecomment-5727101846) | Tools, results, access, authorship, lifecycle and failure boundaries |
| [Define the durable SQLite Adapter contract](https://github.com/LambdaTheory/wayfinder_map_service/issues/30#issuecomment-5727392356) | Runtime, storage ownership, initialization, publication, durability and backup; Q10 withdrawn |
| [Define real-MCP acceptance and exploration adoption](https://github.com/LambdaTheory/wayfinder_map_service/issues/31#issuecomment-5728664978) | Automated/live evidence, isolated tests and explicit adoption gate |
| [Synthesize the MCP and SQLite implementation specification](https://github.com/LambdaTheory/wayfinder_map_service/issues/32) | This handoff and its live human confirmation |

Later accepted decisions supersede earlier proposals in research/discussion. In particular, do not restore full write snapshots by default, duplicate JSON text for compatibility, or proactive/per-read integrity audits. Research recommendations are not independently normative choices.

GitHub planning/implementation records are development coordination, not product Map state. After actual acceptance, product MCP owns new exploration Maps; GitHub retains implementation Issues/PRs. Existing rollback/deletion planning Maps remain in GitHub until separately authorized migration. No dual-write or automatic migration.

## 2. Slice boundaries and baseline

Include one manually started local Streamable HTTP service, exactly four headless tools over the real M1 core, durable private SQLite state, explicit initialization, manual consistent local backup, automated integration/protocol checks and a live Codex acceptance gate. All work sessions use the same service-managed canonical database.

Preserve all M1 commands and invariants: one Destination property, ordered atomic batches, Frontier, logical Claims, typed Settlements, explicit reopen, immutable full Revisions and expectedRevision conflicts. Destination is not a Ticket; reopen is not rollback. Content removal is not Ticket/Map deletion.

Exclude public/production deployment, tunnels, OAuth, ChatGPT integration, PostgreSQL implementation, rendering/MCP Apps UI, sharing, export, Recovery Bundle import, rollback, Ticket/Map deletion, owner/workspace state, collaboration/invitations, Claim quotas/leases, automatic retries/merges/takeovers, client caches/refresh/subscriptions, plugin packaging and a general graph API. No periodic/cloud backup or automatic restore.

SQLite supersedes PostgreSQL for this local slice only. [ADR 0001](../adr/0001-remote-map-is-authoritative.md) remains the wider remote-authority direction; loopback acceptance does not deliver its always-on HTTPS deployment. [ADR 0002](../adr/0002-mcp-tools-are-the-primary-interface.md) applies: no UI is necessary to operate the tools. During this slice, an unavailable service pauses authoritative advancement rather than creating an offline replacement; v1's later Recovery Bundle path is not implemented here.

Recorded baseline on main at `522d9b96b6c8a8224a7071576ff8e3c2f953874b`: M1 is delivered, strict TypeScript checking and 1,061 tests passed, with all 56 mandatory acceptance groups traced in [the cumulative matrix](../implementation/m1-acceptance.md). There are no runtime MCP dependencies, SQLite Adapter, start command or connected Wayfinder tools at that baseline. These historical results are not new verification of this slice.

## 3. Identity, validation and authorship

Callers supply stable Map/Ticket/Content/Claimant IDs. Retain M1's complete, case-sensitive `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` grammar; no trimming/normalization, mandatory UUID scheme or global cross-kind uniqueness. Ticket IDs are Map-local; Content IDs are unique across both content sections in their Map. Titles may repeat and are never authoritative handles.

Revision values are positive JavaScript safe integers; no zero, fractional, overflow or reset. Required text is nonblank but retains whitespace; notes may be empty. Retain M1 plain-JSON, namespaced Extensions, typed Settlement and Reference/Provenance constraints. Reject unknown fields and caller-supplied stored/system fields, including author, currentRevision and introducedAtRevision. Public schemas and runtime validation must agree; TypeScript brands alone are insufficient.

The service supplies actorId/clientId from operator-controlled credential configuration and occurredAt from server time. The pure domain still takes explicit MutationAuthor and has no clock/authentication/I/O. Validate that server configuration before serving calls; never accept client-forged authorship.

claimantId is an explicit logical work-session ID on existing M1 commands, not an access token, account or MCP connection. Independent concurrent work sessions use distinct IDs; continued logical work may retain its ID. No independent ClaimId, registry, expiry, quota or implicit disconnect release. Authentication does not turn claimantId into proof of account ownership; preserve M1 matching and deliberate clear-with-reason semantics.

## 4. Public tool inputs

Exactly these tools, without SQL, DB-path selection, PreparedCommit import or an alternate business-command implementation:

```ts
// M1 types and nested command fields are defined in m1.md sections 2–4.
interface MapCreateArgs {
  readonly version: string;
  readonly mapId: MapId;
  readonly title: string;
  readonly destination: string;
  readonly notes?: string;
  readonly extensions?: Extensions;
  readonly includeSnapshot?: boolean;
}
interface MapListArgs {
  readonly limit?: number;
  readonly afterMapId?: MapId;
}
interface MapReadArgs {
  readonly mapId: MapId;
  readonly revision?: RevisionNumber;
}
interface MapApplyArgs {
  readonly version: string;
  readonly mapId: MapId;
  readonly expectedRevision: RevisionNumber;
  readonly commands: NonEmpty<Command>;
  readonly includeSnapshot?: boolean;
}
```

`map_create` maps public mapId to M1 CreateMapInput.id and enriches author. It creates Revision 1, not an empty shell or Revision 0. `map_apply` enriches ApplyRequest.author, validates the entire ordered batch, prepares through M1 and commits through the real Adapter. Preparation alone is never durable success. Preserve whole-shape-before-semantics validation and the second authoritative head comparison at publication.

`version` names the Release Version whose rules the caller follows: the `version:` line of the instructions it was given, or the first line of the workflow Resource it read. A client that shows its model no server instructions (ChatGPT) gets compatibility mode, chosen by the operator per credential (`toolsOnly`): its write tools' `version` parameter description states the release, so the attestation comes from the tool definition it holds. It is checked before any other validation and before storage is observed. A missing value or any other value than the running release returns `{ kind: 'rejected', code: 'version_mismatch', version, rules: 'wayfinder://workflow/exploration' }`, with the claimed value echoed (or null) and nothing written; the result does not name the running version, so the caller learns it only by reading the rules. Reads take no version ([ADR 0005](../adr/0005-writes-attest-the-rules-version.md)).

`includeSnapshot` defaults to false, is boolean, and affects only successful write response size, never mutation semantics. `map_read` defaults to the committed authoritative head observed for the request; historical state requires an explicit revision. A valid nonexistent historical number is revision_not_found, never a fallback to latest. expectedRevision is only a write CAS precondition, not a request to mutate an old historical state.

`map_list` uses ASCII Map ID ascending order. limit defaults to 20 and must be an integer from 1 through 100. afterMapId is a validated lexical boundary; return IDs strictly greater, even if the boundary ID no longer exists or never existed. Each page observes coherent index fields; multiple pages/calls are not a frozen snapshot. Empty lists are normal. No title-based automatic selection or creation.

Outer-service limits: request maximum 1 MiB (1,048,576 bytes), at most 100 commands per apply, at most four concurrent tool calls. Excess is explicitly rejected, not queued for silent retry, split into several commits or coerced. Do not impose these new limits on pure M1 callers.

## 5. Once-only structured results

Declare output schemas and return business results once in structuredContent. Do not serialize the same JSON into a text block. A protocol/SDK-required empty content array is allowed. Actual installed Codex consumption is an acceptance requirement, not an assumption; incompatibility is a blocker, not authority to add a duplicate-text fallback.

Successful structured payloads:

```ts
interface CompactCommit {
  readonly kind: 'committed';
  readonly mapId: MapId;
  readonly revision: RevisionNumber;
  readonly changes: NonEmpty<SemanticChange>;
}
interface SnapshotCommit {
  readonly kind: 'committed';
  readonly revision: Revision; // full M1 record, including state/author/changes
  readonly frontier: readonly TicketId[];
}
interface FoundMap {
  readonly kind: 'found';
  readonly revision: Revision;
  readonly frontier: readonly TicketId[];
}
interface MapIndex {
  readonly mapId: MapId;
  readonly title: string;
  readonly destination: string;
  readonly currentRevision: RevisionNumber;
}
interface ListedMaps {
  readonly kind: 'listed';
  readonly maps: readonly MapIndex[];
  readonly nextAfterMapId: MapId | null;
}
```

| Tool/switch | Success payload |
| --- | --- |
| map_create/map_apply, flag omitted or false | CompactCommit: no full graph or Frontier |
| map_create/map_apply, flag true | SnapshotCommit: no separate duplicate compact receipt |
| map_read | FoundMap for the selected full Revision |
| map_list | ListedMaps; nextAfterMapId is the last returned ID if more entries exist, otherwise null |

The write output schema must distinguish revision-number and revision-object variants without adding another payload. SemanticChange preserves M1's commandIndex, command, subjectId and required reason; summaries are not transcript/replay instructions. A write returns its exact committed Revision, even if a later operation advances head before the response arrives. Every returned Frontier derives from that same Revision's state.

All Revisions retain mapId/revision/priorRevision/kind/author/changes/full state. Historical Claims and Settlement introducedAtRevision survive; historical reads do not restore them. No all-history dump, automatic refresh or independently persisted Frontier.

## 6. Error and uncertain-outcome boundaries

Preserve the structured M1 ReadResult, PrepareResult, CommitResult and Rejection/Conflict information from [M1 sections 5–7](m1.md): input code/path/constraint, rejection stage, commandIndex, operation code, relevant IDs and expected/current conflict heads. Paths identify the submitted public object (including the public mapId name), not hidden server author fields. Deterministic prose/helper names are reversible choices; do not reduce structured errors to generic text or invent business errors for infrastructure failures.

| Class | Required treatment |
| --- | --- |
| Argument validation, business rejection, missing object, stale Revision, rules from another release (`version_mismatch`) | Ordinary structured tool result with no `isError`; preserve applicable M1 fields/codes so clients do not collapse the domain result into a generic runtime exception |
| Unknown tool or malformed protocol request | Protocol error, not a fabricated domain rejection |
| Storage/transport/service failure | Distinct infrastructure diagnosis with `isError: true`; safe fields only, not SQL, private paths or credentials |
| Proven non-publication | State/history unchanged; do not label uncertain outcomes as this class |
| Commit/response interruption with unproven outcome | Unknown outcome; authoritative reread before any decision, no automatic replay |

Known rejects, conflicts and net-no-ops publish no Revision; the Answer Desk follow-on amends the no-net-change classification through its [agent request-closing contract](answer-desk.md#81-revision-boundary-and-adapters). Storage-busy is not proof of stale head and must not become Conflict. Unexpected infrastructure/programming failures remain Promise failures at the StateAdapter seam, safely mapped by MCP without changing the pure library's result unions.

Attempt transaction cleanup. If the connection cannot return to usable state, stop DB operations and require restart. A missing/failed response never alone proves no publication. Reread current/history, decide whether the intention is already satisfied, and seek human judgment if evidence cannot resolve uncertainty. No automatic retry, rebase, merge, idempotency cache, Claim takeover or memory fallback. A lost connection cannot necessarily deliver an error envelope; client/workflow handling must still retain this rule.

## 7. Local service access and lifecycle

One independent manually started Streamable HTTP process owns the configured DB and serves sessions at a configured fixed port and `/mcp`. Bind only `127.0.0.1`; no public listener, daemon/auto-start, client-launched process, STDIO bridge or automatic port substitution. Closing a conversation does not stop the service.

Require a local access token, restrict Host to the configured local address and validate Origin. Missing Origin is allowed for an authenticated client; a present Origin must match an explicitly permitted local source, not an arbitrary website. Loopback alone is not authorization. Keep secrets out of repository, Map content, logs, reports and public errors.

Validate port, credential/author configuration, supported application format and DB readiness before admitting calls. Port occupancy is visible startup failure. Graceful stop rejects new calls, completes active work and closes storage. Forced termination retains unknown-receipt semantics. No connection identity controls Claim lifetime.

Pin a supported MCP SDK and its installed dependency versions, record the protocol/client versions actually exercised, and verify real Codex interoperability. Research describes available SDKs, not a guaranteed installed-client match. SDK wiring and supported-version declarations are implementation choices within this contract; an incompatible client requiring a changed result/transport contract must return to the human, not trigger an unapproved compatibility bridge.

Logs may record safe request identifiers, operation names, timing and actor; omit decision/evidence bodies, credential material, SQL and private filesystem paths. No new audit infrastructure is required.

## 8. SQLite ownership and explicit initialization

Pin Node 26.3.0 and use built-in node:sqlite, with its researched release-candidate interface status explicitly human-accepted. Record the actual embedded SQLite version in verification; this host's researched version was 3.53.2. No fallback driver, Worker or connection pool. Promise-shaped Adapter methods do not make synchronous SQLite nonblocking.

Use one operator-configured absolute private canonical path on local disk, outside repositories, disposable worktrees and temporary directories. Example, not a file already created: `/Users/kun/Library/Application Support/Wayfinder/maps.sqlite`. All sessions reach this DB through the service, never caller-selected paths/SQL. No network/shared filesystem; reject symlinks in the DB path. Newly created private directories use 0700 and DB/backup files 0600. Reject unsafe existing ownership/permissions rather than silently chmodding user data. Treat WAL/sidecars as managed persistent state, not expendable cache.

Provide explicit first-use initialization to a nonexistent fresh target only. Refuse any existing target, including an empty file; never overwrite. Initialize application identity and initial format version with the schema; the Answer Desk follow-on specifies its [fresh initialization format](answer-desk.md#82-format-2-and-startup-migration). Exact identity constant/table names are implementation choices fixed and tested for this first format.

Normal startup opens existing storage only and recognizes its application/format identity, not just its filename. Wrong/missing paths, unsupported format and ordinary open/read/write/JSON-decoding failures are explicit errors. No automatic initialization, empty replacement, reset, repair, overwrite or migration. Support this initial format only. The accepted Answer Desk follow-on explicitly replaces this restriction for its format-2 startup migration; see [§15.3](#153-tasks-storage-and-failure).

**Withdrawn Q10 remains excluded:** no startup physical/data integrity audit, full-history scan, proactive semantic graph inspection, replacement per-read audit or mandatory integrity maintenance command. Ordinary application-format recognition and I/O/SQL/JSON failures are not permission to reintroduce those features. Existing M1 validation of a submitted mutation and its final graph remains unchanged; detecting damage is not claimed to restore it.

## 9. Persisted representation and publication

Principally two tables: Map catalog/head (ID, title, Destination, current Revision), and immutable full Revision JSON unique by Map ID/revision. Preserve every accepted full Revision, including authorship, prior links, changes, Claims and Settlement introduction context. No pruning, command replay or separate graph entity tables. The Answer Desk table and publication amendments are scoped by [§15.3](#153-tasks-storage-and-failure); the original two-table boundary does not forbid that accepted follow-on.

Keep StateAdapter's three operations unchanged: readCurrent, readRevision, commit. The original slice adds only a narrow listMaps read on the SQLite module for MCP listing, without expanding the public StateAdapter, memory Adapter sharing or tool count. The accepted Answer Desk follow-on adds the desk-side paths scoped by [§15.3](#153-tasks-storage-and-failure); listMaps is not a restriction on those paths. Narrow local initialization/backup/open/close management is not a public MCP mutation path.

Use one synchronous connection and short operations. Explicitly configure and verify WAL, synchronous=FULL and 100 ms SQLite lock waiting. The wait budget is not an end-to-end latency guarantee; synchronous work can block the execution thread.

For commit:

1. Defensively capture prepared input before any asynchronous yield; retain internal identity/kind/prior/next-number coherence checks and detached values. Only pure preparation mints PreparedCommit; it is not JSON import or an authentication mechanism.
2. Start a short BEGIN IMMEDIATE transaction. No await/network operation inside it.
3. Under the write transaction, check absence for create, or existence and authoritative prior head for apply. Duplicate create returns map_already_exists; missing apply returns map_not_found; known mismatch returns Conflict with actual head, without publication.
4. Insert full new Revision and publish catalog/head together; commit once. No observable partial commands, orphan history, overwritten prior Revision or losing proposal.
5. Return the captured exact committed record and its Frontier, not a later head reread. Capture work needed for the return before reporting success; clean up failures without asserting rollback of an already durable commit.

Same-head writers publish at most one success. Independent Maps retain isolated contents and revision sequences starting at 1. No writable aliases from requests/prepared data/stored history/outputs. Busy timeout is separate infrastructure failure, never an automatic resubmission. Stop DB operations if cleanup cannot restore a usable connection.

For current full reads, observe head N, then fetch immutable Revision N and derive Frontier from its state. A later commit does not change N; explicit history stays pinned. Catalog page fields are coherent for that page; separate calls/pages are not a snapshot. No Agent-specific cache or promise that an earlier response remains latest after later writes.

Restart preserves head, all history and Claims. It creates no Revision, reacquires no Claim and grants no expiry/takeover. Graceful restart/process-kill evidence is not proof of hardware/power-loss resilience.

## 10. Manual consistent backup

Provide one explicit local maintenance backup command, not a fifth MCP tool. Use SQLite's consistent backup mechanism to a fresh independent destination, never the active DB or an existing target. Raw copying a live main DB file is not a valid backup method. Apply private path/permission handling and keep secrets/private paths out of public diagnostics.

Report success only after completion checks; partial artifacts are not successful backups. Backup changes no Map Revision or Claim and automatically removes no older backups. Completion checks do not scan/audit source history. Opening a backup independently and comparing known acceptance fixtures is test evidence, not a restore/import feature. No periodic/cloud backup, automatic restore or Recovery Bundle import.

## 11. Required automated evidence

Run strict checking and all existing M1 scenarios; keep the pure/memory suite intact. Reuse real-Adapter behavioral scenarios where applicable for SQLite, with explicit durable-instance cases instead of M1 S03's memory-only volatility. Do not rerun the pure Frontier enumeration separately per storage implementation solely to duplicate an unchanged algorithm. No arbitrary coverage percentage/test count substitutes for branch assertions.

Use real M1, SQLite and HTTP tool paths. Fresh clearly named acceptance Maps and disposable test DBs/ports/credentials isolate faults from actual project state. Temporary test DBs are not canonical deployment storage. Test-only faults/secondary contention connections are not public tools or a production connection pool.

For known rejects/conflicts/proven pre-publication failures, compare complete current state and every known earlier Revision before/after, verify proposed-next absence, and verify unrelated Maps unchanged. For post-commit response loss, assert actual stored outcome separately and do not apply a false no-publication expectation. Reads over known fixture history are not a production integrity-audit feature.

| ID | Executable scenario and required observations |
| --- | --- |
| A01 | Strict TypeScript and all 56 M1 groups retain branch assertions, compile fixtures and the existing real memory Adapter behavior. |
| D01 | Explicit fresh initialization; existing empty/nonempty targets refused without overwrite; normal open refuses missing/wrong/unsupported format without replacement. |
| D02 | Private path/ownership/mode and symlink rejection; no caller SQL/path access; configured WAL/FULL/100 ms verified and sidecars retained through managed lifecycle. |
| D03 | Real create/apply/read full Revision round-trip: contiguous prior links, exact author/changes/state/Claim/Settlement introduction metadata, independent Map sequences. |
| D04 | Same-head prepared writers and duplicate creates: exactly one publication and appropriate losing Conflict/duplicate, immutable prior history. Independent heads may both succeed. |
| D05 | Stale, missing, malformed, lifecycle, dependency, Claim, invariant and no-op branches retain applicable M1 error locations and non-effects through real storage/tools. |
| D06 | Failure after transactional work but before publication rolls back head/history/catalog together; next valid operation remains possible when cleanup succeeds. |
| D07 | A second test connection holds the write lock: bounded busy failure, not fabricated Conflict; no publication/automatic retry; normal use resumes after release. |
| D08 | Inputs/results/prepared values have no writable storage aliases; capture-before-yield and malformed internal-envelope programming failure retain M1 guarantees. |
| D09 | Pinned current N/full Revision/Frontier coherence during subsequent writes; old history stable and missing historical version errors without latest fallback. |
| D10 | Graceful service stop/restart, forced termination and new connection retain accepted head/history/Claims without added Revision or implicit Claim release. Interrupted transactions never expose partial state. |
| D11 | Commit succeeds but response is lost: durable new Revision exists, receipt remains unknown until reread; no automatic replay or assertion that missing response means no change. |
| D12 | Cleanup that cannot restore a usable connection stops DB operations until restart; no silent memory fallback or continued mutation. |
| D13 | Real consistent backup opens independently with matching known snapshots/Claims; source unchanged; existing/active targets refused, partial result not success. |
| P01 | Exactly five tools with matching declared schemas (Answer Desk §9); unknown/system fields rejected; actual M1 command union rather than copied Demo logic. |
| P02 | Compact defaults and opt-in snapshot variants match output schemas, exact committed version/Frontier, once-only structuredContent and no duplicate text. |
| P03 | Current versus explicit history, service-returned revision values, distinct validation/not-found/conflict results and no all-history dump. |
| P04 | ASCII keyset listing, default/boundary limits, nonexistent cursor boundary, more/end cursor, coherent pages, empty catalog and duplicate titles. |
| P05 | Argument/business errors use tool errors; malformed protocol/unknown tools use protocol errors; safe infrastructure distinction, input paths and commandIndex retained. |
| P06 | Request 1 MiB, batch 100 and concurrency four limits: boundary/excess checks, explicit refusal, no silent splitting/coercion/retry or added M1 limits. |
| P07 | Loopback binding, required token, configured Host and absent/allowed/forbidden Origin branches; callers cannot forge actor/client/time or author configuration. |
| P08 | Fixed-port/config/storage readiness startup failures are visible; conversation close leaves service alive; graceful shutdown stops admission and completes active work. |
| P09 | Errors/logs/report fixtures expose no credentials, SQL, private paths or decision/evidence bodies; unavailable service/storage never silently substitutes another authority. |

Each listed branch needs an assertion. Tests that intentionally interrupt a process must control the relevant publication boundary; sleeps or prescribed race winners are not evidence. Safety checks exercise ordinary failures/format recognition, not withdrawn full-history/proactive corruption auditing. Exact shell scripts, helper names and dependency installation checks belong to implementation and must be recorded with actual outcomes.

## 12. Live Codex evidence and adoption gate

Automated passing results do not prove installed-client interoperability. Complete these steps in actual Codex with the implemented service and isolated acceptance storage, not browser automation or a page Demo:

| ID | Live evidence |
| --- | --- |
| L01 | Connect/discover the five tools and consume declared structured results correctly; record installed client, server commit/runtime/SDK/protocol environment. |
| L02 | Create Map/Destination; add prerequisite/dependent Tickets and Dependency, Fog and Scope Exclusion; observe Frontier; Claim and settle prerequisite, observe dependent unlock; Claim/settle dependent; explicitly reopen both and inspect earlier Claims/Settlements/history. |
| L03 | Session B independently discovers A's Map via catalog and stable ID, reads current state and continues with its distinct logical Claimant. No ambiguous-title selection or replacement Map. |
| L04 | A's stale expectedRevision after B advances produces Conflict/no publication; A rereads the latest observed head. Reconnect/new session retains history/Claims with no expiry/takeover. |
| L05 | Human explicitly accepts the real workflow after required automated evidence and any blockers are resolved; no unit-count, screenshot or planning confirmation substitute. |

Keep a reproducible report (suggested path `docs/implementation/mcp-sqlite-acceptance.md`) with exact commit/environment, commands and results, isolated setup, live operations/outcomes and human verdict. Distinguish pass/fail/not-run and historical M1 results from current evidence. Keep secrets and private paths out of published reports; public configuration examples are not live credentials.

Only after L05 and all required gates may new exploration Maps adopt MCP as sole authority. Narrowly adapt create/find/resume/advance: retain a stable Map handle, discover via catalog when needed, default-read on resumption, successfully Claim before work, settle with a live human verdict when the method requires one, and use returned expected revisions. Reread conflicts/uncertain writes before deciding; minimize routine reads by retaining known context without treating it as authoritative after resumption/uncertainty.

No tracker switch during bootstrap planning or merely because tools start responding. Implementation Issues/PRs stay in GitHub; existing rollback/deletion Maps remain untouched. Service outage pauses authoritative advancement, with no silent memory/local/GitHub replacement. Incompatibility or unexpected persistence findings block the affected gate; any changed contract returns to the human.

## 13. Implementation slices and completion

The human has confirmed this handoff and its six-slice order. Create specified GitHub implementation Issues with native dependencies and scoped acceptance references. Ticket boundaries remain reversible implementation organization, not new product semantics:

| Order | Implementation Ticket | Prerequisite | Required evidence |
| --- | --- | --- | --- |
| 1 | Private SQLite initialization and durable Revision Adapter | Confirmed handoff | Runtime pin, initialization/open, representation, CAS/history/isolation, conformance; A01, D01–D06, D08–D09 |
| 2 | SQLite restart, failure and manual backup guarantees | Slice 1 | Busy/cleanup, controlled termination, unknown receipt groundwork, consistent backup; D07, D10–D13 |
| 3 | Four headless MCP tools over the real M1 core | Slice 1 | Input/output schemas, current/history/catalog, server author enrichment, compact results and errors; P01–P05 |
| 4 | Independent loopback service lifecycle and access boundaries | Slices 2 and 3 | Startup/config/auth/Host/Origin, limits/shutdown, HTTP integration and response-loss evidence; P06–P09 and end-to-end D10–D12 |
| 5 | Automated integration closeout and real Codex acceptance | Slice 4 | All A/D/P branches, L01–L05, reproducible report and explicit human verdict |
| 6 | Narrow exploration workflow adoption | Slice 5 plus its live verdict | Minimal workflow changes, new Map create/find/resume/advance proof, no old-Map migration/dual authority or plugin expansion |

Slices 2 and 3 may proceed independently after slice 1. Adapter-process termination tests in slice 2 are completed through the actual HTTP service in slices 4–5, not falsely reported as service/client acceptance. Workflow adoption is gated, not bundled into the first implementation slice.

Preserve strict TypeScript/ESM/Vitest, pure module boundaries, all M1 regression assertions, Standards/Spec review and conflict checks. Do not monitor, wait for or use CodeRabbit as an agent gate; this does not authorize bypassing repository-required checks. Runtime pins, lockfile, exact supported SDK installation/wiring, schema constants, reversible module layout and test helpers can be settled during implementation within the confirmed contract. Do not choose a second driver, add a compatibility bridge or weaken a gate to work around a failure silently.

Specification handoff completion requires explicit human confirmation, publication of this accepted document and recorded resolution/index links before the synthesis Ticket and parent close. Feature completion requires actual implementation and the automated/live gates; adoption completion additionally requires slice 6 evidence. None of these states implies full v1 delivery.

At specification publication, implementation and live acceptance remain unperformed. Synthesis changes documentation and development-tracker records only: no dependencies, runtime pins, source code, MCP settings, database, server, backup, workflow skills or existing product Maps were changed; no M1/integration/live acceptance tests were run as part of synthesis.

## 14. Post-adoption self-contained workflow publication

Status: accepted follow-on slice, human-confirmed on 2026-09-19 after the original six slices and exploration adoption were completed. The accepted product Map is `Wayfinder.McpSelfContained`, current planning closeout Revision 12. This section is additive: it does not rewrite the original handoff's exclusions, implementation order or historical acceptance claims. It authorizes a later implementation Issue for workflow publication and cross-client acceptance.

### 14.1 Boundary and compatibility

Retain exactly `map_create`, `map_list`, `map_read` and `map_apply` as the only business tools. Their input/output schemas, M1 commands, SQLite representation, HTTP authentication, admission limits and once-only structured results remain unchanged. Do not add a `workflow_get` tool or workflow/version fields to Map tool payloads.

A fully compatible client must make initialization `instructions` and tool metadata available to the model. Merely connecting to and calling tools is protocol connectivity, not proof of the complete Wayfinder workflow. Generic MCP Resources and Prompts are optional affordances: their absence in a particular client is recorded accurately but does not make the core workflow fail.

This follow-on slice includes an isolated ChatGPT Desktop acceptance through the account-synchronized remote plugin/developer-mode connector also visible on the web surface. A separate persistent Codex-host configuration regression is not required: independent installed Codex CLI sessions already exercise the same server workflow, while host configuration persistence adds no server self-containment evidence. This does not claim that the synchronized remote connector and Codex-host configuration are the same technical path. The slice does not deliver marketplace distribution, general plugin packaging, OAuth, a production tunnel or deployment. Any public test relay remains a foreground, explicitly test-only operator facility with its separately documented access limitations.

### 14.2 Authoritative workflow and generated surfaces

`docs/agents/exploration-mcp.md` is the sole authored workflow source. It carries no version of its own (see 14.3) and stable named blocks from which the build deterministically derives all runtime guidance:

- Initialization `instructions` begin with an independently complete safety core no longer than 512 characters. It states the sole-authority/outage boundary, full catalog check and create-once rule, authoritative reread after resumption/uncertainty, Frontier/Claim gate, latest-revision/no-replay rule, the post-Conflict human reauthorization gate and live-human Settlement boundary. A concise method summary follows it.
- Each of the five tool descriptions is locally sufficient for its operation. `map_list` requires full pagination before creation and rejects title-as-handle selection; `map_create` is create-once and uncertain results require discovery/reread; `map_read` is the authority after resumption, conflict and uncertainty; `map_apply` states latest `expectedRevision`, Claim/Settlement boundaries, and that a Conflict voids the old request until the human sees the new Revision and issues a new request.
- The complete authoritative Markdown, preceded by a `version: <version>` line, is exposed at stable URI `wayfinder://workflow/exploration` and a current-build immutable SemVer alias (for example `wayfinder://workflow/exploration/2.0.0`) with a Markdown media type. The service need not retain older workflow bodies.
- The optional `start_wayfinder_exploration` Prompt accepts `mode=create|resume` and an optional stable Map ID. It only produces an entry message, has no storage side effect and contains no safety rule absent from instructions/tool metadata.
- An optional external Wayfinder Skill is an invocation/method adapter only. It must not require a repository-relative file, duplicate the workflow body or become necessary for correct operation.

A rule that changes what a caller writes lives in both the instructions and the description of every tool it governs. After an upgrade some clients keep a tool definition they loaded earlier while showing the new instructions, and ChatGPT shows its model the tool definitions only ([Open conversations across an upgrade](../implementation/client-upgrade.md)). Tool descriptions own how to call their tool.

Answer Desk rules follow [Answer Desk §6](answer-desk.md#6-client-paths-and-protocol-state): `map_apply` carries all-askable posting, triage and verdict guards; `map_read` carries turn-start taking; `map_wait` carries blocking/task scheduling and the bounded-read alternative. All five descriptions are extracted from the same authored source.

Protocol-level text is English; clients may answer users in their language. Resource and Prompt support never substitutes for initialization instructions and locally sufficient tool metadata.

### 14.3 Versioning, build and release

The service and the workflow it carries share one SemVer, the Release Version, with its release base held in `package.json` ([ADR 0004](../adr/0004-one-release-version.md)); do not call it a Map Revision. It started at `1.0.1` on 2026-10-25. Kun revised the version policy on 2026-10-28: ordinary PRs keep the package version; a release raises it once for the largest change accumulated since the last release tag:

- **Major** for incompatible changes to tools, schemas, Map state, HTTP interfaces or storage formats.
- **Minor** for rule changes (including mandatory rules), new capabilities and other compatible behavior changes.
- **Patch** for fixes, editorial, example or reference changes that preserve behavior.

Rule changes are minor because writes must attest the exact running Release Version ([ADR 0005](../adr/0005-writes-attest-the-rules-version.md)): every release blocks callers holding old rules, and raising a different SemVer part adds no protection. Published numbers stay unchanged. Under this rule the one-way format-2 migration shipped in 3.2.0 would have required a major; the next rule change after 5.0.0 releases as 5.1.0 unless the train also contains an incompatible change.

Shipped means `src/`, `web/`, `scripts/`, `package-lock.json` and `docs/agents/exploration-mcp.md`. Each shipped change adds a nonempty bullet under `CHANGELOG.md` → `## Unreleased`, identifying its major/minor/patch impact; documentation- and test-only changes need no release entry. Ordinary PRs change neither package version nor tags. The coordinator releases at most once per Asia/Singapore calendar day, or on Kun's request: raise `package.json` and both root versions in `package-lock.json`, move the pending entries into `## <version> (<date>)`, leave an empty `## Unreleased`, and tag the merged release commit on `main` as `v<version>`. Never decrease or reuse a published Release Version, including when restoring earlier behavior. The [release procedure](../implementation/releases.md) assigns the steps and checks; releasing does not authorize an everyday service upgrade.

Only a clean build whose HEAD carries the matching `v<package version>` tag reports the bare release number. Every other Git build reports `<package version>+dev.<commit prefix>`; when tracked or non-ignored untracked files differ it reports `<package version>+dev.d<content hash>` instead. The suffix fits the existing 32-character tool field (22 commit hex characters or `d` plus 21 hash hex characters at 5.0.0), retaining at least 64 hash bits or refusing the build. The hash includes HEAD and the tracked diff and untracked contents, distinguishing successive working copies at the same HEAD. If Git provenance cannot be established, the build fails rather than reporting a published number. The complete string is the Release Version for all surfaces and exact write attestation; SemVer precedence (which ignores build metadata) is never used for that equality check. This keeps development and behavior tests usable while preventing unpublished rules from accepting a published version. Built assets retain their captured identity when run without Git or repository sources.

Before 2026-10-25 only the workflow had a version, `workflowVersion`, while the server reported a fixed `0.1.0`. The workflow's initial test publication was `1.0.0`; `1.1.0` added complete-command guidance after real Codex exposed partial validation probing; `1.2.0` made nested Reference/Provenance/Evidence shapes explicit; `2.0.0` changed mandatory Conflict behavior after a real ChatGPT run reread a newer Revision but automatically resubmitted the stale intention: a Conflict now voids the rejected request and requires the client to report and stop until the human issues a new request after seeing the new Revision. Later steps through `3.0.0` are in `CHANGELOG.md`. Those numbers overlap the Release Version series; the names `workflowVersion` and `version` keep them apart.

An upgrade is a process restart onto the new build; the service never swaps definitions inside a running process, so it declares no `listChanged` capability and offers no stream for definition-change notifications. For sessionful clients (`2025-11-25` in the [Answer Desk compatibility matrix](#152-sdk-v2-and-two-protocol-eras)), a restart ends every session: a request carrying an old `mcp-session-id` gets HTTP 404 and the client must initialize again, receiving the new instructions, tool list, Resource and Prompt. What a client then shows its model is the client's choice, and some keep the definitions they loaded first; the write `version` check (section 4) stops such a caller before it writes under old rules. Client behavior and recovery steps are in [Open conversations across an upgrade](../implementation/client-upgrade.md).

The SDK v2 follow-on slice also serves `2026-07-28` clients, which are sessionless: there is no `mcp-session-id` to invalidate, so restart cannot force them through the 404/reinitialize path. Their requests reach a fresh server instance without implying that the model rediscovered instructions or tools. [ADR 0005](../adr/0005-writes-attest-the-rules-version.md)'s `version` attestation remains the write guard in both eras; neither successful transport access nor a task handle attests the rules. Section 15 applies this guard to `map_wait` and the taking form of `map_read` as well. Process-lifetime workflow immutability applies to both eras, not just legacy sessions.

The build extracts and validates the named blocks and emits an immutable asset into `dist`; generated runtime copies are not committed. The service must run from built artifacts without the repository source path and captures one workflow contract for the process lifetime. Workflow changes require rebuild and restart; there is no hot reload or list-changed promise. A new connection receives the new instructions, Resources must be reread, and ChatGPT plugin snapshots follow their own rescan/republication lifecycle.

Build/check gates reject invalid SemVer, a version written into the workflow source, shipped changes since the last release tag without a nonempty Unreleased entry, and release commits (package version higher than that tag) without a new version section or with pending Unreleased content. They also reject missing/duplicate/out-of-order blocks, a safety core over 512 characters, any business tool set other than the accepted five (§15.1), a Prompt with side effects or unique safety rules, Resource/source divergence, version decrease/reuse and runtime source-path dependence. A failed workflow build never falls back to stale guidance. Development build metadata identifies an unpublished build; it is not a second version series.

Expose the same complete version as MCP `serverInfo.version`, as `version: <version>` after the safety core in initialization instructions, in Resource metadata and body, in Prompt output, in fixed safe readiness output, in `wayfinder status` and in acceptance evidence. Test seeds use the service's actual reported version. Do not expose workflow bodies, private paths, credentials or Map content in logs. The project root `CHANGELOG.md` is the single release log, one section per release plus Unreleased, and names each workflow behavior and compatibility change; the authoritative workflow file contains no separate changelog.

### 14.4 Automated acceptance

Preserve A01, D01–D13 and P01–P09. Add executable assertions for:

- deterministic extraction, exact current workflow SemVer, named-block validation and all build refusal branches;
- exact initialization instructions and declared capabilities through in-process SDK and real Streamable HTTP;
- `tools/list` returning exactly the five accepted tools with the generated local descriptions;
- stable/versioned Resource equality with the complete authoritative Markdown and process-lifetime immutability;
- Prompt `create`/`resume`/optional-ID branches and zero storage effects;
- fixed safe readiness version, reconnect/restart behavior and no source-path runtime dependency;
- instructions that make the stale request void and require a post-reread human request after Conflict, while retaining no-retry/no-fallback behavior across proven non-publication, unknown outcome, lost receipt, busy and stopping scenarios.

Protocol SDK tests must cover Resources and Prompts even when a real target client does not expose them. Existing storage, domain, HTTP security, limit, shutdown and failure tests remain regression gates rather than duplicated workflow tests.

### 14.5 Real cross-client and human gate

Use one fresh private database and one shared acceptance Map. Do not install/inject the Wayfinder Skill, `AGENTS.md`, this repository's workflow document or copied tool-order/safety text. Preserve every attempt and failure in evidence; manual repair calls cannot turn a failed product behavior into a pass.

1. ChatGPT Desktop, through the actual account-synchronized remote MCP plugin/developer-mode surface, pages the complete catalog, creates the Map once and atomically publishes Tickets, Dependencies, Fog and Scope Exclusions. The synchronized web surface need not repeat the same journey solely for sampling.
2. An independent installed Codex CLI session discovers the same stable Map, default-reads it, Claims a Frontier AFK Ticket and writes a type-correct Finding or Completion.
3. The original ChatGPT session makes one intentional stale write, receives Conflict, rereads, reports the new Revision and stops. It makes no later write unless the human issues a new request after seeing that Revision; the stale instruction cannot pre-authorize a retry, merge, takeover or replacement Map.
4. One HITL Ticket remains unsettled before the live user's verdict and receives a Decision/rationale only after that verdict.
5. During service unavailability the affected client stops with no file, conversation, GitHub or alternate authority; after restart new sessions confirm the same Revision, history and Claims. Controlled unknown-outcome/lost-receipt/busy/stopping boundaries remain automated HTTP evidence rather than destructive live-client exercises.
6. Resources and Prompts are reported per exercised client as `available`, `unavailable` or `undocumented`; unavailable/undocumented optional surfaces do not fail the core gate and must not be reported as supported. The distinct persistent Codex-host configuration path is explicitly not applicable to this slice and is not reported as exercised.

One complete journey is sufficient; it naturally uses multiple independent sessions but need not be repeated solely for sampling. Retain native initialize protocol/instructions/capabilities and the version, client/server/runtime versions, session identities, tool parameters/results, database Revision/Frontier/Claim/Settlement/history comparisons, failed attempts and redaction checks. Agent prose or screenshots alone are not evidence.

Publish a new implementation report and machine-readable evidence without rewriting `mcp-sqlite-acceptance.md`, `mcp-exploration-adoption.md` or their evidence. After all automated and real-client gates pass, the live user must explicitly accept the evidence. Only that verdict completes this follow-on slice and authorizes README/release claims of the accepted self-contained workflow version.

## 15. Answer Desk follow-on slice

Status: accepted by Kun on 2026-10-26 under [#109](https://github.com/LambdaTheory/wayfinder_map_service/issues/109); the design session checks the transcription before Issue closeout. This amends the tool, protocol and viewer-write boundaries, §6's net-no-op classification and §8/§9 storage/migration rules, after #109 closes and the respective implementation is delivered. Original acceptance evidence remains historical evidence.

The [Answer Desk specification](answer-desk.md) is the single normative source for desk behavior. [ADR 0006](../adr/0006-answer-desk-in-the-map-viewer.md) and [ADR 0007](../adr/0007-map-wait-for-answer-delivery.md) record the architectural alternatives.

### 15.1 Tools and workflow publication

The [five-tool target](answer-desk.md#1-outcome-and-boundary) extends §4/§5 through the [public inputs](answer-desk.md#61-public-inputs) and [results/read projections](answer-desk.md#62-public-results-and-recovery-reads), including `map_wait`, taking `map_read` and `FoundMap.reopenContexts`. The latter supplies the agent's default re-post recommendation and the desk's requested-option marker/text context under that normative projection contract. The [typed `deskAnswer` extension](answer-desk.md#agent-settlement) amends `ticket.settle`; [Reopen Requests](answer-desk.md#reopen-requests) define `map_apply.reopenRequestId`, its Settlement binding and validation, and `reopenRequest.close`. The [publication-after-reopening contract](answer-desk.md#publication-after-reopening) amends every reopen path. These are additive contract extensions, not changes to M1 Provenance or Reference shapes.

Implementation updates exact-tool-set checks in §11 and §14 to the target at the step assigned in [Answer Desk §9](answer-desk.md#9-implementation-and-release-sequence). Preserve once-only results, immutable history, safe errors and unknown-outcome recovery; descriptions and annotations must match actual effects, including reads that take answers. Backup stays a local maintenance command.

#114 updates the sole authored workflow and every governed tool description together, with generated Resources, Prompt and instructions retaining the process's one Release Version. The original #109 specification PR changed none of those shipped surfaces; #114 publishes them as 4.0.0.

### 15.2 SDK v2 and two protocol eras

Migrate the pinned SDK v1 package to SDK v2's `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, with exact installed versions recorded by #110. SDK v2 needs explicit modern-protocol configuration; installing it alone does not enable `2026-07-28` ([official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)).

| Contract | `2025-11-25` | `2026-07-28` |
| --- | --- | --- |
| Connection | `initialize`, sessionful Streamable HTTP | `server/discover`, per-request metadata and no MCP session |
| Restart | Old `mcp-session-id` returns 404; client initializes again | No session header or restart-404 refresh path |
| Answer wait | Ordinary blocking `map_wait`; the tested Codex client did not see task tools | Opted-in Tasks extension for Claude Code; ordinary calls still need a non-task result |
| Workflow guard | Explicit write `version` | The same explicit write `version`; transport success does not refresh model context |

Observed client eras (#110 records exact versions): Codex 0.164.0 negotiates `2025-11-25`; Claude Code 2.1.310 uses `2026-07-28` for tasks; ChatGPT App 26.1016 opened with `server/discover` (`2026-07-28`) and was observed falling back to `initialize` (`2025-11-25`) after HTTP 400 / `-32000` (#80, PR #126). Serving the modern era enables ChatGPT's sessionless path at #110's release when its requests carry the required `MCP-Protocol-Version` and `Mcp-Method` headers, plus `Mcp-Name` for `tools/call`, `prompts/get`, `resources/read` and the Answer Desk extension methods `tasks/get`, `tasks/update` and `tasks/cancel`. Missing required headers now return HTTP 400 / `-32020`; ChatGPT fallback on that response is unverified. Actual headers, selected era and fallback behavior are observed at the #114 run. ChatGPT's `toolsOnly` attestation and the write `version` guard are unchanged in either era.

Both eras share `/mcp`, operator-controlled credential identity, the process's immutable workflow, Map authority and existing Host/Origin protections. Preserve instructions, Resource and Prompt delivery in the appropriate era and record the actual capabilities each installed client exposes. Do not add STDIO/channel bridges, per-client databases, OAuth or automatic Claim expiry. A protocol session remains distinct from the logical Claimant.

### 15.3 Tasks, storage and failure

Implement the [Tasks, admission and shutdown contract](answer-desk.md#63-tasks-admission-and-shutdown) and [release boundary](answer-desk.md#agent-delivery). The upstream [Tasks server implementation issue](https://github.com/modelcontextprotocol/ext-tasks/issues/30) was open when checked on 2026-10-26; #112 identifies server-everything 2.0.1's `dist/server/tasks.js` as a reference, not a supplied SDK implementation.

[Answer Desk §8.1](answer-desk.md#81-revision-boundary-and-adapters) defines which writes create Revisions, the request-closing amendment to §6 and M1's no-net-change check, the retained StateAdapter seam and the desk-side paths outside it. [Section 8.2](answer-desk.md#82-format-2-and-startup-migration) is the authoritative format-2 schema and backup-before-migration rule, expressly amending §8's initial-format/no-migration restriction and §9's representation. Migration and desk persistence must not be inferred from the task registry's lifetime.

### 15.4 Verification and release boundary

Keep existing domain/storage/protocol gates and add the [Answer Desk acceptance evidence](answer-desk.md#83-required-evidence). Its [Issue ownership and release sequence](answer-desk.md#9-implementation-and-release-sequence) assigns storage, taking reads, Reopen Requests and the keyed viewer route, while distinguishing specification acceptance from implementation and live-client acceptance. The #108 spikes establish feasibility only. Section 14.3 still determines the Release Version from shipped behavior; the original #109 documentation-only PR needed no bump, CHANGELOG entry or tag; #114 ships the mandatory workflow as 4.0.0.
