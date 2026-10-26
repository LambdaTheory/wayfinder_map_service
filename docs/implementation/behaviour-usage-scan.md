# B08 usage inventory and periodic scan

Implements [Issue #79](https://github.com/kun-g/wayfinder_map_service/issues/79) and [R6–R8](../spec/behaviour-testing.md#r6-real-problems-become-scenarios) under `tests/behaviour/scan/`. This read-only local command produces private evidence, unapproved Batch proposals and incomplete [B04 capture](behaviour-capture.md) input drafts. It starts no service, model, browser, tunnel or scheduler, and opens no database.

## Run once, weekly and before release

Use Node 26.3.0. Supply an explicit manifest and a fresh output directory **outside the checkout**, with an existing parent. Importing the module or invoking it without arguments never discovers sources.

```sh
node tests/behaviour/scan/cli.ts \
  --input "$SCAN_INPUT" --out "$FRESH_SCAN_OUTPUT" \
  --state "$PREVIOUS_SCAN_OUTPUT/state.json"
```

Omit `--state` on the first run. Thereafter carry the latest successful `state.json` forward, including runs with no reminders; do not reset it weekly. Invalid/unreadable state fails the command. Preserve a partial output directory for diagnosis and retry with a fresh destination and the last complete state. Use one scan/operator at a time; this is not a concurrent shared reminder service.

The coordinator or Kun runs real scans only after explicit approval to read the selected private sources; workers and reviewers use synthetic fixtures. The same command is available for weekly and pre-release scans. Installing the weekly schedule remains Kun's decision, which the coordinator will ask after integration; this PR references Issue #79 rather than closing it. Inspect gaps and pending evidence, screen candidate leads and preserve all scan directories. No launchd/cron job or Batch is approved by this change. Safe synthetic demonstration:

```sh
node tests/behaviour/scan/cli.ts \
  --input tests/behaviour/fixtures/scan/input.json --out "$FRESH_SCAN_OUTPUT"
```

The summary includes `modelsStarted: 0`, `newFailures: 0`, `batchApproved: false`, session/call/pending/gap counts and the proposed invocation ceiling. Writes, refusals and Conflicts are observations to screen, not authorization verdicts.

Observed synthetic output:

```json
{"sessions":11,"serviceCalls":8,"pending":19,"confirmed":0,"newFailures":0,"reminders":0,"modelsStarted":0,"gaps":3,"batchInvocations":0,"batchApproved":false}
```

## Selecting discoverable evidence

See [`Manifest`](../../tests/behaviour/scan/types.ts) and the runnable [synthetic example](../../tests/behaviour/fixtures/scan/input.json). Each source has a stable public `id`, `kind`, and explicit file/directory `path`, relative to the manifest or absolute. Directories recurse in sorted order through `.jsonl` files; `attempt` sources use `.json`. Symlink files/directories and special files are skipped with a gap. Keep the manifest private, preserve source IDs and archive-relative filenames, and avoid overlapping roots.

| Kind | Operator-selected source |
| --- | --- |
| `codex` | Everyday `~/.codex/sessions/` and `~/.codex/archived_sessions/`, plus each dedicated Codex home's corresponding directories |
| `claude` | Everyday `~/.claude/projects/` and each dedicated Claude home's `projects/`, including subagent records |
| `calls` | B07 `<database>.calls.jsonl`; the database itself is never read |
| `gaps` | B07 `<database>.calls.gaps.jsonl` |
| `launches` | The launcher's `launches.jsonl` |
| `attempt` | Explicit existing B01 Attempt records; optional correlation bridges |

Expand `~` yourself: the reader does not interpret shell syntax. It neither discovers homes nor reads configuration, credentials, memories or arbitrary workspace files. Missing, unreadable, empty, malformed, unsupported and truncated records remain gaps. B07 gap/summary counters and sequence discontinuities remain visible across restart. A missing tail without a surviving counter cannot be reconstructed; discovered files do not establish complete historical coverage.

Locators use `source-id/relative-file#L<number>`; consult the private manifest for the original file. The inventory exports facts and source locators, never session dialogue. Pending leads export eligible evidence locators without text. Only exact, explicitly selected excerpts from an accepted screening/verdict record appear in a lead; unrelated sessions and unselected turns remain absent from every output. Eligible context is the signal's native call/result, preceding human turn and following reply. A user-row Skill signal starts at that user's invocation, without admitting the earlier unrelated human turn. Read wider context from the original privately when necessary rather than copying it into the inventory. Model/effort changes within a native session remain ambiguous instead of attributing all calls to the last model.

Codex support follows repository synthetic rollouts and the public [protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) and [ResponseItem definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs): `session_meta`, `turn_context`, `response_item` and selected `event_msg` envelopes. Claude support follows its documented [JSONL transcript and MCP tool conventions](https://code.claude.com/docs/en/hooks): `sessionId`, message content `tool_use`/`tool_result`, `isSidechain` and `agentId`. Future formats or renamed MCP servers need an explicit adapter update and fixtures.

## Correlation and usage classification

The inventory distinguishes native sessions, launcher-only rows and unmatched service-session rows. A launch joins native evidence only by known native ID **and harness**, then B07 calls by credential fingerprint. A B01 Attempt can supply MCP session IDs and normalized JSON-RPC IDs. Exact request matches require an unambiguous MCP session plus request ID or B07's domain-separated request hash. Numeric/string collisions stay unmatched because B01 currently loses that type distinction. A native tool-use ID is never a JSON-RPC ID; a session association is not a committed-write receipt.

Client ID, model, time proximity and Map ID never assign calls. Same-Combination sessions stay distinct. Fresh launches without native IDs remain launcher-only; no timestamp guess supplies words. One actual conversation may therefore appear as separate native and launch/service rows and produce separate leads until stronger evidence exists. The default fixtures depict resumed launches; `launches-fresh.jsonl` demonstrates this limitation. The inventory records the exact native-ID/harness join separately from the credential-fingerprint join and never claims a native join for placeholders. Claude sidechains share the parent's `sessionId`, so inventory keys include native `agentId` (or file locator if missing) and never inherit the parent's launch. Session-less bookkeeping rows (`summary`, `file-history-snapshot`) do not create sessions. These inventory/reminder keys are not product identities, Client IDs or Claimants.

Usage is `normal`, `test`, `research` or `unknown`. B07 operator labels, B01 provenance and manifest `labels` with explicit `basis` provide evidence. For a Claude subagent, a label must also supply its native `agentId`; a Codex subagent has its own native ID. Subagent status alone does not imply research; prompt keywords do not imply test use. Conflicting labels remain unknown. An unlabeled subagent never inherits a normal parent's purpose.

`skill-only-observed` requires an explicit user invocation at the start of the message (`@wayfinder`, `$wayfinder`, `use the wayfinder skill`), a Claude `/wayfinder` command, or a native Skill-tool invocation. The Claude command-name tag may follow a command-message tag. A developer catalog, negated mention, or maintenance read of `wayfinder/SKILL.md` is insufficient. This conservative recognizer can miss other natural-language invocations; it never infers invocation from a file read. It means no Wayfinder MCP call was observed in supplied evidence; partial logs may hide calls. Injected AGENTS/environment/`user_instructions` context, Claude `isMeta`, `isCompactSummary` and command-output messages never supply original human words. The additional wrapper/compaction exclusions are conservative handling of these markers, verified with synthetic records; no real transcript inspection was performed.

## Screen first, then read original words

All automatic leads start `pending`, with no Batch work or B04 draft until screened; there is no automatic failure rule. Signals group writes, refusals, Conflicts, service/transport failures, Skill-only observations and missing evidence. Every call's exact result class remains in the inventory, including the separate refusal classes; grouping them into one screening lead is not a behaviour verdict. Refusals/Conflicts stay distinct from outages. `authorization` always remains `not-assessed`; normal HITL writes never fail from metadata.

Optional `--reviews "$SCAN_REVIEWS"` accepts an array of [`Review`](../../tests/behaviour/scan/types.ts) records: lead ID, exact evidence hash, reviewer, accepted-rule/evidence basis, reason, disposition and native quotations. It records completed reviews, invokes nobody and approves no quota. Model analysis first needs complete B01 evidence and specified verdict items, then the existing B03b two-review/arbitration machinery in an approved Batch. Link retained review results in `basis`; never substitute one model answer or invent a human ruling.

- `screened` is a relevant signal awaiting judgement, not a failure.
- `needs-human-words` records a specific verdict need after screening; only this disposition requests missing words. ChatGPT metadata alone never triggers a request.
- `confirmed`/`dismissed` require nonempty exact excerpts from original user words **and** native agent/tool evidence at the current hash. Metadata locators cannot supply these. The reviewer must read the relevant exchange and rule; exact string checks verify quotations, not reasoning or authorization.
- Missing-evidence leads cannot become confirmed. Invalid/stale/duplicate new reviews leave a pending lead and visible gap; an already recorded confirmation remains pinned. Unknown never counts as a new failure. Invalid review quotations are not copied to output.

Hashes use the incident evidence after credential redaction; quote the needed excerpt from the private original using the same redaction rules. State schema 2 retains every lead's hash/status and marks it `new`, `changed` or `seen`, including pending/unknown evidence. Schema 1 reminder IDs migrate without being reset. Unchanged seen leads do not reissue work or capture drafts. A current confirmed/dismissed decision never schedules another reading. Keep unfinished prior proposals instead of generating a new Batch every week.

Confirmations retain their original evidence hash and selected quotations even after resume, changed evidence or missing logs; the inventory identifies newer evidence separately. First confirmation counts in `newFailures` independently of a prior screening reminder. Multiple same-kind events in one session remain one screening group: split distinct incidents in B04. This deduplicates leads, not speculative cross-session root causes.

## Private artifacts and B04 handoff

Output is a 0700 directory with 0600 files; existing outputs are refused:

| File | Content |
| --- | --- |
| `inventory.json` | Sources, matches, basis/gaps, evidence locators, accepted selected excerpts and review records, lead status/change markers and summary |
| `state.json` | Seen hashes/statuses, reminder IDs and pinned confirmations with selected excerpts |
| `batch-proposal.json` | Unapproved work and deferred prerequisites |
| `capture-input-drafts.json` | B04-shaped incomplete inputs only for new/changed screened or confirmed leads |

Select the actual incident and exact human turn; drafts carry `humanQuoteRefs` from the selected review evidence when available. Verify its pre-incident Map/Revision using B04's consistent private database copy, choose seed mode and each Claim decision, state correct behaviour and literal redactions, and complete the draft. `revision`, `restores`, `claims`, `humanWords` and `verdict` remain unset; metadata cannot supply them. Then use `capture/cli.ts` and B04's conversion audit, two reproductions and admission into the existing Scenario library. No parallel library is created.

Manifest `secrets` declares literal credentials for stable replacement throughout output, including nested JSON text. Recognizable Bearer/API tokens are also stripped. This is not a complete secret detector: declare arbitrary credential literals and inspect before sharing. Real manifests, review files, inventories, proposals and raw conversations stay private outside Git; only synthetic fixtures and reviewed minimal B04 artifacts enter the repository.

## Batch approval and ceiling

The scan CLI has no approve/run option. For new/changed screened leads, proposals list **five** B03b driver invocations: reviewer availability, arbiter availability, two independent readings and conditional arbitration. Reviewer selection and call order come from the same pure `review-plan.ts` used by B03b itself. Missing words/Combination and incomplete capture prerequisites are deferred. B03b currently leaves effort to the client default, which the plan states explicitly. Reproduction/regression need concrete follow-on plans after the Scenario and original Combination are known; reproduction starts with two Attempts. Never approve vague future scopes or substitute unavailable models.

The explicit [`scan/review.ts`](../../tests/behaviour/scan/review.ts) handoff is separate from the scan CLI and uses the existing B03b executor, not another reviewer:

1. Prepare complete B01 Attempt evidence and specified verdict items. Call `planReviewBatch(report, [{ leadId, directory }])`; it calls B03b `reviewPlan`, binds exact Attempt hashes/items/targets/call slots and sets the ceiling to B03b's actual maximum (five per nonempty review). This step runs no model. The operator supplies the lead-to-Attempt association; the executable plan binds the B01 evidence, not an unused scan hash. The initial scan proposal is not executable until this binding exists.
2. Record Kun's approval against `digest(plan)` and `openLedger(plan, approval)`. A changed approval scope, model, count or ceiling refuses execution. A changed Attempt refuses that run before spending quota and records a per-lead issue; the other approved runs continue. The ledger records approval scope but cannot authenticate the human.
3. Only after approval, call `executeReviewBatch(plan, ledger, driver, persist)`. The caller supplies B03b's Driver and a private durable ledger writer. The adapter passes each round's approved ceiling to B03b `reviewDirectories` (five, even in a ten-call two-lead Batch), while the shared ledger enforces the total Batch ceiling. Both limits come from the one approved plan. It reserves and persists one slot **before** each probe, reading or arbitration; no outer one-slot reservation hides a multi-call round.
4. Each response/error and its request are retained in the ledger; B03b also preserves native round files and attaches its summary. An undecided arbitration, rejected reading or individual failure ends only that lead; remaining approved leads continue without another approval. On resume, any run with a recorded reservation is skipped without replaying its probes or readings, and runs with no reservations proceed. Interrupted/reserved slots stay spent; retrying the unfinished part of a started run needs reconciliation and a separate B03b retry approval. It does not block unstarted runs in the current Batch.
5. `batchStatus` retains complete results, unresolved reservations and the remaining planned invocations. Agreement normally spends four **per lead** and leaves its conditional arbitration unspent; disagreement spends five per lead. Two leads with arbitration can use all ten approved calls. Remaining slots from a skipped run stay visible but are not replayed automatically. Reproduction/regression remain separate explicitly approved runner work.
6. Return `issues` records skipped rounds, individual execution problems and ledger-save failures. A failed pre-call save starts no driver call. If the post-call save fails, the actual response still reaches B03b's native output and summary; the issue is reported separately. Failure of the shared durable ledger stops further calls until storage is restored, after which the durable ledger resumes unstarted runs without new approval. Reaching the Batch ceiling or requesting unplanned work also stops expansion.

## Verification and self-review

All scan evidence is synthetic. Fixed tests cover every Issue sample, metadata-only refusal to judge, normal HITL dismissal, stale/invented quotations, unknown-only pending status, once-only reminders, conditional ChatGPT requests, private output and capped/resumed quota accounting. The CLI runs with an empty executable search path and synthetic HOME. No real logs or model runs are used.

Validation uses Node 26.3.0, `npm ci`, `npm run build`, the complete `npm test` suite, `npm run typecheck` and `git diff --check`. The existing fake runner reads daily login/configuration and snapshots service credentials even in model-free tests. To honor this task's private-read boundary, the complete suite was run with a temporary Vitest setup that returns `false` from `existsSync` for the real `.codex*`, `.claude*`, `.wayfinder-service`, workspace `contexts` and `raw` roots, and throws before reads/copies of those paths. All other filesystem operations, tests and assertions remain unchanged; the temporary setup/config is removed afterward. No real credentials are copied. This guard is verification setup, not part of the scan command or a runner modification.

Initial implementation verification on 2026-10-26: build, **23 test files / 1496 tests** (including **16 scan tests**), strict type checking and whitespace checks passed against `origin/main` at `00c2f4e`. The [independent-review response](behaviour-usage-scan-review.md) records the subsequent regressions, fixes and final validation. All scenarios use fixed evidence or fake drivers; models started: **0**.

Two earlier isolation attempts were rejected by existing tests and retained as diagnostic context: changing HOME caused one runner path/sandbox assertion failure; an outer macOS sandbox prevented nested sandbox tests and exposed the runner's attempted private configuration reads. Neither is reported as a pass. The successful filesystem guard preserves the actual home path for existing sandbox assertions while presenting private client configuration as absent.

| Issue acceptance | Fixed evidence |
| --- | --- |
| Everyday/dedicated native logs, Skill-only, distinct same-Combination sessions and purpose | Native Codex/Claude fixtures, launch labels, B01 request bridge, sidechain and explicit research-label tests |
| Matching basis/gaps and no metadata authorization | Session/request/fingerprint joins, request-type collision/hash tests, metadata-only claimed verdict rejected, normal HITL write dismissed only after words |
| No model quota, proposed Batch and hard ceiling | CLI with empty PATH, exact-plan approval, unplanned work refusal, failure retention, interrupted reservation, ceiling and remaining-list tests |
| Once-only leads and unknown pending | Repeated scan state, retained confirmed findings, missing-evidence leads never failed |
| B04 Scenario handoff | Incomplete typed capture-input drafts; no guessed Revision, Claim choice, words or verdict, and no library mutation |

Standards self-review checked import side effects, explicit filesystem sources, private fresh outputs and conservative handling of malformed evidence. Spec self-review checked correlation, authorization boundaries, proposed-only model work, B04 drafts and no scheduler. Only testing tools and documentation change, so the shipped Release Version stays unchanged. Independent review and merge remain with the coordinator.
