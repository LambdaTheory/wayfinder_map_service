# Answer Desk delivery (Refs #112)

Implements the staged transport/delivery slice of [Answer Desk](../spec/answer-desk.md) §§4, 6, 8 and 9. Release Version **3.3.0**. The desk remains **disabled by default** behind the existing `answerDeskEnabled` / `WAYFINDER_ANSWER_DESK_ENABLED=true` setting. The viewer and keyed browser route belong to #113; mandatory workflow changes and actual-client acceptance remain with #114. This record claims synthetic clients and disposable databases only.

## Service boundaries

`serverFor` passes the same setting and service-owned `DeskDelivery` coordinator to legacy sessions and modern request-scoped servers. Disabled discovery is still exactly the four original definitions; the schema-selected validation path and full error-envelope baselines remain unchanged. Enabled discovery is exactly five tools, adding `map_wait`, taking-read inputs/output and task capabilities. Generated build metadata records both exact tool sets and runtime definitions assert against it. The authored workflow and its four existing description blocks remain byte-identical. The new `map_wait` description explains parameters, timing, task/blocking selection, cancellation, outcomes and recovery; #114 still owns publication of desk rules into all governed descriptions.

`map_wait` checks the Release Version, IDs and execution-specific integer range before registering anything: blocking default 600 / maximum 1,500 seconds; task default/maximum 28,800 seconds. Taking `map_read` requires both `claimantId` and `version`, omits `revision`, and uses the same release coordinator without waiting. Version mismatch returns no Map state. Ordinary and historical reads do not take; tools-only taking-read and wait schemas state the Release Version.

Tasks use the modern `io.modelcontextprotocol/tasks` capability in the request envelope. Legacy clients and modern clients without it use blocking calls. The actual recorded ChatGPT capabilities advertise the UI extension, not Tasks; the regression replays those capabilities under tools-only mode and verifies an ordinary blocking result. The dedicated Codex template and per-launch override set `tool_timeout_sec=1800`, including existing state directories whose template was copied earlier; no global client configuration is edited.

## Release and lifetime

`DeskDelivery` reuses `SQLiteStorage.desk.takeEligible`: every release atomically rechecks current publication, answer supersession, Claim ownership and the Map Quiet Window, takes all eligible answers plus pending Map-scoped Reopen Requests, and leaves the Revision unchanged. Stale-target pending Reopen Requests are intentionally delivered: the accepted contract requires their recovery projection to show `stale`, and the separate `map_apply` citation guards refuse obsolete authorization. A missing receipt never returns an item or settles a Ticket.

A task handle does not take answers. The first `tasks/get` able to return completed queues a release and rechecks there; concurrent getters share one collection and retain that exact result. If a taking read, replacement, withdrawal or other claimant consumes eligibility while collection queues, the task completes with `none_yet` (and `quietUntil` if appropriate). A blocking wait continues waiting after such a recheck until delivery or its deadline. `tasks/get` and `tasks/cancel` require the capability; `tasks/update` is rejected because there is no input phase. Task methods require `Mcp-Name` as well as the modern protocol and method headers.

The service owns the task registry, shared across request instances and isolated from other service instances. Handles are random UUIDs bound to the authenticated credential identity, not caller-supplied client metadata. TTL is the effective wait bound plus 600,000 ms from creation. Expired tasks are removed on registry access; at 1,000 retained tasks new task admission returns `service_busy` rather than evicting a live handle. Restart forgets handles but retains SQLite Taken records; current reads recover them. There are no task notifications or subscriptions.

One suspended wait per `(mapId, claimantId)` is retained; a newer wait supersedes its predecessor across task/blocking paths. Suspended waits release the existing four-call admission slot. Their release queues for a slot with cancellation, instead of returning a contention error. New ordinary calls still receive `service_busy` at four active calls. Cancellation stops before release, or preserves already-committed Taken if it arrives afterwards. Stop prevents new waits, interrupts blocking waits, fails tasks with `service stopping`, drains outstanding calls (including disconnected ones), then closes storage.

