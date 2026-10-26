# New exploration Maps through Wayfinder MCP

<!-- wayfinder:safety-core:start -->
Wayfinder MCP alone owns Map state; if down, stop—no fallback. Before create, fully page `map_list`; IDs are handles; create once. On resume or uncertainty, `map_read` current state. Claim only a returned Frontier Ticket before work. Apply only against latest observed Revision. On conflict, reread, report, and stop: old request is void until a human sees the new Revision and issues a new request. Never replay, merge, or take over unasked. Settle HITL Tickets only after a live human verdict on that answer.
<!-- wayfinder:safety-core:end -->

<!-- wayfinder:instructions-summary:start -->
Use `map_create`, `map_list`, `map_read`, and `map_apply` only; if they fail, never reach the service by another route or with another client's credentials. Retain stable Map and Claimant IDs plus each committed Revision within the logical session. Create specified Tickets before Dependencies in one ordered batch, keep imprecise uncertainty in Fog, and record typed Settlements with compact Evidence, References, and Provenance. Construct each command completely from the shapes in the `map_apply` description before calling; never probe fields with partial calls. An input-stage rejection published nothing: correct the named field and resend once in the same turn. Resources and Prompts are optional explanations; correctness does not depend on reading them.

Method: a Map plans the route to its Destination; it does not do the work. Settle the Destination with the human before `map_create`. Each Ticket is one decision that can be stated precisely now; leave the rest in Fog. A Ticket question states only the question: no recommended answer, conversation or later outcome, and settling never rewrites it. The answer lives only in the Settlement; Notes hold standing context and constraints, never decisions. Research surfaces facts a pending decision needs, not the whole plan. A task only unblocks a decision (access, measurement) and never builds the Destination; build phases belong in the Destination's deliverable. The main session talks with the human, chooses what to ask, claims and writes; where the client has sub-agents, they do the reading: research and AFK task Tickets, evidence for a pending question, prototypes. Keep the route moving: after a Settlement, take the next Frontier work in the same turn, adding only Tickets an answer made precise. While a verdict is pending, prepare other Frontier Tickets: gather their facts and draft each question with a recommended answer, and recheck drafts against new verdicts before asking. Ask without ending the turn where the client allows it. Put independent HITL questions together, up to three per message, numbered, each with a recommended answer. A prototype of something that already exists starts from its current implementation or official component. When the route is clear the Map is done: say so and hand off. "Continue" is not a request to build; building happens outside the Map unless its Notes say otherwise. Near the context limit, suggest a fresh conversation and give the Map ID to resume with. A Ticket found beyond the Destination is never settled as a decision: release its Claim and propose a Scope Exclusion.

Verdicts and Claims: settle a grilling or prototype Ticket only on the human's reply to the specific answer you proposed. "Continue", a scope instruction or a blanket "use your recommendations" is not a verdict on an answer the human has not seen; this holds equally when settling a reopened Ticket again. A reply that covers several proposed answers settles each of them; unanswered ones stay claimed. To change a settled decision, on this or another Map, name it in the message that asks for the verdict; that verdict is the agreement to reopen it. Keep a Claim across turns only while waiting for that reply; otherwise release it with a reason before you stop. Tell the human outcomes and questions, not Claims, Revisions or the rules you follow. Clear another session's Claim only when the human explicitly asks, citing the request in the reason. A question from the human is not an instruction or a verdict, even when you agree: answer it and ask before acting on it. Changing what a Map covers is the human's call: add or remove Scope Exclusions, change the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement to that proposal.
<!-- wayfinder:instructions-summary:end -->

## Generated tool guidance

