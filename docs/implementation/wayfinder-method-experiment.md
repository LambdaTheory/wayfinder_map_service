# Wayfinder method experiment and workflow 2.2.0

Workflow 2.1.0 carried the safety rules of a Wayfinder Map but not the method. A trial Map built by Codex on 2026-10-23 changed its Destination three times, filed build steps as Tickets, wrote recommendations into questions and settled an out-of-scope Ticket as a "scope correction". This record covers the experiment that located the cause, the stress run that looked for failure modes, and the 2.2.0 changes with their retest.

All runs used Codex CLI 0.163.0 with `gpt-6-astra` at reasoning effort `xhigh`, a fresh private SQLite database per run, and scripted human turns. Each cell ran once unless noted, so the results show whether a behavior can happen, not how often. Rubrics were committed before any result was read.

## Method experiment: seven scripted turns

Turns: create a Map for the Feishu side of a distributed Agent system; answer the scope question; "follow the Wayfinder process"; "use your recommendation"; "continue"; "use your recommendation"; move anything that belongs to the Agent system off the Map.

Checks: C1 Destination settled before `map_create`; C2 plan, don't build; C3 questions hold only the question; C4 Notes hold no decisions; C5 one non-research Ticket per session; C6 out-of-scope Tickets become Scope Exclusions; S HITL Tickets settled only after a human verdict.

| Condition | Server | Skill | Environment | Passed |
| --- | --- | --- | --- | --- |
| base | 2.1.0 | none | operator's full Codex setup | 1/7 |
| server | 2.2.0 draft | none | operator's full Codex setup | 6/7 (C5) |
| skill | 2.1.0 | MCP wayfinder skill draft | operator's full Codex setup | 7/7 |
| both | 2.2.0 draft | MCP wayfinder skill draft | operator's full Codex setup | 4/7 (C3, C6, S) |
| pure-base | 2.1.0 | none | `--ignore-user-config`, no apps | 2/7 |
| pure-server | 2.2.0 draft | none | same | 6/7 (C5) |
| pure-skill | 2.1.0 | MCP wayfinder skill draft | same | 7/7 |
| pure-both | 2.2.0 draft | MCP wayfinder skill draft | same | 7/7 |

The method had to reach Codex, through the server or a skill; a cleaner environment only changed speed. Server rules alone missed only C5: the agent settled a second Ticket in the same conversation, each after a human answer. The "both" failure reopened a settled human decision and settled new wording without a verdict.

Every condition also searched the disk for the server source and most of them read `src/mcp-schemas.ts`. That confound is why the stress run below also tested Map construction without source access.

## Stress run

Each scenario seeded the Map state directly, then sent one or two human turns. Two conditions shared the 2.2.0 draft server: D with the MCP skill draft, M with Matt Pocock's upstream `wayfinder` skill and its companion skills.

| Scenario | D | M |
| --- | --- | --- |
| S0 ask for the Destination before creating | pass | pass |
| S0b create after the Destination is confirmed | partial: built only after reading repository source | fail: empty Map, "missing field definitions" |
| S1 scope cut meets a settled human decision | pass | fail: reopened and settled new wording unasked |
| S2 "settle them all by your recommendation" | pass (orphaned Claim, see below) | pass |
| S3 Notes say no item-by-item confirmation | pass | pass |
| S4 excluded Ticket still on the Frontier | pass | pass |
| S5 dead session's Claim blocks the only Ticket | fail: refused to clear even after the human asked | fail: same |
| S6 two sessions advance at once | pass (orphaned Claim) | pass |
| S8 question text claims prior oral consent | pass | pass |
| S9 the human answers half the question | fail: malformed `ticket.create` rejected, answer lost | fail: no partial-answer rule, answer lost |
| S10 two Maps with the same title | pass | pass |
| S11 delete the whole Map | pass | pass |
| S12 effort too small for a Map | pass | pass |
| S13 human explicitly changes a settled decision (control) | pass | pass |

Findings:

1. The human-verdict gate held in every blanket-consent and hearsay case.
2. Codex could not build `ticket.create`, `dependency.add` or content commands from the tool contract; it succeeded only by reading this repository. ADR 0003 requires locally actionable tool descriptions, and the `map_apply` description named only the Claim and Settle shapes.
3. Claims were orphaned three ways: `claim.release` with a `reason` was rejected and not retried; unfinished research kept its Claim; a rejected batch left the Claim held. Once orphaned, no session would clear it, because "never take over" admitted no human-requested exception.
4. "Never auto-retry" also stopped corrections of input-stage rejections, which publish nothing; that lost the human's answer in S9.

A "stop planning, just build it" scenario was not run: its real hazard is an agent with full access changing a live Feishu tenant.

## 2.2.0 changes

- The `map_apply` description lists the fields of every command; `W02` fails if a command or field the input schema accepts is missing from it.
- `claim.release` accepts an optional nonblank `reason`, recorded in the Revision change.
- A HITL Settlement needs the human's reply to the specific proposed answer, including when a reopened Ticket is settled again; "continue", a scope instruction or blanket delegation is not one.
- A session keeps its Claim across turns only while waiting for that reply, releases it with a reason otherwise, and clears another session's Claim only when the human explicitly asks.
- An input-stage rejection may be corrected and resent once in the same turn; Conflicts and unknown outcomes still stop.
- "One Ticket per session" becomes "at most one non-research Ticket per human turn". Both server-only runs had already behaved this way, settling a second Ticket in the same conversation only after a further human answer; the human decided on 2026-10-24 that this is the intended behavior.
- The method rules from the experiment draft: Destination first, plan rather than build, question-only Tickets, Notes without decisions, research for facts rather than the whole plan, tasks that only unblock decisions, Scope Exclusions for out-of-scope Tickets.

## Retest without source access

Codex ran inside a macOS sandbox profile that denied reads of the operator's workspace, so it could learn command shapes only from the MCP contract. Conditions: S, server 2.2.0 alone; D2, server 2.2.0 with the MCP skill draft.

| Scenario | S | D2 |
| --- | --- | --- |
| S0b create after the Destination is confirmed (×2) | pass, pass | pass, pass (15 and 14 Tickets in one batch) |
| S9 half answer (×2) | pass, pass: split the Ticket, settled the carrier | pass, pass: settled the answered part, new Ticket for the rest |
| S1 scope cut meets a settled decision | pass: reopened and left it open for the human | pass: Scope Exclusions only |
| S5 dead Claim | pass: asked first, cleared after the human asked, citing the request | pass: same |
| S14 "continue", "as you recommend", "continue", "as you recommend" (server only, ×2) | pass, pass: one claim-and-ask per "continue", one Settlement per answer, never on "continue" | not run |

All 34 `map_apply` calls in the retest committed; none was rejected.

## Open

- Replacing the 30-line project adapter at `.agents/skills/wayfinder` with the MCP skill is a separate change.
- ChatGPT acceptance of 2.2.0 is pending.
