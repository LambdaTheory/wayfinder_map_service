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

Run the same command weekly and before preparing each release's behaviour Batch. Inspect gaps and pending evidence, screen candidate leads and preserve all scan directories. This defines the cadence and manual mechanism only: no launchd/cron job or Batch is created or approved by this change. Safe synthetic demonstration:

```sh
node tests/behaviour/scan/cli.ts \
  --input tests/behaviour/fixtures/scan/input.json --out "$FRESH_SCAN_OUTPUT"
```

The summary includes `modelsStarted: 0`, `newFailures: 0`, `batchApproved: false`, session/call/pending/gap counts and the proposed invocation ceiling. Writes, refusals and Conflicts are observations to screen, not authorization verdicts.

Observed synthetic output:

```json
{"sessions":11,"serviceCalls":8,"pending":19,"confirmed":0,"newFailures":0,"reminders":0,"modelsStarted":0,"gaps":3,"batchInvocations":18,"batchApproved":false}
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

Locators use `source-id/relative-file#L<number>`; consult the private manifest for the original file. Fragments retain native user/assistant messages and Wayfinder calls/results, not shell output or unrelated tool bodies. Model/effort changes within a native session remain ambiguous instead of attributing all calls to the last model.

Codex support follows repository synthetic rollouts and the public [protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) and [ResponseItem definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs): `session_meta`, `turn_context`, `response_item` and selected `event_msg` envelopes. Claude support follows its documented [JSONL transcript and MCP tool conventions](https://code.claude.com/docs/en/hooks): `sessionId`, message content `tool_use`/`tool_result`, `isSidechain` and `agentId`. Future formats or renamed MCP servers need an explicit adapter update and fixtures.

## Correlation and usage classification

The inventory distinguishes native sessions, launcher-only rows and unmatched service-session rows. A launch joins native evidence only by known native ID **and harness**, then B07 calls by credential fingerprint. A B01 Attempt can supply MCP session IDs and normalized JSON-RPC IDs. Exact request matches require an unambiguous MCP session plus request ID or B07's domain-separated request hash. Numeric/string collisions stay unmatched because B01 currently loses that type distinction. A native tool-use ID is never a JSON-RPC ID; a session association is not a committed-write receipt.

Client ID, model, time proximity and Map ID never assign calls. Same-Combination sessions stay distinct. Fresh launches without native IDs remain launcher-only; no timestamp guess supplies words. Claude sidechains share the parent's `sessionId`, so inventory keys include the native `agentId` (or file locator if missing) and never inherit the parent's launch. These local inventory/reminder keys are not new product identities, Client IDs or Claimants.

Usage is `normal`, `test`, `research` or `unknown`. B07 operator labels, B01 provenance and manifest `labels` with explicit `basis` provide evidence. For a Claude subagent, a label must also supply its native `agentId`; a Codex subagent has its own native ID. Subagent status alone does not imply research; prompt keywords do not imply test use. Conflicting labels remain unknown. An unlabeled subagent never inherits a normal parent's purpose.

`skill-only-observed` requires an explicit user Skill invocation or native Skill/read-tool invocation; a developer Skill catalog is insufficient. It means no Wayfinder MCP call was observed in supplied evidence; partial logs may still hide calls.

## Screen first, then read original words

All automatic leads start `pending`; there is no automatic failure rule. Signals group writes, refusals, Conflicts, service/transport failures, Skill-only observations and missing evidence. Refusals/Conflicts stay distinct from outages. `authorization` always remains `not-assessed`; normal HITL writes never fail from metadata.

Optional `--reviews "$SCAN_REVIEWS"` accepts an array of [`Review`](../../tests/behaviour/scan/types.ts) records: lead ID, exact evidence hash, reviewer, accepted-rule/evidence basis, reason, disposition and native quotations. It records completed reviews, invokes nobody and approves no quota. Model analysis first needs complete B01 evidence and specified verdict items, then the existing B03b two-review/arbitration machinery in an approved Batch. Link retained review results in `basis`; never substitute one model answer or invent a human ruling.

- `screened` is a relevant signal awaiting judgement, not a failure.
- `needs-human-words` records a specific verdict need after screening; only this disposition requests missing words. ChatGPT metadata alone never triggers a request.
- `confirmed`/`dismissed` require nonempty exact excerpts from original user words **and** native agent/tool evidence at the current hash. Metadata locators cannot supply these. The reviewer must read the relevant exchange and rule; exact string checks verify quotations, not reasoning or authorization.
- Missing-evidence leads cannot become confirmed. Invalid/stale/duplicate reviews leave a pending lead and visible gap. Unknown never counts as a new failure.

Fragments and hashes use redacted evidence so reviewers can quote exactly the output they received. Preserve originals privately for contextual reading. Reminder state records each screened/confirmed native/launch/service-session-and-signal lead once. Later scans retain it without reminding again, even if it later becomes confirmed. Multiple same-kind events in one session form one screening group: split distinct incidents in B04. This deduplicates leads, not speculative cross-session root causes.

## Private artifacts and B04 handoff

Output is a 0700 directory with 0600 files; existing outputs are refused:

| File | Content |
| --- | --- |
| `inventory.json` | Sources, matches, basis/gaps, private fragments, retained review inputs, lead statuses and summary |
| `state.json` | Reminder IDs only |
| `batch-proposal.json` | Unapproved work and deferred prerequisites |
| `capture-input-drafts.json` | B04-shaped incomplete inputs; never automatically admitted or executed |

Select the actual incident and exact human turn. Verify its pre-incident Map/Revision using B04's consistent private database copy, choose seed mode and each Claim decision, state correct behaviour and literal redactions, and complete the draft. `revision`, `restores`, `claims`, `humanWords` and `verdict` are deliberately unset; metadata cannot supply them. Then use `capture/cli.ts` and B04's conversion audit, two reproductions and admission into the existing Scenario library. No parallel library is created.

Manifest `secrets` declares literal credentials for stable replacement throughout output, including nested JSON text. Recognizable Bearer/API tokens are also stripped. This is not a complete secret detector: declare arbitrary credential literals and inspect before sharing. Real manifests, review files, inventories, proposals and raw conversations stay private outside Git; only synthetic fixtures and reviewed minimal B04 artifacts enter the repository.

## Batch approval and ceiling

The scan CLI has no approve/run option. Proposals list reviewer Combinations, lead/evidence scope, two readings, optional stronger arbitration, extra review counts and total invocation ceiling. Missing words and incomplete capture prerequisites are deferred. Reproduction/regression need concrete follow-on plans after the Scenario and original Combination are known; reproduction starts with two Attempts. Never approve vague future scopes or substitute unavailable models.

[`batch.ts`](../../tests/behaviour/scan/batch.ts) is accounting for an external approved executor, not another runner:

1. Finalize `BatchPlan` rows for reading, reproduction, regression or arbitration: exact Combination, scope, repetitions, extra reviews, evidence hash and prerequisites. Count every model invocation, including quota-spending probes. The operator verifies prerequisites before executing a row.
2. Record Kun's approval reference and approver against exact `digest(plan)`; `openLedger` rejects absent/mismatched approval. This records scope and cannot authenticate the approving human.
3. Call `reserve` and durably save its returned ledger **before** the existing runner/B03b invocation. Each invocation consumes a slot, including failures, timeouts, crashes and extra reviews. These helpers execute nothing. The coordinator must constrain the existing runner/reviewer to the same approved work; no automatic integration grants more work.
4. Save `finish` with complete results/raw artifact references. Completed/failed results cannot be overwritten. Interrupted reservations stay unresolved and spent after resume, never silently retried.
5. At the ceiling `reserve` refuses more work. `batchStatus` retains all results, unresolved reservations and the exact remaining list. Changed scope, models, evidence, retry counts or ceiling require a new approval and plan.

## Verification and self-review

All scan evidence is synthetic. Fixed tests cover every Issue sample, metadata-only refusal to judge, normal HITL dismissal, stale/invented quotations, unknown-only pending status, once-only reminders, conditional ChatGPT requests, private output and capped/resumed quota accounting. The CLI runs with an empty executable search path and synthetic HOME. No real logs or model runs are used.

Validation uses Node 26.3.0, `npm ci`, `npm run build`, the complete `npm test` suite, `npm run typecheck` and `git diff --check`. The existing fake runner reads daily login/configuration and snapshots service credentials even in model-free tests. To honor this task's private-read boundary, the complete suite was run with a temporary Vitest setup that returns `false` from `existsSync` for the real `.codex*`, `.claude*`, `.wayfinder-service`, workspace `contexts` and `raw` roots, and throws before reads/copies of those paths. All other filesystem operations, tests and assertions remain unchanged; the temporary setup/config is removed afterward. No real credentials are copied. This guard is verification setup, not part of the scan command or a runner modification.

Final verification on 2026-10-26: build, **23 test files / 1496 tests** (including **16 scan tests**), strict type checking and whitespace checks passed after fetching/merging current `origin/main` at `00c2f4e`. All scenarios used fixed evidence or fake drivers; models started: **0**. The PR identifies the final implementation commit.

Two earlier isolation attempts were rejected by existing tests and retained as diagnostic context: changing HOME caused one runner path/sandbox assertion failure; an outer macOS sandbox prevented nested sandbox tests and exposed the runner's attempted private configuration reads. Neither is reported as a pass. The successful filesystem guard preserves the actual home path for existing sandbox assertions while presenting private client configuration as absent.

| Issue acceptance | Fixed evidence |
| --- | --- |
| Everyday/dedicated native logs, Skill-only, distinct same-Combination sessions and purpose | Native Codex/Claude fixtures, launch labels, B01 request bridge, sidechain and explicit research-label tests |
| Matching basis/gaps and no metadata authorization | Session/request/fingerprint joins, request-type collision/hash tests, metadata-only claimed verdict rejected, normal HITL write dismissed only after words |
| No model quota, proposed Batch and hard ceiling | CLI with empty PATH, exact-plan approval, unplanned work refusal, failure retention, interrupted reservation, ceiling and remaining-list tests |
| Once-only leads and unknown pending | Repeated scan state, retained confirmed findings, missing-evidence leads never failed |
| B04 Scenario handoff | Incomplete typed capture-input drafts; no guessed Revision, Claim choice, words or verdict, and no library mutation |

Standards self-review checked import side effects, explicit filesystem sources, private fresh outputs and conservative handling of malformed evidence. Spec self-review checked correlation, authorization boundaries, proposed-only model work, B04 drafts and no scheduler. Only testing tools and documentation change, so the shipped Release Version stays unchanged. Independent review and merge remain with the coordinator.
