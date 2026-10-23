# Local read-only Map viewer requirements

Status: requirements accepted by the live user on 2026-10-23 after reviewing a requirement page and a clickable prototype built from real local Map Revisions. The user selected the dependency-graph layout. This confirms what the slice must do; it does not yet authorize implementation Tickets. The implementation design and acceptance plan remain to be written.

Use [GLOSSARY.md](../../GLOSSARY.md) for domain language and the [v1 contract](v1.md) for the wider product. This slice delivers part of M4 (visual projection) locally; it does not complete M4.

## 1. Decisions

- The viewer is a read-only projection of the authoritative Map ([ADR 0001](../adr/0001-remote-map-is-authoritative.md), [ADR 0002](../adr/0002-mcp-tools-are-the-primary-interface.md)). Destination and route planning, discussion, Claims and Settlements happen in the agent through the four MCP tools. The viewer has no mutation path and no embedded assistant.
- An earlier interactive workbench (`codex/wayfinder-map-workbench`, never merged) was discarded on 2026-10-23. It ran its own Codex conversation in the page and reimplemented the exploration workflow that the MCP service already supplies to agents.
- The first delivery is a local browser page. MCP Apps embedding in ChatGPT is deferred.
- The existing local MCP service process also serves the viewer, reachable only from this machine. The on-demand ChatGPT test tunnel publishes that service without user authentication; how the viewer is protected there must be decided before it runs behind the tunnel.
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

Editing from the viewer, an embedded chat, MCP Apps, zoom and filtering (the largest current Map has five Tickets), browsing older Revisions, share links, public access, authentication, rollback and deletion.

## 4. Open design questions

- How agents receive the viewer link. Preferred: return it from existing tool results and tell agents to show it through the server-supplied workflow, without a fifth tool. That changes the workflow contract and therefore needs a SemVer increase and cross-client acceptance under [ADR 0003](../adr/0003-mcp-service-carries-the-versioned-exploration-workflow.md).
- How the viewer learns of new Revisions, how the graph is laid out, and how "what changed" is derived from Revision history.