Blocking waits check eligibility at most once per second and send monotonic progress every ten seconds when the caller supplies a progress token. Tests control clocks and publication/admission boundaries; they do not sleep to choose a race winner. Legacy MCP cancellation ends its empty HTTP SSE stream as well as aborting the wait; modern HTTP abort tears down its request-scoped server, including waits with no progress token and no SSE response yet. These paths are checked before invoking service stop so shutdown cannot hide an abandoned wait.

## SSE and privacy

`sendMcpResponse` forwards progress before completion, decodes arbitrary UTF-8 and event boundaries, handles CRLF/multiline event data, and observes only terminal JSON-RPC responses. Protocol error messages/data are replaced with a fixed safe message; neither progress nor task payloads enter operational logs. A disconnected SSE reader is cancelled so response draining cannot hang. Invalid stream data after headers closes the response rather than attempting a second header write. The metadata allowlists include `map_wait` and the three task methods; task handles and answer content are not logged.

Reference sources checked on 2026-10-27: the installed `@modelcontextprotocol/server-everything@2.0.1` `dist/server/tasks.js`, the [official released task schema](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts), and the installed SDK 2.4.0 declarations/implementation. No Tasks SDK dependency or new transport is added; the reference's process-wide registry is adapted to service ownership, authenticated identity, admission and durable collection.

## Follow-ups from earlier reviews

| Earlier review item | Treatment here |
| --- | --- |
| #140 SSE/progress parsing and safe diagnostics | Implemented streaming response parsing and tests, including progress observed before completion and redacted terminal errors. Existing relay tests remain independent evidence. |
| #140 `Mcp-Name` for task methods | Corrected the protocol-header list in §15.2; HTTP task tests send the three named methods. |
| #141 flag through both protocol factories / exact disabled surface | Keep the single `serverFor`; both eras test enabled five-tool and disabled four-tool discovery, full disabled definitions and full disabled rejection envelopes after SDK schema caching. |
| #141 release-number collision | This branch advances 3.2.0 to 3.3.0. #113 edits the same version files concurrently; whichever merges later must advance again. Coordinator owns merge and tag. |
| #141 `takeEligible` semantics, including stale requests | Reused and rechecked at collection, with competing collection/read, changed-window, wrong-claimant and stale-request tests. Existing Claim-return and Settlement guards remain unchanged. |
| #141 unknown taking receipt | Existing `afterPublication` regression retained; added task-delivery fault/restart coverage proving Taken recovery and no redelivery. |
| #141 `decodeApplyRequest` default | New wait/read code never calls this decoder. The existing MCP write caller continues to pass the setting explicitly. Retained the domain decoder's default for compatibility with public pure preparation; making it required/default-off is outside this additive delivery change. |
| #141 direct-embed startup check | Retained `createMapMcpServer`'s check as protection for embedders; the HTTP service also checks before opening the listener. |
| #141 citation errors at command index 0, repeated command names, Question Version schema naming | No new command/citation path here; retained the existing #111 contract. These nonblocking contract/cleanup suggestions remain for #114 review. |
| #141 attach helper `mock.module` deprecation / capture of desk history | Retained the coordinator's deferral to #114; no backup or capture change here. |

The earlier disabled-used-database concern is already covered by startup refusal in #111. Existing storage/domain documentation records the active-question edit guard, publication index and request coverage behavior; this slice does not change them.

## Verification

Focused tests cover quiet batching, once-only collection, task/reading competition, rechecks after admission waits, cancellation before/after release, supersession, ownership, timeout/TTL, shutdown, stale requests, unknown receipt/restart, version/range validation, SSE streaming, the recorded ChatGPT capability envelope, and both protocol eras. Existing disabled baselines normalize only the Release Version.

Final verification on Node.js **26.3.0**, 2026-10-27: `npm run build`, `npm test -- --maxWorkers=2` (**55 files / 2,350 tests passed**, 321.44 s), `npm run typecheck` and `git diff --check` all passed. The preceding complete run passed 2,348 tests; the final run includes the additional no-progress cancellation cases and modern HTTP teardown correction. Real Claude wake-up, Codex completion and ChatGPT turn-start journeys require the coordinator's approved run; no model turn, actual interactive client, tunnel, everyday-service port or real database was used here.
