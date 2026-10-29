# Development planning Maps

The existing deletion planning Map remains in GitHub Issues. New exploration uses the [product MCP workflow](../agents/exploration-mcp.md). This file provides legacy planning entry points rather than maintaining a second ticket-state list.

| Planning Destination | GitHub Map | Accepted specification |
| --- | --- | --- |
| Define a minimal local MCP/SQLite service and real Codex acceptance/adoption gate | [Codex MCP and SQLite acceptance planning](https://github.com/LambdaTheory/wayfinder_map_service/issues/27) | [Accepted implementation handoff](../spec/mcp-sqlite.md), delivered through the recorded service, acceptance and workflow-adoption Issues |
| Define the post-M1 Revision rollback contract | [Revision rollback planning](https://github.com/LambdaTheory/wayfinder_map_service/issues/12) | None: the user dropped rollback on 2026-10-25 and the Map was closed as not planned |
| Define post-M1 Ticket and permanent Map deletion contracts | [Ticket and Map deletion planning](https://github.com/LambdaTheory/wayfinder_map_service/issues/17) | Not yet accepted; publish as `docs/spec/deletion.md` after explicit human confirmation |

Each parent Issue has native sub-issues and native blocker edges. Query GitHub for current open/closed state and assignees; file contents are not a live progress mirror. All nine rollback/deletion child Questions were migrated open and unassigned on 2026-09-18, without settling proposals or starting implementation. The four rollback Questions were closed unsettled on 2026-10-25.

New exploration Maps use the accepted [product MCP workflow](../agents/exploration-mcp.md). GitHub remains the implementation tracker, and the existing deletion Map stays on GitHub without migration or dual write.

These Maps plan development decisions; creating a planning parent Issue does not initialize or clone a product Map.

Read [the tracker workflow](../agents/issue-tracker.md) before querying or changing a Map. The accepted M1 foundation is [docs/spec/m1.md](../spec/m1.md); its original decisions and prototypes are preserved in [the frozen M1 planning archive](../archive/m1-planning/README.md). Deletion recommendations in the archived Ticket 07 remain unconfirmed. Ticket 06's Revision history decisions are inherited rather than reopened without cause.
