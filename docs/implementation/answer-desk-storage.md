# Answer Desk storage (#111)

Implements the storage, domain-command and inspection-read slice of [Answer Desk](../spec/answer-desk.md) §9. Delivery transports (#112), the keyed browser (#113) and the mandatory workflow (#114) remain separate. No real-model or ChatGPT run is claimed here.

## Staged service setting

`LocalServiceConfiguration.answerDeskEnabled` and `ToolAuthorConfiguration.answerDeskEnabled` default to false. The operator command accepts `WAYFINDER_ANSWER_DESK_ENABLED=true` to enable the desk in isolated runs; `false` or absence disables it, and any other value fails startup. This setting is process configuration, never a client argument or credential privilege.

When disabled, desk commands, `deskAnswer`, `reopenRequestId` and taking-read syntax follow the original input-validation path before storage access. The selected tool schema supplies the allowed top-level fields; `decodeApplyRequest` selects the admitted command kinds and fields using the same setting. Unsupported fields and commands naturally return the same typed `invalid_input` envelope, path and constraint as 3.1.0; no separate disabled-capability error is introduced. Release Version attestation still precedes write admission. Ordinary reads, ordinary M1 writes, four-tool discovery and format-2 migration continue. #112 must put `map_wait`/taking reads behind this same setting; #113 must hide its UI and return 404 from its answer route when disabled. There is no desk UI or browser write route in #111. #114 enables the setting by default.

The schema set is selected per server instance from the same setting, including `toolsOnly` clients. With the setting off, all four complete tool definitions match 3.1.0 (only the tools-only Release Version value changes): no desk commands, citation fields, descriptions, output fields or rejection-code advertisements. Ordinary current/history reads omit `deskQuestions`, `reopenRequests` and `reopenContexts` entirely, including empty arrays. All rejected inputs remain within the declared output schemas, including when an SDK client caches validators through `tools/list`. Both `2025-11-25` and `2026-07-28` use the shared `serverFor` configuration.

A database that has used the desk cannot start a disabled service: startup returns operator-only `answer_desk_required` with “The configured private SQLite database has used Answer Desk; enable answerDeskEnabled (WAYFINDER_ANSWER_DESK_ENABLED=true).” It opens no listener, exposes no partial service and leaves stored Revisions unchanged. The message identifies the configured private SQLite database without printing its path or suggesting deletion/reset. This boundary was confirmed by the coordinator and design session during the second review on 2026-10-27.

`hasDeskHistory()` uses one query with `EXISTS` on the four desk tables, never a Revision scan. The supported write paths retain every question-publication index row through withdrawal, Settlement and reopening; typed answer citations require such a publication; request handling/closure requires a retained request row; human/release writes retain answer/request/quiet-window rows. These rows publish atomically with the corresponding Revision. Format 1 cannot contain these fields, and migration creates empty tables. Thus retained desk rows cover every supported desk-bearing history even when no live question or request remains. A migrated format-2 database with empty tables starts normally with the setting off. Future deletion work must preserve this startup invariant.

With the setting on, the additional commands, fields and inspection results are described in their schemas. The authored workflow and four top-level tool descriptions remain unchanged. W02 retains its full standalone-guidance checks for the default surface; a separate enabled-schema round trip covers the staged capability. **Before #114 merges, synchronize the desk rules into the workflow and all governed tool descriptions.** ChatGPT sees tool definitions without server instructions, so nested schema metadata alone is not the final workflow contract.

## Command and storage seams

- `deskQuestion.post {ticketId, claimantId, question}` publishes on a claimed, open Ticket. `question` carries `questionId`, two or three `options: [{label,description}]`, `recommendedOption` (1-based), `recommendedAnswer`, `whyKun`, `triage`, `triageReason` and `gatesResearch`. A Ticket keeps one `questionId`; each post assigns the next `questionVersion`, snapshots its question text and takes `postedAt` from service mutation authorship. A changed question/type requires withdrawal before updating the Ticket and posting again.
- `deskQuestion.withdraw {ticketId, claimantId, questionId, questionVersion, reason}` withdraws the exact active publication. Both standalone posting and withdrawal create Revisions.
- `ticket.settle.deskAnswer {answerId, questionVersion}` is required for an active question, must cite the current answer Taken by the settling Claimant, and is retained on `StoredSettlement`. The citation resolves to the immutable publication and answer, including the displayed option label and description. Conversation Settlements use withdrawal before Settlement.
- `map_apply.reopenRequestId` binds a batch to a Taken request and its original target Settlement. Its explicit reopen commands must name the target and exactly the currently required settled descendants; every dependent must have the authorized Settlement identity. A shrunk set is allowed. A grown set or changed Settlement returns `reopen_authorization_exceeded` with all `uncoveredTickets` and `not_listed`/`settlement_changed` reasons.
- `reopenRequest.close {requestId,reason}` accepts only a pending/Taken request whose target has lost the recorded Settlement, evaluated after earlier batch commands. Close-only batches create one Revision whose `changes` record each command index, request ID and reason. Repeated closes reject.

Other request rejection codes are `reopen_request_not_found` (including a foreign Map's ID), `reopen_request_pending`, `reopen_request_handled`, `reopen_request_inactive` (cancelled/closed/superseded), `reopen_request_stale`, `reopen_target_omitted`, `reopen_set_mismatch` and `reopen_close_guard`. They use the existing command-stage rejection envelope; a batch-level citation error uses command index 0 and relevant Ticket IDs.

StateAdapter still exposes only `readCurrent`, `readRevision` and `commit`. Immutable question publications live in Revision snapshots and are indexed by `(map_id,question_id,version)` in `desk_questions`. Mutable answers, requests and the Map Quiet Window live only in `desk_answers`, `reopen_requests` and `desk_maps`. Earlier format-1 Revision JSON is never rewritten.

Pure `prepareApply` accepts an optional `DeskState` value and produces a captured request plus prepared desk effects. Both adapters replay the captured request against authoritative state at commit; SQLite does so under `BEGIN IMMEDIATE`, after the existing head comparison. This closes the race in which human writes supersede an answer/request without advancing `currentRevision`. Desk effects, question-index updates, the new Revision and catalog head commit or roll back together. No external side effect occurs during pure preparation.

`SQLiteStorage.desk` is the internal application seam for #112/#113, separate from StateAdapter and unavailable as an MCP answer-writing tool:

| Method | Behavior |
| --- | --- |
| `read(mapId)` | Captured desk state for pure preparation. |
| `inspect(mapId)` | One coherent read transaction for the head Revision and desk projection. |
| `submitAnswers(mapId, submissions)` | Atomic single/bulk submission of `{questionId,questionVersion,choice:{option}|{text}}`; service assigns IDs, labels and timestamps, retains superseded answers and restarts the Map's 15-second Quiet Window. |
| `fileReopenRequest(mapId, submission)` | Verifies the displayed target and entire affected ID/Settlement binding set, validates the source publication for an option, supersedes an older unhandled request and restarts the Quiet Window. |
| `cancelReopenRequest(mapId, requestId)` | Cancels pending requests only and restarts the Quiet Window. |
| `takeEligible(mapId, claimantId)` | Atomic low-level release after quiet: current answers for this Claimant's Tickets plus Map-scoped pending requests; retained Taken state survives receipt loss/restart. #112 owns when a response/task is collected and therefore when to call this method. |

Human and release writes do not create Revisions. Failed validation leaves records and Quiet Window unchanged. SQLite failures retain the existing not-published/unknown/restart semantics. The storage seam has no browser key handling or transport waiting; callers must enforce the service setting, browser authorization and release-response boundary in their respective slices.

## Reopen recovery and read projections

The target reopened by a cited request records `reopenedAtRevision`; the handled request records `handledAtRevision` in the same transaction. Current reads join these identities only while that target is open. They do not choose the latest request on a Ticket. A Settlement removes the association; conversation reopens and reopened dependents receive none.

`FoundMap.reopenContexts` therefore retains Kun's exact option/text after handling, even if the agent stops before re-posting. It persists through N+1, withdrawal and N+2 until the target settles. This satisfies the implementation notes in PR #115 and #116, with a stronger lifetime than just “until re-post.” The source option description is read from the retained publication identified by `requested.questionId` and `questionVersion`. `requestedOption` is emitted on an active publication only when exactly one option matches that source label **and** description; it never creates an answer. Text remains verbatim in `reopenContexts`.

When enabled, current reads include all publications, displayed state, `currentAnswer`, `answerHistory` with derived `stale`, computed unlock/downstream counts, unhandled `reopenRequests` (including stale targets) and `reopenContexts`. Historical reads include only the selected Revision's publications with `published`/`withdrawn`/`superseded_by_reopen` states; they omit all answers, requests, contexts and delivery state. Inspection never takes anything. #113 can use `desk.inspect` for the same projection without duplicating domain logic.

## Format-2 startup

Fresh initialization creates format 2. `openSQLite(path)` requires format 2; only `startLocalMcpService` opts into `openSQLite(path, {migrate:true})`. This format-1 startup path first uses the existing private `VACUUM INTO` backup mechanism through a separate read-only source connection to complete `<db>.pre-format-2.<UTC timestamp>.<nonce>.sqlite` in the same directory. Existing destinations/sidecars are refused; the backup is never automatically removed. One subsequent transaction creates the desk tables and sets `user_version=2`. Failures admit no calls and leave format 1 intact; unknown formats are refused. There is no downgrade API. An older binary cannot open a migrated file: operational rollback requires deliberately selecting a retained format-1 backup, with its snapshot cutoff understood.

The manual `npm run --silent backup -- <source> <destination>` command and every ChatGPT runner backup use `backupSQLite`, a separate read-only connection that accepts either supported format. It does not change source journal settings or migrate either file. `SQLiteStorage.backup` and the pre-migration backup use the same read-only connection path, private destination checks and completion checks.

Repository-wide entry-point audit (third review, 2026-10-27):

| Entry | Database access and migration boundary |
| --- | --- |
| Service operator / launcher service | `startLocalMcpService` is the sole production caller opting into migration. |
| Manual backup CLI / `SQLiteStorage.backup` | Read-only, format-preserving backup path; never opens through the migration-capable adapter. |
| ChatGPT runner, attach | Only checks the existing service and backs up through `backupSQLite`; initial, 30-minute and final backups cannot migrate. |
| ChatGPT runner, owned service | Starts through `startLocalMcpService`; all later backups remain read-only. |
| Viewer | Uses the storage already opened by its host; no separate database open or migration. |
| Behaviour runner / ChatGPT attempt | Initializes disposable storage and starts its owned service through the service entry; capture and upgrade inspection use explicit read-only SQL connections. |
| Codex acceptance helper | Its inspection uses ordinary `openSQLite` with no migration option; format 1 is refused unchanged. |

The attach regression runs the actual runner entry with fake attach HTTP, relay, tunnel process and timer. No socket binds or real tunnel/model calls occur. A format-1 fixture retains committed WAL history and a legacy writer holds `BEGIN IMMEDIATE` across all three backups. The source and all three outputs remain format 1, no pre-migration artifact appears, and the frozen 3.1.0 implementation opens every file and reads its head/history.

## Verification

Tests use only newly created disposable SQLite files and fake clocks/publication boundaries. `tests/answer-desk.test.ts` covers publication/Claim guards, answer replacement versus commit, historical separation, restart, lost taking receipts and once-only taking, source bindings, request authorization/coverage/closure, context continuity and option rematching, queue counts and transactional rollback. `tests/desk-migration.test.ts` covers fresh format 2, WAL-inclusive backup, immutable old Revision bytes, failure boundaries, existing destinations, permissions and unknown/downgrade formats. The CLI regression backs up a format-1 fixture while its legacy connection holds a write lock, checks both files and no migration artifact, then reads them with the frozen 3.1.0 implementation in `tests/helpers/sqlite-v3.1.0.ts`. Startup tests also cover a migrated unused format-2 database, enabled publication followed by disabled restart (including withdrawn history), and request-only cancelled/closed history. MCP tests compare SHA-256 hashes of every complete disabled tool definition against 3.1.0 in ordinary and `toolsOnly` modes, and verify enabled/disabled HTTP behavior through both protocol eras. These baselines normalize only the Release Version, not descriptions or schema content.

Required closeout commands: `npm run build`, `npm test`, `npm run typecheck`, `git diff --check` on Node.js 26.3.0. The PR records the final run counts. This slice has no mandatory workflow change; its behavior evidence is included in the coordinated #114 ChatGPT run, with Kun's approval before that run. Do not infer a real-client acceptance verdict from the automated tests.

First-review worker verification on 2026-10-27, Node.js 26.3.0: `npm run build`, `npm test -- --maxWorkers=2` (**50 files / 2,269 tests passed**), `npm run typecheck` and `git diff --check` passed. The preceding unrestricted `npm test` run hit the existing 5,000 ms timeout in two sandbox fixtures (`dedicated-privacy` artifact redaction and `sessions` concurrent HOME isolation); both passed in the complete lower-concurrency run with the original timeout/assertions unchanged.


## Second review verification (2026-10-27)

Merged SDK v2 `main` at `033b6f9` and advanced the Release Version to 3.2.0. Node.js 26.3.0: `npm run build`, `npm test -- --maxWorkers=2` (**52 files / 2,302 tests passed**, 319.32 s), `npm run typecheck` and `git diff --check` passed. The unrestricted run was interrupted before completion; no verdict is claimed for it. Targeted storage/migration/MCP tests passed **119 tests** before the full run. All databases were newly created fixtures; no real models/clients, everyday-service ports or real database were used.

The three review corrections are covered by the format-preserving CLI regression, the two-era setting matrix and the complete 3.1.0 disabled-definition baseline. The follow-up startup boundary is covered for migrated unused databases, active/withdrawn publication history and request-only cancellation/closure. The retained `afterPublication` fault regression proves lost taking receipt recovery without returning or redelivering the answer.

## Third review verification (2026-10-27)

The disabled-input baseline in `tests/helpers/mcp-disabled-desk-v3.1.0.json` was captured from an exported and built `v3.1.0` (`033b6f910c9102af8ea3d934b7e6bcbabe260bd4`) with the pinned dependencies. `capture-disabled-desk-baseline.mjs` reproduces it using SDK discovery and calls without database access. Its 18 requests cover all three desk command kinds, command-index preservation, `deskAnswer`, `reopenRequestId`, taking-read fields individually and together, and validation precedence. Tests compare complete error envelopes, including `code`, `path` and `constraint`, after `tools/list`; the HTTP matrix covers both eras, absent/false settings and ordinary/`toolsOnly` credentials. Only the Release Version is normalized; modern HTTP server metadata is asserted separately.

Node.js 26.3.0: `npm run build`, `npm test -- --maxWorkers=2` (**52 files / 2,311 tests passed**, 323.73 s), `npm run typecheck` and `git diff --check` passed. The targeted migration/MCP suites passed **98 tests** before the final full run. Version remains 3.2.0. Only disposable fixtures and synthetic clients were used; no real models, real clients, tunnel, everyday-service ports or real database were operated.
