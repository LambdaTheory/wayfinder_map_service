---
workflowVersion: 2.1.0
---

# New exploration Maps through Wayfinder MCP

<!-- wayfinder:safety-core:start -->
Wayfinder MCP alone owns Map state; if down, stop—no fallback. Before create, fully page `map_list`; IDs are handles; create once. On resume or uncertainty, `map_read` current state. Claim only a returned Frontier Ticket before work. Apply only against latest observed Revision. On conflict, reread, report, and stop: old request is void until a human sees the new Revision and issues a new request. Never replay, merge, or take over. Settle HITL Tickets only after live human verdict.
<!-- wayfinder:safety-core:end -->

<!-- wayfinder:instructions-summary:start -->
Use `map_create`, `map_list`, `map_read`, and `map_apply` only. Retain stable Map and Claimant IDs plus each committed Revision within the logical session. Create specified Tickets before Dependencies in one ordered batch, keep imprecise uncertainty in Fog, and record typed Settlements with compact Evidence, References, and Provenance. Construct each command completely from the tool input schema before calling; validation failures are not a field-discovery mechanism. Resources and Prompts are optional explanations; correctness does not depend on reading them.
<!-- wayfinder:instructions-summary:end -->

## Generated tool guidance

<!-- wayfinder:tool:map_create:start -->
Create one new stable-ID Map at Revision 1 after `map_list` has been paged to the end and confirmed the intended Map does not exist. Titles are not handles. On a duplicate or uncertain result, discover and `map_read`; never create a replacement. Then use the returned Revision in one ordered `map_apply` that publishes current Tickets before Dependencies, Fog, and Scope Exclusions. If the result has `viewerUrl`, give it to the human once.
<!-- wayfinder:tool:map_create:end -->

<!-- wayfinder:tool:map_list:start -->
Discover Maps in ASCII stable-ID order. Before any create decision, follow `nextAfterMapId` through every page. Treat matching titles only as hints and retain the selected `mapId` as the authoritative handle; if several titles match and the stable ID is unknown, ask the human. Listing is discovery, not a current-state read.
<!-- wayfinder:tool:map_list:end -->

<!-- wayfinder:tool:map_read:start -->
Read the authoritative current full Revision by omitting `revision`, or explicitly inspect immutable history. Default-read after resumption, conflict, an uncertain write/lost receipt, or rediscovery. Retain the returned Revision and Frontier; do not treat conversation, files, GitHub, an older response, or a catalog entry as current Map state. When you resume a Map and the result has `viewerUrl`, give it to the human once.
<!-- wayfinder:tool:map_read:end -->

<!-- wayfinder:tool:map_apply:start -->
Atomically apply complete ordered commands only against the latest observed `expectedRevision`; never probe required fields with partial calls. Claim shape: `{"kind":"claim.acquire","ticketId":"...","claimantId":"..."}`. Settle shape: `{"kind":"ticket.settle","ticketId":"...","ticketType":"research|task|grilling|prototype","claimantId":"...","settlement":{"outcome":{...},"evidence":[...],"references":[...],"provenance":{"method":"...","sources":[...]},"extensions":{}}}`. Outcomes are `finding` with `statement` and optional `limitations` for research, `completion` with `statement` and `resultingFacts` for task, or `decision` with `statement` and `rationale` for grilling/prototype. Every Reference/source is an object `{"locator":"...","label":"..."}` (`label` optional), never a string. Evidence shape is `{"statement":"...","references":[...],"provenance":{"method":"...","sources":[...]},"extensions":{}}`; Provenance is required when Evidence references are empty. Research requires at least one Evidence or Reference. Work only a returned Frontier Ticket and Claim it before work; HITL decisions require the live human verdict. A Conflict voids the rejected request: reread, report the new Revision, and stop until the human issues a new request after seeing it. The stale instruction cannot authorize a later write. On proven non-publication or unknown outcome, reread and never auto-retry, replay, merge, take over, or fall back.
<!-- wayfinder:tool:map_apply:end -->

## Optional Prompt entry

<!-- wayfinder:prompt:start -->
Start or resume a Wayfinder exploration using only the server instructions and the four Map tools. For create mode, first page the complete catalog and create only if the intended stable Map is absent. For resume mode, locate the stable Map ID when needed and read its current Revision. Report the observed `workflowVersion` and proceed from the returned Frontier; an optional Map ID is a handle, not a title search.
<!-- wayfinder:prompt:end -->

