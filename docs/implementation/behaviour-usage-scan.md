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

The coordinator or Kun runs real scans only after explicit approval to read the selected private sources; workers and reviewers use synthetic fixtures. Kun decided on 2026-10-26 that the weekly scan runs from his workspace's weekly system report; this repository creates no scheduled task. Before tagging a release, the coordinator runs the same scan. This records the scheduling decision left open by Issue #79. Inspect gaps and pending evidence, screen candidate leads and preserve all scan directories. This decision approves no model Batch. Safe synthetic demonstration:

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

Codex support retains the repository's synthetic `session_meta` and `turn_context` rollouts, `response_item` messages and `function_call` / `function_call_output` pairs, plus `event_msg` messages (`user_message`, `agent_message`) and `thread_settings_applied`. It also reads `event_msg` / `item_completed` with `item.type == "McpToolCall"` and terminal `status` (`completed` or `failed`). This added shape is checked against the coordinator's field-only record from **Codex CLI 0.164.x**, published in [Issue #102](https://github.com/kun-g/wayfinder_map_service/issues/102); the fixture invents all values and no real session is read. It retains `item.id`, `payload.turn_id`, tool, result class and source line. Only `item.server == "wayfinder"` and exactly `map_create`, `map_apply`, `map_list` or `map_read` count. Code-mode `custom_tool_call` named `exec` needs no corresponding `function_call`; other servers and connector names such as `wayfinder_save.map_read` are excluded.

Result classification reuses `classifyResult`, matching the product's [`classifyCallResult`](../../src/call-metadata.ts): `committed` is a write; `found` / `listed` are reads; `rejected` retains the refusal subtype; `conflict` remains distinct. [`mcp-tools.ts`](../../src/mcp-tools.ts) and [`mcp-http-internal.ts`](../../src/mcp-http-internal.ts) return `isError: true` with `kind: "infrastructure_error"`, classified as `service-failure`. A failed completion without a recognizable product result, or `{content, isError: true}` without a product kind, is `transport-failure`, as in the product classifier's default; neither proves a refusal or a service/storage outcome. The product kind takes precedence over client `status` and the `isError` flag, so a failed completion carrying `infrastructure_error` remains a service failure. Existing structured, text-encoded and direct result handling is unchanged.

Claude support follows its documented [JSONL transcript and MCP tool conventions](https://code.claude.com/docs/en/hooks): `sessionId`, message content `tool_use`/`tool_result`, `isSidechain` and `agentId`. Future formats or renamed MCP servers need an explicit adapter update and fixtures.

Original human words also include Claude `AskUserQuestion` answers: match a result's `tool_use_id` to an earlier assistant `AskUserQuestion` call in the same native session/sidechain, then take the nonblank string values of `toolUseResult.answers` for those questions. Append each answered question's optional `toolUseResult.annotations[question].notes` string, locating the `user` fragment at the **result row**. The exact text format follows the **call's question order**, not the answers map's key order: each answer, then its note if present, separated by `\n`. Text within each answer and note is preserved verbatim, including embedded newlines, so one answer need not occupy only one line.

Question text, option descriptions and `annotations[question].preview` are agent-authored context, never human words; the question call is retained as an `assistant` fragment. A selected option label is agent-written text the human chose, so it counts as their answer, not necessarily their own phrasing. Reviewers must read the original question in the selected private source to interpret that choice; the preceding question call is not automatically part of the later write's incident evidence. An answer beginning `@wayfinder` is still an answer, not a new Skill invocation.

This uses structured answers instead of the rendered `content` summary because that summary mixes question text, answers and agent instructions, and quoted/free-text answers cannot be split reliably. [Issue #104](https://github.com/kun-g/wayfinder_map_service/issues/104) provides the question/answer envelope. The additional field contract supplied for implementation is recorded here and in the [synthetic fixture](../../tests/behaviour/fixtures/scan/claude-ask-user-question.jsonl), without copying real values:

```ts
toolUseResult: {
  questions: Array<{ question: string; /* other question fields */ }>;
  answers: Record<string, string>; // question → selected label(s) or free text
  annotations?: Record<string, { notes?: string; preview?: string }>;
} | string;
```

Only `annotations[question].notes` is human-entered annotation text; `preview` is excluded. The supplied examples had empty annotations, so notes have synthetic coverage only and remain unverified against real data. A string-only result carries no structured answers.

Matched AskUserQuestion results without usable answers (including cancellation, decline or error) are retained as `tool` fragments. A string-only `toolUseResult`, unknown answer shape, unmatched call, injected/meta row or row with several results does not supply human words; the reader does not guess from the summary. All other tool results preserve the earlier behaviour: only results of tracked Wayfinder calls produce fragments, and untracked Read/Bash/Skill/other-tool results are omitted, even when they share a row with a write result. Codex message/event handling is unchanged. Answers can supply the preceding human turn for a later write's evidence, but still require an explicit review before a lead becomes `dismissed` or `confirmed`.

Existing Claude evidence hashes near AskUserQuestion exchanges can change: an answer can become the preceding human turn, while a question call after a write can become its following assistant reply, and answers stop the forward search. Such leads appear as `changed`; submitting a review bound to the old hash reports it stale, so re-read the affected exchange and screen against the new hash. Existing pinned confirmations retain their original evidence as described below. Untracked tool outputs do not change a write's evidence hash merely by sharing its result row.

## Result classification and mirrored Codex calls

Service observations with `httpStatus: 401` become the scan-only result `unauthenticated`, grouped as refusal even when authentication stopped the request before its tool was known. Other statuses and missing status retain their recorded result; a generic transport error is never guessed to be authentication failure. Shipped service metadata and Scenario verdict classification are unchanged.

A Codex `function_call` and `McpToolCall` completion with the same native ID become one call in either order. A later function call supplies its original input fragment and locator, including a Map ID missing from the completion. The completion owns the result and result locator; a trailing `function_call_output` does not replace it or add a mirrored result fragment. Different IDs stay separate because no evidence establishes that they are the same call.

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

### Issue #102 verification (2026-10-26)

Before the reader change, the new synthetic completion fixture produced **zero calls** and `activity: "unrelated"`: the call/turn/result test and the MCP-activity/lead test both failed. After the change, all ten calls are classified, the session is `mcp`, and write/refusal/Conflict/failure leads match the existing Claude reader. Thirteen focused cases also cover non-Wayfinder servers, connector names, malformed tool names, nonterminal/unrelated events and a completion paired with an existing `function_call`.

On base `7b1a04b`, Node 26.3.0 validation passed: `npm ci`, `npm run build`, **27 test files / 1697 tests** in the complete `npm test` suite, `npm run typecheck` and `git diff --check`. The full-suite invocation used `--config .vitest/issue-102/vitest.config.mjs` for a temporary private-source guard: private configuration appeared absent, reads/copies were refused, and the old runner's `lsof` probes for everyday-service ports were suppressed. Test assertions and fake drivers were unchanged; the temporary configuration and guard were removed, not committed. Real sessions, metadata and credentials read: **0**; real models started: **0**.

Standards self-review found no remaining issue: the reader reuses result classification and lead generation, preserves legacy handling and requires exact server/tool names. Spec self-review found no remaining issue against #102: synthetic completion/failure coverage, native call/turn attribution, product-based result classes, Claude-equivalent leads, exclusions and Kun's scheduling decision are recorded. Changes are confined to testing tools and documentation; the Release Version remains unchanged.

### Issue #104 verification (2026-10-26)

Before the reader change, **26 of the first 28 synthetic regression cases failed**: the answer was absent and the write's preceding human turn was the earlier request, not the answer. The final **29 cases** pass, covering answer/note extraction, exclusion of questions and previews, exact result-row references, dismissal with answer plus write, free text, cancellation/decline, other tools, mismatched IDs/sessions/sidechains, multiple outstanding questions, ambiguous rows and unchanged Codex replies.

On base `c89262b`, Node 26.3.0 validation passed: `npm ci`, `npm run build`, **28 test files / 1726 tests** in the complete `npm test` suite, `npm run typecheck` and `git diff --check`. The suite used `--config .vitest/issue-104/vitest.config.mjs` with the same temporary private-source protection described above: private configuration appeared absent, reads/copies were refused and everyday-service `lsof` probes were suppressed. The temporary guard and configuration were removed afterward. Real sessions, metadata and credentials read: **0**; real models started: **0**.

Standards self-review found no remaining issue: the extraction is local to the Claude reader, preserves exact strings, keeps tool outcomes separate and requires a matching prior call in the same session. Spec self-review found no remaining issue against #104: answers and notes supply human evidence, questions/previews do not, unanswered results remain tools, and the existing explicit-review requirement still controls dismissal. Notes are verified only with synthetic data; unknown answer shapes remain tool evidence. Only testing tools and documentation change, so the Release Version stays unchanged and no product behaviour or ChatGPT acceptance run is triggered; independent review and merge remain with the coordinator.

### PR #105 independent-review response (2026-10-26)

The [independent review](https://github.com/kun-g/wayfinder_map_service/pull/105#issuecomment-6415357519) found that the initial fallback admitted every Claude tool result, contrary to the earlier claim that this was unchanged. The revised tests first produced **9 failures / 29 passes** on `96aec7c`, including the missing fixture-catalog row and a synthetic Read result sharing a write's result row: its unrelated output incorrectly satisfied the action-evidence requirement for both `dismissed` and `confirmed`.

The reader now adds fragments only for matched AskUserQuestion exchanges; other results go through the original Wayfinder-only `result()` handler. The regression proves untracked outputs are absent, cannot support either verdict and do not alter the shared-row incident hash. The fixture catalog is complete. Additional tests preserve call question order and prevent answers starting `@wayfinder` from invoking a Skill; these two behaviours already passed before the fix. All review suggestions were adopted: the documentation records the exact text format, selected-label meaning, field contract and hash changes; names and the single-result condition are clearer, and the duplicate call lookup is removed.

Final Node 26.3.0 validation: `npm run build`, **28 test files / 1735 tests** via `npm test -- --config .vitest/issue-104-review/vitest.config.mjs` (including **91 scan tests / 38 AskUserQuestion cases**), `npm run typecheck` and `git diff --check` passed. The temporary private-source guard and configuration were removed without committing them; only synthetic evidence and fake drivers were used. Standards and Spec self-review found no remaining issue in the corrected scope; the Release Version is unchanged and independent re-review/merge remain with the coordinator.
