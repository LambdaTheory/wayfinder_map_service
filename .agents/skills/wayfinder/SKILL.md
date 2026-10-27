---
name: wayfinder
description: Plan an effort too big for one agent session as a Wayfinder Map through the Wayfinder MCP tools, then resolve its decision Tickets with the human until the route to the Destination is clear. Use when the user asks to create, resume or advance a Wayfinder map.
---

<!-- Adapted from Matt Pocock's wayfinder skill (MIT) for the Wayfinder MCP service instead of a GitHub issue tracker. Provenance: docs/agents/skills-provenance.md. -->

A loose idea has arrived, too big for one session and wrapped in fog: the way from here to the **Destination** is not visible yet. Wayfinding finds that way; it does not charge at the Destination. The Wayfinder MCP service holds the **Map**; its server instructions and tool descriptions govern every state change, and the `map_apply` description lists every command's fields. This skill adds the method.

Maps that live on GitHub Issues, such as a project's older planning Maps, are outside this skill: leave them to that tracker's process.

If the Wayfinder tools are missing or fail, stop and tell the human what failed. Do not reach the service any other way: no HTTP calls or scripts, and no token or address found in files, notes or another agent's configuration. Local notes are no substitute for the Map either.

## Plan, don't do

A Map is **planning**. Each Ticket resolves a decision, and the Map is done when the way is clear and nothing is left to decide before someone does the work. The pull to just do the work signals the edge of the Map: hand off instead. Only if the Map's Notes explicitly say so does execution belong inside the Map. Otherwise produce decisions, not deliverables.

On resumption and at each Settlement, check the accepted decisions against the Destination, open or claimed Tickets, and Fog. The route is clear when no unresolved in-scope decision blocks handing the plan to its implementer; an empty Frontier alone is not enough. If clear, hand off in the same turn with the accepted decisions, Map/artifact links and implementation context. Otherwise name the specific unresolved decision. Add Tickets only for decisions still needed for that route, not implementation elaboration or a generic "continue". "Continue" after that is not a request to build. If the human asks for the build, it happens outside this Map, in a session started for it; do not start it here.

## Talking to the human

In everything the human reads, refer to the Map and Tickets by title. Keep the stable IDs for tool calls; you may show an ID beside a title, never instead of it.

Tell them outcomes and what you need from them. Claims, Revisions and Settlements are bookkeeping and stay out of replies. When you need a verdict, ask the question; do not explain the rule that makes you wait, and never quote or link this skill or the server instructions.

## The Map

The Map is an **index, not a store**. Each part has one job:

| Part | Holds |
| --- | --- |
| Destination | What reaching the end looks like: the spec, decision or change this effort finds its way to. One or two sentences. |
| Notes | Domain, skills every session should consult, standing preferences and constraints. Never decisions, summaries of answers or conversation. |
| Tickets | One open question each. Settled Tickets are the record of decisions ("Decisions so far" is derived from them). |
| Fog | In-scope questions you can see coming but cannot state precisely yet. |
| Scope Exclusions | Work ruled beyond the Destination. It never graduates. |

A decision lives in exactly one place: its Ticket's Settlement.

## Tickets

A Ticket's question states **only the question**: no recommended answer, no options already chosen, no conversation, no later outcome. Size it to one agent session. Settling records the answer in the Settlement and never rewrites the question. If the answer covers only part of the question, settle what was decided and create a new Ticket for the rest, in the same `map_apply`.

Every Ticket is **HITL** (worked with a human who speaks for themselves) or **AFK** (the agent alone). A HITL Ticket resolves only through that live exchange; the agent never supplies the human's side. A verdict is the human's reply to the specific answer you proposed. "Continue", a scope instruction or a blanket "use your recommendations" is not a verdict on an answer the human has not seen. The same holds when you settle a reopened Ticket again.