After the accepted local MCP/SQLite workflow adoption, every **new exploration Map** uses the product MCP service as its sole state authority. This applies to Wayfinder planning started after adoption. GitHub remains authoritative for implementation Issues and PRs. The existing Revision rollback and Ticket/Map deletion planning Maps remain on GitHub until a separately accepted migration; never copy or dual-write them.

Use exactly `map_create`, `map_list`, `map_read`, and `map_apply`. The service owns authorship and time. Conversation text, local notes, GitHub comments, research files and prototypes may supply evidence or process context, but none is a second current-state store.

## Create a new exploration Map

1. Finish the Wayfinder destination/frontier discussion before writing. Choose a stable, valid `mapId` and a distinct logical `claimantId` for the work session. Retain both in the session context.
2. Call `map_list` through every required page before creation. A matching title is a discovery hint, never an authoritative handle. If the intended Map already exists, retain its returned `mapId` and resume it. If several titles match and the stable ID is unknown, ask the human which Map they mean.
3. Call `map_create` once. A duplicate or an uncertain result triggers discovery and reread, never creation of a replacement Map.
4. Use the returned Revision as `expectedRevision` for one ordered `map_apply` batch that creates the currently specified Tickets, then adds their Dependencies and the current Fog/Scope Exclusions. Keep later fog out of the batch until it becomes a precise Question.

The stored Map fields carry the Wayfinder model:

| Wayfinder concept | Product state |
| --- | --- |
| Destination | Map `destination` |
| Standing workflow context | Map `notes` |
| Question | Ticket `question` and type |
| Blocking | Ticket Dependencies |
| Frontier | `frontier` returned with the selected Revision |
| Work-session reservation | logical Claim |
| Answer | typed Settlement |
| Decisions so far | settled Tickets, derived on read |
| Not yet specified | Fog content |
| Out of scope | Scope Exclusion content |

## Resume and advance

1. With a retained `mapId`, call `map_read` without a Revision to observe the authoritative current state. Without it, page through `map_list`, retain the selected stable ID, then default-read it. Never create from title ambiguity.
2. Select only a Ticket returned in the current Frontier. Before doing its work, acquire its Claim with the session's `claimantId` and the just-observed Revision. Continue only after the committed result succeeds; retain the new Revision.
3. Resolve at most one Ticket per logical session, except independently delegated research Tickets. Read any prerequisite history or linked artifact needed for the work without treating those copies as current Map state.
4. Advance with `map_apply` against the latest retained Revision. Settle the claimed Ticket with the matching Claimant and Ticket type. Put newly precise Tickets, Dependencies, Fog changes and Scope Exclusions in the same ordered atomic batch when they are part of that resolution. Retain the committed Revision returned by the service.

Settlement preserves the method's decision boundary:

- `grilling` and `prototype` use a Decision only after the human gives the live verdict; the agent never supplies the human side.
- `research` uses a Finding supported by its primary-source artifact and References/Evidence.
- `task` uses a Completion only after the work is actually complete.
- Every Settlement records meaningful Provenance. Unfinished work remains open and claimed or is explicitly released; it is not represented as a successful Settlement.

## Conflicts, uncertainty and outages

- On Conflict, the rejected commands and their intention are void. Reread current state and relevant history, report the Conflict and new Revision to the human, then stop. Do not decide that the old intention remains valid and do not write again until the human, after seeing the new Revision, issues a new request. The instruction that caused the stale write cannot pre-authorize that post-reread request.
- On an infrastructure result with unknown outcome, reread before deciding. If the service cannot be reached, stop authoritative advancement until it returns. Local memory, files and GitHub are not fallbacks.
- A proven non-publication still requires a deliberate later request; it does not authorize an automatic retry.
- Claims do not expire with a client connection. A different session uses a distinct Claimant and cannot take over. Release or clear requires the explicit M1 command and reason.

The implementation tracker and product Map serve different purposes. Record code changes, reviews and delivery evidence on GitHub; record exploration Destination, Questions, Claims, Settlements, Fog and Scope only in the MCP Map.
