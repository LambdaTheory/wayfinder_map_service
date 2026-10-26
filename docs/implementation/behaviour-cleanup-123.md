# Behaviour tooling cleanup — Issue #123

Implements [#123](https://github.com/kun-g/wayfinder_map_service/issues/123), based on main `4fc48d004d2734d2c04ef6d18cc78663d7133035`, on 2026-10-27. Changes stay in `tests/behaviour/` and documentation. Release Version `2.1.0`, shipped code, Scenario definitions and verdict rules stay unchanged.

## Acceptance evidence

| Item | Change | Verification |
| --- | --- | --- |
| Codex Dedicated onboarding | Add `dedicated` to onboarded Entries; cite approved `B02d-onboarding-20261026` and [#68 closeout](https://github.com/kun-g/wayfinder_map_service/issues/68#issuecomment-6418579634). Update current onboarding documentation. | `dedicated.test.ts` checks the profile and capability visibility; `library.test.ts` checks applicability while retaining unverified concurrent-session capability. |
| HTTP 401 in usage scans | Classify recorded HTTP 401 as scan-only `unauthenticated` and screen it as refusal, including observations without a tool name. | `scan.test.ts` uses synthetic service metadata; 503 and absent status retain `transport-failure`. No change to shared result classification. |
| Dedicated startup failure | Catalog export cannot overwrite an earlier non-complete outcome, including `service-failed`, timeout, cancellation, rate limit, launch failure and `precondition-not-met`. | `dedicated.test.ts` injects startup rejection for both Entries, asserts retained outcome/record, missing Maps and no client turns. The additional unmet-precondition/export-failure case remains `incomplete`, with unknown dependent items and zero pass/fail counts. |
| ChatGPT command | Refuse target-identified tunnel commands unless recognized as read-only diagnostics, ignore UUID/name case locally and UUID case remotely, append refusal observations as JSONL. | `chatgpt.test.ts` covers named/equal/short flags, unknown options, diagnostic exclusions, own PID, unrelated tunnel and remote identity controls. Fake leases reject before start. Log regressions preserve inode/byte prefix for sequential and simultaneous refusals, with counts remaining one per refusal. Existing privacy, abrupt-exit, SIGKILL, forwarding and verdict-equivalence checks remain. |
| Interactive host limit | State the busy-parent-PID-poll race in Limits, with the fake Claude re-review's 6/7 observation and its relationship to pre-exit sockets. | Documentation checked against [PR #122 review](https://github.com/kun-g/wayfinder_map_service/pull/122); no interactive host behavior changed. |
| Pipe-race regression | Hold real drained-pipe close notifications until the overdue timer has run, then deliver them. | `turn.test.ts` covers 0 and 256 KiB output. Temporarily restoring the old unconditional watchdog fails both cases in all six runs (12/12); restored current code passes both in three runs (6/6). `runner/codex.ts` has no final diff. |
| Codex mirrored calls | Merge one native ID in either event order; retain exactly one function input/locator and one completion result/locator, ignoring trailing mirrored output. | `read.test.ts` checks both orders and `completed`/`failed` states, one call, original arguments, `service-failure`, completion result reference and exactly two fragments despite a later success-shaped output. Claude parsing retains its existing behavior. |
| Isolation-snapshot documentation | Refer to the runner's `isolationSnapshot` file list, hashes/booleans only, with agents continuing to leave contents unread. | One authoritative rule in `docs/agents/orchestration.md`; the list includes Dedicated `AGENTS.md`, `credential-owners.json` and `wayfinder-token`. Workers/reviewers still use synthetic roots. Existing snapshot tests use synthetic files. |

## Red / green record

The initial focused run produced **7 failures and 1 passing control**: onboarding, Dedicated startup classification, HTTP 401, both Codex mirror orders, named connectors and remote UUID case. After fixes all eight passed. The append-only regression separately failed because a late body update rewrote prior bytes, then passed with JSONL. Self-review added an input-locator assertion for completion-first Codex records; it failed before preserving the original function-call fragment and passed afterward. The deterministic watchdog mutation evidence is listed above.

The first broader focused run passed 216 of 217 cases; the remaining assertion still expected Dedicated to be unverified. It now reflects the approved onboarding while continuing to assert unverified capabilities separately.

## PR #124 review corrections

Addresses the coordinator's six-item combined fix list from the independent Codex and Claude reviews of `7eb10a4`:

1. **Local tunnel ownership:** the former launch-option allowlist missed target-identified connectors. The fake-lease regression initially failed 10 of 12 cases, including `--hostname`, `--metrics`, `--logfile`, `--no-autoupdate=true`, unknown options and mixed-case names. The guard now assumes a target-identified `tunnel` process is a connector unless the entire option layout and read-only action are recognized. Mutating `route dns` is consequently no longer exempt. A follow-up malformed-quote case also failed before the parser rejected unrecognized syntax. All 14 acquisition cases now reject before `lease.start` or even the fake remote inspection; diagnostic, own-PID and unrelated-identity controls pass. The ChatGPT README states this conservative behavior.
2. **Privacy wording:** the runner-only exception points to `isolationSnapshot`'s file list instead of duplicating two paths. Only hashes/booleans may come from file contents; agents never open or print the files and worker tests retain synthetic roots.
3. **Retained independent probes:** 64 simultaneous refusals plus 16 initial refusals with reverse-order late body completion retain all 96 JSONL events, 80 unique refusal indices and 16 unique updates. The original prefix/inode and total/reason counts survive. Native mirror tests now cover both event orders with both `completed` and `failed`; later success-shaped output cannot replace the failure or its result locator.
4. **Unmet preconditions:** catalog-export failure preserves every earlier non-complete Dedicated result. The new test stops at the reply gate before any client turn, injects catalog failure and checks the saved Attempt, unknown dependent items and incomplete cell with zero passes/failures. Temporarily restoring the old unconditional Dedicated override fails with `driver-failed`; restoring the current guard passes. No final change to `runner/run.ts` or verdict rules.
5. **Input deduplication:** completion-first calls initially failed the exact two-fragment assertion in both completion states. Replacing their provisional input fragment with the later function-call input/reference makes all four order/status cases pass, keeping the completion result untouched.
6. **Operator limit:** the interactive README now states the busy-parent-PID-poll window and links directly to the implementation record's Limits section.

The two retained probes already passed the reviewed implementation; they add regression coverage without changing persistence or result-classification behavior. The review's optional code-smell suggestions are outside this correction.

## Standards self-review

No remaining finding. Scope follows `AGENTS.md`, the worker boundaries and §14.3: no shipped file, package version, rule source or Scenario verdict changes. The HTTP distinction is local to the scanner; native merging uses explicit IDs and completion provenance. Refusal persistence appends bounded records and updates bounded counters, with no accumulated-history rewrite or scan. Tests use synthetic data, fake clients/cloudflared and owned disposable services. No real models, private sessions, credentials, real tunnel or everyday database were used. No sub-agents were launched.

The review corrections were also checked against `7eb10a4`: nine changed files remain inside the authorized tests/documentation scope. No optional smell refactoring or new product dependency was added. Diagnostic exemptions fail closed on unknown options; input deduplication is keyed by the same native Call object and preserves the separate completion-result fragment.

## Spec self-review

All eight criteria have a change and evidence above. Refusal admission rules, HTTP status precedence, privacy fields, tunnel ownership checks and shared Scenario verdicts are preserved. The privacy clarification belongs to the project's on-demand orchestration instructions; it grants no new agent-readable source and changes no global setting. No product behavior or ChatGPT acceptance run is triggered by these testing-tool/documentation changes.

All six review-correction items have corresponding evidence above. The explicit read-only exemption requirement explains the removed `route dns` exemption; target identity matching remains bounded to complete arguments/values, with case folding only for local names/UUIDs and remote UUIDs. Preserved non-complete results are tested through the existing verdict interfaces without changing their rules. No remaining Spec finding.

## Compatibility and remaining work

New Attempts use `raw/relay-refusals.jsonl` instead of the old JSON array. Each line carries `index`, `kind` and `refusal`; a late body observation appends to the same index without incrementing totals. Reconstruct the last complete line per index, ignoring an interrupted final fragment. Existing historical JSON files remain unchanged. Summary paths and current documentation point to JSONL.

## Initial validation (`7eb10a4`)

Node **26.3.0**: `npm ci`, `npm run build`, `npm run typecheck` and `git diff --check` pass. Two consecutive full `npm test` runs on the final test-tool source each pass **48 files / 2,200 tests** (192.91 s and 193.36 s). An earlier full run before the input-locator self-review correction also passed 48 files / 2,200 tests (193.20 s); it is not counted as one of the two final-source runs. The remote `main` remained at the base commit above during validation.

Independent review and merge belong to the coordinator; no merge is performed by this worker.

## Review-correction validation

Node **26.3.0**: `npm run build`, `npm run typecheck` and `git diff --check` pass. Two consecutive full `npm test` runs on the corrected source each pass **48 files / 2,217 tests** (192.38 s and 191.76 s). No source changes were made between them. Both Standards and Spec self-review have no remaining findings; version `2.1.0`, shipped files and verdict/Scenario definitions have no diff. Verification used only synthetic records, fake clients/cloudflared and owned disposable services. The PR is left unmerged for the coordinator.
