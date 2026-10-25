# On-demand local ChatGPT test session

This is a durable **local test-data** workflow, not the production Dokploy/OAuth/PostgreSQL deployment. The existing private SQLite database remains authoritative. The foreground connection is started by the operator and stays up until Ctrl-C, SIGTERM, or SIGHUP; it does not create, reset, or replace a database and it has no two-hour timeout or login auto-start.

From the repository with pinned Node.js 26.3.0:

```sh
WAYFINDER_DATABASE_PATH='<absolute path to the existing private maps.sqlite>' npm run --silent chatgpt:test
```

### Attached to the dedicated agents' service

When the `wayfinder` launcher's service already owns port 18766, start this runner with `WAYFINDER_ATTACH_TOKEN` set to a token that service accepts. The launcher does this as `wayfinder chatgpt`, registering a fresh token in the service's [credentials file](local-mcp-service.md#further-credentials) under Client ID `ChatGPT`. The runner then starts no service of its own: it checks that the running service accepts the token, takes the same backups, publishes the relay and tunnel, and on stop leaves that service running. ChatGPT and the dedicated agents use the same Maps at the same time, and each Revision records which of them wrote it.

Only one session can own the fixed loopback ports 18765 and 18766. If the previous two-hour test process is still running, let it finish or stop it from its own terminal before starting this command. A port conflict fails without switching to a different database or port. Ctrl-C gracefully stops the Cloudflare process, relay, and local MCP service. A lost Cloudflare child is retried with bounded backoff while the foreground session remains active; Mac sleep, shutdown, power loss, and broader network outages still make ChatGPT unavailable.

The runner confirms one SQLite `VACUUM INTO` backup before publishing the relay, repeats it every 30 minutes, and attempts a final backup after a graceful stop. Each backup is a fresh private file under `backups/` beside the original database. It never deletes older backups. A failed scheduled or final backup is reported in the terminal; do not assume that a backup succeeded merely because the service remains up. After force-kill or power loss, the most recent completed backup may be older than the last committed Revision. These local backups share the source disk and are **not** protection from disk loss; include the private Wayfinder directory in a separate Mac backup regimen if that failure matters. Do not raw-copy a live SQLite file or its WAL as a substitute for this operation.

The Cloudflare URL forwards to a relay without end-user authentication during a manually started session. Anyone able to reach that URL could read or mutate Maps while it is active. Stop the session when not testing; do not run this public endpoint unattended or treat manual startup as an access-control mechanism. A later private tunnel or user-authenticated endpoint is a separate change. The core MCP service itself remains on loopback with a fresh in-process bearer token on each start. The relay forwards only `/mcp`, so the [read-only Map viewer](map-viewer.md) stays on this Mac; a `viewerUrl` that ChatGPT shows opens only in a browser on the same machine.

The existing backup can be checked by reopening it with `openSQLite` and listing the catalog, without altering the active database. That proves the backup is a recognized, readable Wayfinder SQLite file; it is not a complete disaster-recovery drill. A full restore must target a **new** private path and be validated before any deliberate cutover; never overwrite the active database in place.

## Isolated self-contained-workflow acceptance

The current workflow acceptance is separate from ordinary testing above. Initialize a fresh private database at a new absolute path, then start this foreground runner against that database. The terminal must report the expected version, the one in `package.json`; retain that fixed readiness line without recording the database path or token.

An agent may run this on the user's Mac by driving the ChatGPT app through computer use, after the user agrees to that run (2026-10-25); it takes over the ChatGPT window and stops the dedicated agents' service for the duration. In the app: Plugins, Wayfinder-Save, Manage, **Refresh tools**; then a new chat in Chat mode, outside any project, with the plugin mentioned in each message. ChatGPT shows its model the tool definitions but not the server instructions, so the service serves it in compatibility mode (`toolsOnly`).

In ChatGPT Web developer mode, create or refresh the MCP connection and rescan tools after the runner is ready. Do not install or inject the Wayfinder Skill, `AGENTS.md`, `docs/agents/exploration-mcp.md`, or copied workflow/safety text. Preserve the native initialize response when the client exposes it, the exact tool calls/results, client version and failed attempts. Report Resources and Prompts separately as `available`, `unavailable` or `undocumented`; their absence does not fail the core instructions/tool-metadata gate.

Use one shared acceptance Map for the entire journey. ChatGPT Web must page the catalog to completion, create once and atomically publish Tickets, Dependencies, Fog and Scope Exclusions. Leave one HITL Ticket open. An independent installed Codex CLI session must discover the stable Map ID, default-read, Claim and settle one AFK Ticket. The original ChatGPT session then makes one intentional stale write, observes Conflict, rereads and abandons the stale request without replay. Stop the foreground runner and confirm the affected client does not advance through files, conversation, GitHub or another authority; after restart, new sessions must observe the same Revision, history and Claims.

Only after the live user supplies the HITL verdict may that Ticket receive its Decision and rationale. Redact credentials and private paths from the evidence, stop the tunnel when finished, and keep this fresh database separate from the ordinary test database. The final user verdict accepts or rejects the complete evidence; automated results or a screenshot do not substitute.