<!-- wayfinder:tool:map_create:start -->
Only after the human has confirmed the Destination, create one new stable-ID Map at Revision 1 after `map_list` has been paged to the end and confirmed the intended Map does not exist. Titles are not handles. On a duplicate or uncertain result, discover and `map_read`; never create a replacement. Then use the returned Revision in one ordered `map_apply` that publishes current Tickets before Dependencies, Fog, and Scope Exclusions. If the result has `viewerUrl`, give it to the human once. Set `version` to the `version:` line of the Wayfinder instructions you follow, or, if you were given no Wayfinder instructions, to the release the `version` parameter description names. A `version_mismatch` rejection means the service was upgraded and nothing was written; it is not a tool failure. Read the Resource `wayfinder://workflow/exploration` with your client's resource tool, follow its rules, read the Map again and retry with the version on its first line. Only if your client cannot read MCP Resources, ask the human to refresh this server's tools and start a new conversation.
<!-- wayfinder:tool:map_create:end -->

<!-- wayfinder:tool:map_list:start -->
Discover Maps in ASCII stable-ID order. Before any create decision, follow `nextAfterMapId` through every page. Treat matching titles only as hints and retain the selected `mapId` as the authoritative handle; if several titles match and the stable ID is unknown, ask the human. Listing is discovery, not a current-state read.
<!-- wayfinder:tool:map_list:end -->

<!-- wayfinder:tool:map_read:start -->
Read the authoritative current full Revision by omitting `revision`, or explicitly inspect immutable history. Default-read after resumption, conflict, an uncertain write/lost receipt, or rediscovery. Retain the returned Revision and Frontier; do not treat conversation, files, GitHub, an older response, or a catalog entry as current Map state. When you resume a Map and the result has `viewerUrl`, give it to the human once.
<!-- wayfinder:tool:map_read:end -->

<!-- wayfinder:tool:map_apply:start -->
Atomically apply complete ordered commands only against the latest observed `expectedRevision`; never probe required fields with partial calls. Each command is an object with `kind` plus these fields (`?` optional): `ticket.create` {ticket:{id,title,question,type:"research|prototype|grilling|task"}}; `ticket.update` {ticketId,patch:{title?,question?,type?},claimantId?}; `ticket.reopen` {ticketId,reason}; `dependency.add`/`dependency.remove` {dependentId,prerequisiteId,claimantId?}; `claim.acquire` {ticketId,claimantId}; `claim.release` {ticketId,claimantId,reason?}; `claim.clear` {ticketId,expectedClaimantId,reason}; `content.add`/`content.update` {section:"fog|scopeExclusions",item:{id,text,references:[]}}; `content.remove` {section,itemId}; `map.update` {patch:{title?,destination?,notes?}}. Settle shape: `{"kind":"ticket.settle","ticketId":"...","ticketType":"research|task|grilling|prototype","claimantId":"...","settlement":{"outcome":{...},"evidence":[...],"references":[...],"provenance":{"method":"...","sources":[...]},"extensions":{}}}`. Outcomes are `finding` with `statement` and optional `limitations` for research, `completion` with `statement` and `resultingFacts` for task, or `decision` with `statement` and `rationale` for grilling/prototype. Every Reference/source is an object `{"locator":"...","label":"..."}` (`label` optional), never a string. Evidence shape is `{"statement":"...","references":[...],"provenance":{"method":"...","sources":[...]},"extensions":{}}`; Provenance is required when Evidence references are empty. Research requires at least one Evidence or Reference. Work only a returned Frontier Ticket and Claim it before work. Settle grilling/prototype only on the human's verdict on that answer, including after a reopen. Settle with the Ticket's question unchanged; never move answers, recommendations or conversation into questions or Notes. Change Scope Exclusions, the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement; a question from the human is neither. An input-stage rejection published nothing: correct the named field and resend once. A Conflict voids the rejected request: reread, report the new Revision, and stop until the human issues a new request after seeing it. The stale instruction cannot authorize a later write. On any other non-publication or unknown outcome, reread and never auto-retry, replay, merge, take over, or fall back. Set `version` to the `version:` line of the Wayfinder instructions you follow, or, if you were given no Wayfinder instructions, to the release the `version` parameter description names. A `version_mismatch` rejection means the service was upgraded and nothing was written; it is not a tool failure. Read the Resource `wayfinder://workflow/exploration` with your client's resource tool, follow its rules, read the Map again and retry with the version on its first line. Only if your client cannot read MCP Resources, ask the human to refresh this server's tools and start a new conversation.
<!-- wayfinder:tool:map_apply:end -->

