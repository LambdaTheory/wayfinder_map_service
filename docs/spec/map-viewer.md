# Local Map viewer requirements

Status: requirements accepted by the live user on 2026-10-23 after reviewing a requirement page and a clickable prototype built from real local Map Revisions. The user selected the dependency-graph layout. The same day the user accepted an implementation plan with its three default decisions (section 4). Delivery and acceptance evidence: [docs/implementation/map-viewer.md](../implementation/map-viewer.md).

Use [GLOSSARY.md](../../GLOSSARY.md) for domain language and the [v1 contract](v1.md) for the wider product. This slice delivers part of M4 (visual projection) locally; it does not complete M4.

Sections 1–4 record the delivered read-only slice. [Section 5](#5-answer-desk-amendment) records the answer-only amendment accepted by Kun on 2026-10-26 under [#109](https://github.com/kun-g/wayfinder_map_service/issues/109); it does not claim that the running viewer accepts answers.

## 1. Decisions

- The viewer is a read-only projection of the authoritative Map ([ADR 0001](../adr/0001-remote-map-is-authoritative.md), [ADR 0002](../adr/0002-mcp-tools-are-the-primary-interface.md)). Destination and route planning, discussion, Claims and Settlements happen in the agent through the four MCP tools. The viewer has no mutation path and no embedded assistant.
- An earlier interactive workbench (`codex/wayfinder-map-workbench`, never merged) was discarded on 2026-10-23. It ran its own Codex conversation in the page and reimplemented the exploration workflow that the MCP service already supplies to agents.
- The first delivery is a local browser page. MCP Apps embedding in ChatGPT is deferred.
- The existing local MCP service process also serves the viewer, reachable only from this machine. The on-demand ChatGPT test tunnel forwards only `/mcp` (`scripts/local-chatgpt-test.mjs`), so the viewer is never published through it. Exposing the viewer beyond this machine needs a separate decision.
- Destination confirmation is not recorded as Map state. The workflow settles the Destination with the human before `map_create`, so the Revision that creates the Map is the confirmation point. The viewer shows which Revision set the Destination and whether a later Revision changed it.

## 2. Observable behavior

1. **Route and Destination.** Decision Tickets are laid out by their prerequisites and form the route; the Destination is drawn as the end of that route.
2. **Ticket states.** Each Ticket shows one derived state: waiting on unsettled prerequisites, available (in the Frontier), in progress (claimed) or settled. Shape and colour distinguish them together.
3. **Fog.** Fog is drawn as fog between the route and the Destination and obscures the Destination while any Fog remains. Removing Fog visibly clears it. When no Fog remains and every Ticket is settled, the route visibly reaches the Destination.
4. **Scope Exclusions** appear outside the map, never as Fog or Tickets.
5. **Details.** Selecting a Ticket shows its question, prerequisites, dependents and accepted Settlement with rationale or limitations, Evidence and References. Selecting the Destination shows its full text, the Revision that set it and later changes. Selecting Fog shows its text and the Revision in which it appeared.
6. **Following the Map.** After a Revision commits, an open viewer re-renders within seconds without a manual refresh and marks what the latest Revision changed, including Tickets started or settled and Fog added or cleared.
7. **Entry.** When an agent starts or resumes a Map, it gives the human that Map's viewer link. A fixed local address lists all Maps.
8. **Staleness.** If the service is unreachable, the viewer says so and labels the Revision and time it last observed. It never presents that state as current.

## 3. Out of scope

For the original slice: editing from the viewer, an embedded chat, MCP Apps, zoom and filtering (the largest current Map has five Tickets), browsing older Revisions, share links, public access, authentication, rollback and deletion. The answer-only write and its key are the bounded exception accepted in section 5; general Map editing remains excluded.

## 4. Design decisions

Accepted with the implementation plan on 2026-10-23.

- **Link.** `map_create` and `map_read` results carry an optional `viewerUrl` (`http://127.0.0.1:<port>/maps/<mapId>`); `map_apply` results do not. The server-supplied workflow tells agents to give the link to the human once when they create or resume a Map. This is workflow `2.1.0`, a backward-compatible change; there is no fifth tool. Real-client acceptance for `2.1.0` is one installed Codex session; ChatGPT is confirmed at the next live tunnel test.
- **Access.** The viewer has no key. The MCP host checks the exact loopback Host first, then sends every path other than `/mcp` to the viewer, so `/mcp` keeps its token. The viewer answers only GET and HEAD. Map data and scripts go only to same-origin requests or an address typed into the browser; another site or app may only navigate to a page, which holds no Map data. Responses forbid framing, caching and cross-origin reads. Accepted consequence: any process or macOS user that can reach this Mac's loopback port can read Maps while the service runs; writing still requires the `/mcp` token.
- **Following.** The page asks `GET /api/maps/<mapId>/view?known=<revision>` every two seconds. The service answers 204 while the latest Revision is unchanged. There is no push channel: an open stream would hold graceful shutdown, which waits for every request.
- **Layout.** A Ticket's layer is the length of its longest prerequisite chain; rows keep Map order within a layer. The Destination follows the last layer. Tickets that nothing depends on lead to the Destination. An edge that skips a layer runs in a lane beside the cards it passes.
- **What changed.** The view classifies the latest Revision's semantic changes. A content change is Fog or a Scope Exclusion according to the section that holds the item: this Revision for an addition or update, the previous Revision for a removal. `map.update` names the Destination only when the Destination text changed, and at most once per Revision because a change does not record which fields it patched.
- **History.** Polling reads only the latest two Revisions. The Destination's creating Revision and later changes, and the Revision where a Fog item appeared, are read only when the human opens those details.
- **Browser tests.** No browser-test dependency is added. Projection and HTTP behaviour are tested in the service; the page is checked with screenshots during acceptance.

## 5. Answer Desk amendment

Status: decisions accepted by Kun on 2026-10-26; behavior is specified in [answer-desk.md](answer-desk.md), with the architectural trade-off in [ADR 0006](../adr/0006-answer-desk-in-the-map-viewer.md). This section supersedes the read-only/no-key restrictions above for the follow-on implementation after #109 closeout; the delivered viewer remains read-only until that implementation ships.

- **One answer write entry.** The viewer accepts answers, changes to answers, Reopen Requests and cancellation of untaken Reopen Requests through one keyed endpoint. It cannot post or withdraw questions, edit the Map, manage Claims, reopen Tickets or settle them; those remain agent MCP operations.
- **Access.** Reading remains unkeyed. The answer key is separate from the MCP token and authorizes only the answer endpoint, with the same-origin and loopback checks retained. The launcher passes it in a fragment, never a query, and the page uses a request header. Every other viewer route remains GET/HEAD. The ChatGPT tunnel still forwards only `/mcp`.
- **Desk.** Show the ordered pending queue, the current question with its options, complete recommendation, why Kun is asked, what it unlocks and triage reason. Show Answered, Taken and Settled separately; retain Withdrawn questions with a strike-through and their reason, and show Reopen Requests distinctly. Ordering and the long-research flag follow the service's computed keys in the Answer Desk specification.
- **Submission.** Selection submits immediately; Enter selects the recommendation, 1–3 select options and `t` opens text entry. Empty text, opening, viewing or cancelling never submit. Bulk confirmation shows the full recommended answers for the selected follow-recommendation questions. The service owns the 15-second Quiet Window and release, not the page timer.
- **Freshness and layout.** Continue the two-second polling cadence for new questions, Taken, Settled and changes. Surface a stale question-version refusal as “question changed, answer again”; keep the existing unreachable/stale display. Verify light and dark themes and a 375 px viewport without horizontal overflow, alongside the existing route and details views.

The original [implementation record](../implementation/map-viewer.md) remains historical evidence. Answer Desk delivery needs new protocol, storage and browser evidence; the read-only acceptance is not evidence for these writes.