- **research** (AFK): read documentation, APIs or local knowledge to surface a fact a pending decision waits on. Settled with a sourced Finding. It never produces the whole plan.
- **prototype** (HITL): make a cheap, rough artifact to react to when "how should it look or behave" is the question. When it imitates something that already exists (a product screen, a platform's card or form), first read the current implementation or the official component documentation and build to that structure. Settled with a Decision after the human reacts.
- **grilling** (HITL): conversation, the default. Post every currently askable decision to the Answer Desk together, with its recommendation and triage reason. Settle each with a Decision only after the human's verdict on it.
- **task** (HITL or AFK): manual work that must happen before a decision can be made, such as provisioning access or measuring something. It earns its place by unblocking a decision, never by building the Destination. Phased build plans belong in the Destination's deliverable, not in task Tickets.

Blocking uses Ticket Dependencies. The **Frontier** is the open, unblocked, unclaimed Tickets that `map_read` returns.

## Fog or Ticket?

The test is whether you can state the question precisely **now**, not whether you can answer it now.

- **Ticket** when the question is already sharp, even if it is blocked.
- **Fog** when you cannot phrase it that sharply yet. Do not pre-slice Fog into Ticket-sized pieces; one patch may become several Tickets, or none.

Fog only gathers toward the Destination. Work beyond the Destination is a Scope Exclusion, not Fog.

## Out of scope

A Ticket found beyond the Destination is never settled as a decision: release its Claim and propose a Scope Exclusion. The proposed Scope Exclusion names the Ticket and says why it is out of scope; tell the human the Ticket stays open until the service supports removal. It is not a step on the route. A question from the human is not an instruction or a verdict, even when you agree: answer it and ask before acting on it. Changing what a Map covers is the human's call: add or remove Scope Exclusions, change the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement to that proposal.

When the cut reaches a decision the human already settled, do not settle new wording on your own. Change Scope Exclusions, the Destination or Notes, or narrow a question or remove a Dependency to move work out, only on the human's explicit instruction or agreement; a question from the human is neither. If the decision itself must change, reopen it only with the human's agreement and settle it again only on their verdict.

The same holds whenever new work would change a settled decision, on this Map or another: name the decision in the message that asks for the human's verdict. That verdict is the agreement to reopen it; do not reopen first and tell them afterwards. Before reopening a settled decision, name the dependent Tickets affected by the change, including open ones. A direct change request covers only the parts the human states; do not carry unstated details from the old Settlement into the changed situation as confirmed. Propose those details for a fresh verdict. Reopening and Settlement still follow the verdict and Answer Desk rules.

## Claims

Claim a Ticket before any work on it. Keep a Claim across turns only while you wait for the human's reply to that Ticket; otherwise release it, with a reason, before you stop. Clear another session's Claim only when the human explicitly authorizes clearing or taking over the identified Tickets, citing that request in the reason. Ask about takeover separately from continuing after a Conflict. A reply that only says to continue on the current Map does not authorize clearing Claims, even when it answers a combined takeover-and-continue question.

## Chart a Map

Before planning a new Map, if the question can be answered in one turn without a persistent decision route, give an actionable recommendation and its reasons now, explain that no Map is needed, and do not create one, even if the opening request asks for a Map. If the human still wants a Map after that explanation, confirm its Destination before creation.

Charting settles nothing except independent research.

1. **Name the Destination with the human.** Use grilling until the Destination is observable and the human confirms it. The Destination fixes the scope, so it comes first. Do not create the Map on a guessed Destination.
2. **Map the frontier breadth-first.** Fan out across the whole space to surface the open decisions and the first steps takeable now. If there is no fog (the whole way fits one session), say a Map is unnecessary and ask how to proceed.
3. **Create the Map** with `map_create` after paging `map_list` to the end. Notes hold domain and standing preferences only.
4. **Publish in one `map_apply`:** the Tickets you can state precisely now, then their Dependencies, then Fog and Scope Exclusions.
5. Start the research Tickets on sub-agents, give the human the viewer link if the service returned one, then work through the Map from its Frontier.

## Work through a Map

You hold the conversation; sub-agents do the reading. Where your client has sub-agents, hand them research and AFK task Tickets, the evidence a pending question needs, and prototypes, in parallel when independent; they return summaries. Keep your own context for the human, the decisions and the writes, so one session lasts longer and stays coherent. Sub-agents never claim or write.

1. Read the Map with `map_read`; ChatGPT takes answers with `claimantId` and `version` at each turn start. If the human named a Ticket, start there; otherwise take what the Frontier offers.
2. **Claim before work.** Claim each Ticket you or a sub-agent takes up this turn before the work starts.
3. **AFK work does not wait.** Research and AFK tasks run without the human.
4. **Publish all askable questions.** Post every currently askable human question to the Answer Desk at once, without a three-question limit. Claim each Ticket before `deskQuestion.post`; give two or three options, a full recommended answer, `whyKun`, `triage` (`needsKun` or `followRecommendation`) with `triageReason`, and `gatesResearch`. Prioritize unlockers: `immediateUnlocks > 0` or `gatesResearch`, then descending `immediateUnlocks` and `downstreamUnsettled`, then `needsKun`, then oldest publication and question ID. The service computes these counts; do not invent them. Both triage classes still need a human verdict. Announce a posted batch with one short sentence and the desk link; do not paste its questions into the conversation. While answers are pending, continue independent work and prepare other questions. Claude Code uses the task-capable `map_wait`; Codex calls blocking `map_wait` only after independent work is exhausted. ChatGPT and clients unable to hold a long call do not call `map_wait`: at each turn start use current `map_read` with `claimantId` and `version`, omitting `revision`; Kun tells ChatGPT when he is done. Taking marks responses Taken after the Quiet Window; it never settles a Ticket. On a lost result, recover Taken-but-unsettled answers and unhandled Reopen Requests with a current read.
5. **Prepare ahead.** While the human considers a question, have sub-agents prepare the other Frontier Tickets: gather their facts and draft each question with a recommended answer, so the next one is ready when the reply comes. A draft is not an answer; recheck it against the newest verdicts before you ask it.
6. Settle released verdicts and publish newly unlocked questions in the same ordered `map_apply` where command rules allow: settle first, then claim and post the newly unblocked Tickets. For an active Desk Question, `ticket.settle` must carry `deskAnswer:{answerId,questionVersion}` identifying the current answer Taken by this Claimant. An option verdict covers its displayed label and description, including a non-recommended option; free text asking for material is not a verdict: withdraw with a reason, supply the material and post the next Question Version. Only an explicit conversation verdict on a specific displayed answer authorizes withdrawing its Pending or Answered Desk Question with reason `answered in conversation` and then settling without `deskAnswer` in that same batch. "Take over", "continue", a question, a scope comment or blanket assent to unseen recommendations authorizes neither withdrawal nor Settlement. Settle with typed Settlements: compact Evidence, References and Provenance. In the same `map_apply`, add Tickets the answer made precise, graduate Fog it cleared, and update Tickets it invalidated. Add only decisions an answer made precise and the route still needs; otherwise hand off under the completion rule above.
7. **Keep going.** After settling, take the next Frontier work in the same turn. Stop when nothing is workable without the human, or when the route is clear and the Map is done. Near the context limit, suggest a fresh conversation and give the Map ID to resume with.

For an unsupported operation, state the capability limit, offer supported next steps and ask which the human wants before changing the Map. Deletion is unsupported: offer to leave the Map unchanged or, only with explicit agreement, note that it is abandoned; never simulate deletion by emptying or rewriting the Map.

Other sessions may advance the same Map concurrently; the service's Conflict rules decide what happens then.
