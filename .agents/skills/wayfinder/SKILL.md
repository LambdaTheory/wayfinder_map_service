---
name: wayfinder
description: Plan an effort too big for one agent session as a Wayfinder Map through the Wayfinder MCP tools, then resolve its decision Tickets one at a time until the route to the Destination is clear. Use when the user asks to create, resume or advance a Wayfinder map.
---

<!-- Adapted from Matt Pocock's wayfinder skill (MIT) for the Wayfinder MCP service instead of a GitHub issue tracker. Provenance: docs/agents/skills-provenance.md. -->

A loose idea has arrived, too big for one session and wrapped in fog: the way from here to the **Destination** is not visible yet. Wayfinding finds that way; it does not charge at the Destination. The Wayfinder MCP service holds the **Map**; its server instructions and tool descriptions govern every state change, and the `map_apply` description lists every command's fields. This skill adds the method.

Maps that live on GitHub Issues, such as a project's older planning Maps, are outside this skill: leave them to that tracker's process.

## Plan, don't do

A Map is **planning**. Each Ticket resolves a decision, and the Map is done when the way is clear and nothing is left to decide before someone does the work. The pull to just do the work signals the edge of the Map: hand off instead. Only if the Map's Notes explicitly say so does execution belong inside the Map. Otherwise produce decisions, not deliverables.

## Refer by name

In everything the human reads, refer to the Map and Tickets by title. Keep the stable IDs for tool calls; you may show an ID beside a title, never instead of it.

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
- **prototype** (HITL): make a cheap, rough artifact to react to when "how should it look or behave" is the question. Settled with a Decision after the human reacts.
- **grilling** (HITL): conversation, the default. Ask one decision at a time with your recommended answer; settle with a Decision only after the human's verdict.
- **task** (HITL or AFK): manual work that must happen before a decision can be made, such as provisioning access or measuring something. It earns its place by unblocking a decision, never by building the Destination. Phased build plans belong in the Destination's deliverable, not in task Tickets.

Blocking uses Ticket Dependencies. The **Frontier** is the open, unblocked, unclaimed Tickets that `map_read` returns.

## Fog or Ticket?

The test is whether you can state the question precisely **now**, not whether you can answer it now.

- **Ticket** when the question is already sharp, even if it is blocked.
- **Fog** when you cannot phrase it that sharply yet. Do not pre-slice Fog into Ticket-sized pieces; one patch may become several Tickets, or none.

Fog only gathers toward the Destination. Work beyond the Destination is a Scope Exclusion, not Fog.

## Out of scope

When a Ticket turns out to lie beyond the Destination, do not settle it as a decision and do not rewrite it into one. Release any Claim, add a Scope Exclusion that names the Ticket and says why it is out of scope, and tell the human the Ticket stays open until the service supports removal. It is not a step on the route.

When the cut reaches a decision the human already settled, do not settle new wording on your own. Record the Scope Exclusion, and if the decision itself must change, reopen it only with the human's agreement and settle it again only on their verdict.

## Claims

Claim a Ticket before any work on it. Keep a Claim across turns only while you wait for the human's reply to that Ticket, and say so when you report. Otherwise release it, with a reason, before you stop. Never clear another session's Claim on your own; when the human explicitly asks you to take over a stale one, clear it with a reason that cites the request.

## Chart a Map

One session; it settles nothing except independent research.

1. **Name the Destination with the human.** Use grilling until the Destination is observable and the human confirms it. The Destination fixes the scope, so it comes first. Do not create the Map on a guessed Destination.
2. **Map the frontier breadth-first.** Fan out across the whole space to surface the open decisions and the first steps takeable now. If there is no fog (the whole way fits one session), say a Map is unnecessary and ask how to proceed.
3. **Create the Map** with `map_create` after paging `map_list` to the end. Notes hold domain and standing preferences only.
4. **Publish in one `map_apply`:** the Tickets you can state precisely now, then their Dependencies, then Fog and Scope Exclusions.
5. **Stop.** Give the human the viewer link if the service returned one, and name the Frontier.

## Work through a Map

1. Read the Map with `map_read`. If the human named a Ticket, use it; otherwise take the first Frontier Ticket.
2. **Claim it first**, before any work.
3. Resolve it as its type says. Read related settled Tickets as needed.
4. Settle it with a typed Settlement: compact Evidence, References and Provenance. In the same `map_apply`, add Tickets the answer made precise, graduate Fog it cleared, and update Tickets it invalidated.
5. **Stop.** Settle at most one non-research Ticket per human turn. Report the new Revision and Frontier, take the next Ticket only when the human asks, and suggest a fresh conversation once this one has grown long.

Other sessions may advance the same Map concurrently; the service's Conflict rules decide what happens then.
