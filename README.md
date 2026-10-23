# Wayfinder Map Service

Wayfinder Map Service is a client-neutral decision-map system for ChatGPT, Codex, and other MCP-capable agents.

It combines two explicit workflows:

- `@grilling` explores the current decision frontier in rounds.
- `@wayfinder` manages long-running work as a persistent map of destinations, decisions, tickets, dependencies, evidence, and revisions.

The remote service owns canonical state. Clients interact through a small MCP interface, while a web renderer and optional MCP Apps UI present the same map visually.

## Current status

M1 Map core is complete on `main` as of 2026-09-18: the six implementation Issues are closed, all 56 acceptance scenario groups have executable assertions, strict TypeScript checking passes, and 1,061 tests pass. See the [cumulative acceptance matrix](docs/implementation/m1-acceptance.md). M1 delivers the pure domain module and in-memory Adapter only; rollback/deletion, persistence, remote transport, authentication and rendering remain outside this slice.

The accepted handoff is [docs/spec/m1.md](docs/spec/m1.md); the wider v1 product contract is [docs/spec/v1.md](docs/spec/v1.md).

The local slice follows the [accepted MCP/SQLite implementation handoff](docs/spec/mcp-sqlite.md), human-confirmed on 2026-09-18; see [Codex MCP and SQLite acceptance planning](https://github.com/kun-g/wayfinder_map_service/issues/27) for its decisions. SQLite is selected for this local slice only. The Wayfinder MCP connection, real Codex acceptance and the separately gated [new-exploration workflow adoption](https://github.com/kun-g/wayfinder_map_service/issues/39) are implemented.

The first persistence slice implemented a private SQLite Adapter on pinned Node.js 26.3.0. Its separate operator entry point is `src/sqlite-storage.ts`: `initializeSQLite(path)` explicitly creates a fresh database, and `openSQLite(path)` opens only a supported existing database. The domain entry point remains pure. See [storage verification and operator constraints](docs/implementation/sqlite-storage.md).

The storage failure/backup slice adds explicit busy/non-publication/unknown-outcome diagnostics, controlled Adapter-host restart/termination evidence, and `storage.backup(destination)`. Run `npm run --silent backup -- <absolute-source> <fresh-absolute-destination>` for a manual consistent local backup; `--silent` prevents npm echoing private path arguments. See [failure and backup evidence](docs/implementation/sqlite-failure-backup.md). This is not HTTP shutdown/reconnect, real connected Codex acceptance, a restore feature, or exploration adoption.

The headless tool slice exposes exactly `map_create`, `map_list`, `map_read` and `map_apply` through `createMapMcpServer(storage, { actorId, clientId })` in `src/mcp-tools.ts`. It uses the real M1 core and SQLite Adapter, declares complete JSON schemas and returns results once in `structuredContent`. The function creates an unconnected SDK server; the operator owns storage and transport lifecycle. See [tool/protocol evidence and limits](docs/implementation/mcp-tools.md). There is no runnable HTTP service or installed Codex connection in this slice, and exploration authority has not switched.

The local service slice adds the independently/manual-started `npm run --silent start` command and `startLocalMcpService(configuration)` in `src/mcp-service.ts`. It opens supported existing private SQLite storage only, serves authenticated Streamable HTTP at a fixed `127.0.0.1:<port>/mcp`, enforces request/tool admission limits and drains active work on SIGINT/SIGTERM. See [operator configuration and real HTTP lifecycle evidence](docs/implementation/local-mcp-service.md). Automated SDK-client HTTP tests are not installed Codex acceptance; no connection settings or exploration authority have changed.

The [on-demand local ChatGPT test runbook](docs/implementation/local-chatgpt-test-runbook.md) describes the separate foreground Cloudflare connection to an existing SQLite database, its private consistent backups, and its unauthenticated-public-endpoint limitation. It is not a production deployment.

Track implementation in [GitHub Issues](https://github.com/kun-g/wayfinder_map_service/issues) and the private [M1 project board](https://github.com/users/kun-g/projects/5). Active rollback/deletion planning uses [GitHub planning Maps](docs/planning/README.md). Completed M1 planning decisions and prototype captures are preserved in [the planning archive](docs/archive/m1-planning/README.md).

The integration closeout retains all 56 M1 groups, passes 1,167 tests and records actual installed Codex CLI acceptance across independent sessions, stale-write conflicts and service restart. See the [cumulative acceptance report](docs/implementation/mcp-sqlite-acceptance.md) and [native call evidence](docs/implementation/mcp-sqlite-codex-evidence.json). L01–L05 pass, including the explicit live human verdict recorded on 2026-09-19. New exploration Maps now use the [adopted MCP workflow](docs/agents/exploration-mcp.md) as sole authority; its [cross-session evidence](docs/implementation/mcp-exploration-adoption.md) covers creation, resume, Claim, atomic advance, Conflict and outage pause. GitHub remains the implementation tracker, and existing rollback/deletion planning Maps remain there unchanged.

The self-contained workflow follow-on is accepted at `workflowVersion: 2.0.0`. A compatible client can create, resume, Claim and advance a Map from MCP initialization instructions and the four locally sufficient tool descriptions without an installed Skill or repository file. The real journey used ChatGPT Desktop's synchronized Wayfinder-Save connector and independent Codex CLI sessions, retained structured stale-Revision Conflict behavior across restart, and received the explicit live-human verdict on 2026-09-20. See the [self-contained workflow acceptance report](docs/implementation/mcp-self-contained-workflow.md) and [machine-readable evidence](docs/implementation/mcp-self-contained-workflow-evidence.json).

## Project documents

- [Domain language](GLOSSARY.md)
- [v1 executable specification](docs/spec/v1.md)
- [Accepted M1 implementation specification](docs/spec/m1.md)
- [Accepted local MCP/SQLite implementation specification](docs/spec/mcp-sqlite.md)
- [M1 executable acceptance matrix](docs/implementation/m1-acceptance.md)
- [Active planning Maps](docs/planning/README.md)
- [M1 planning archive](docs/archive/m1-planning/README.md)
- [ADR 0001: remote map as authoritative state](docs/adr/0001-remote-map-is-authoritative.md)
- [ADR 0002: MCP tools are the primary interface](docs/adr/0002-mcp-tools-are-the-primary-interface.md)
- [Agent workflow and project-local skills](AGENTS.md)
- [Matt Pocock skill provenance](docs/agents/skills-provenance.md)

## Provenance

The interaction methods originate from Matt Pocock's MIT-licensed [`mattpocock/skills`](https://github.com/mattpocock/skills). This project preserves upstream provenance while maintaining a product-specific adaptation for convergence, persistence, portability, and recovery.