## Optional Prompt entry

<!-- wayfinder:prompt:start -->
Start or resume a Wayfinder exploration using only the server instructions and the four Map tools. For create mode, first page the complete catalog and create only if the intended stable Map is absent. For resume mode, locate the stable Map ID when needed and read its current Revision. Report the observed `version` and proceed from the returned Frontier; an optional Map ID is a handle, not a title search.
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
2. Select only Tickets returned in the current Frontier. Before doing a Ticket's work, acquire its Claim with the session's `claimantId` and the just-observed Revision. Continue only after the committed result succeeds; retain the new Revision.
3. Keep moving through the Frontier in one turn. The main session keeps to the conversation, the Claims and the writes; where the client has sub-agents, they run AFK Tickets, gather evidence and build prototypes, in parallel when independent, and return summaries. Sub-agents never write, so parallel work never races for a Revision. While the human considers a question, prepare the other Frontier Tickets so the next question is ready; a draft is not an answer and is rechecked against new verdicts before it is asked. Present independent HITL questions together, up to three per message, each with a recommended answer, without ending the turn where the client allows it, and settle each only on a reply that covers it. When the route is clear, say the Map is done and hand off; a later "continue" does not start the build. Near the context limit, suggest a fresh conversation and give the Map ID to resume with. Read any prerequisite history or linked artifact needed for the work without treating those copies as current Map state.
4. Advance with `map_apply` against the latest retained Revision. Settle each claimed Ticket with the matching Claimant and Ticket type. Put newly precise Tickets, Dependencies, Fog changes and Scope Exclusions in the same ordered atomic batch when they are part of that resolution. Change Scope Exclusions, the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement; a question from the human is neither. Retain the committed Revision returned by the service.

Settlement preserves the method's decision boundary:

- `grilling` and `prototype` use a Decision only after the human gives the live verdict on the proposed answer; the agent never supplies the human side. One reply may give verdicts on several proposed answers; it settles only those it covers. Settling a reopened Ticket again needs a new verdict on its new answer, and reopening a settled decision needs the human's agreement, which the verdict request may ask for by naming it. A prototype of something that already exists starts from its current implementation or official component documentation.
- `research` uses a Finding supported by its primary-source artifact and References/Evidence.
- `task` uses a Completion only after the work is actually complete.
- Every Settlement records meaningful Provenance. Unfinished work remains open and claimed or is explicitly released; it is not represented as a successful Settlement.

## Conflicts, uncertainty and outages

- On Conflict, the rejected commands and their intention are void. Reread current state and relevant history, report the Conflict and new Revision to the human, then stop. Do not decide that the old intention remains valid and do not write again until the human, after seeing the new Revision, issues a new request. The instruction that caused the stale write cannot pre-authorize that post-reread request.
- On an infrastructure result with unknown outcome, reread before deciding. If the service or its tools cannot be reached, stop authoritative advancement until they return and tell the human. Local memory, files and GitHub are not fallbacks, and neither is calling the service by another route or with another client's credentials.
- An input-stage rejection published nothing; correct the named field and resend once in the same turn. Any other proven non-publication still requires a deliberate later request; it does not authorize an automatic retry.
- Claims do not expire with a client connection. A different session uses a distinct Claimant and does not take over on its own; when the human explicitly asks to clear a stale Claim, use `claim.clear` with a reason that cites the request. Keep your own Claim across turns only while waiting for the human's reply; otherwise release it, with a reason, before stopping. Sub-agents inside one session do not hold Claims of their own.

The implementation tracker and product Map serve different purposes. Record code changes, reviews and delivery evidence on GitHub; record exploration Destination, Questions, Claims, Settlements, Fog and Scope only in the MCP Map.
