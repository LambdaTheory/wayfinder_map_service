# Behaviour tooling cleanup — Issue #123

Implements [#123](https://github.com/kun-g/wayfinder_map_service/issues/123), based on main `4fc48d004d2734d2c04ef6d18cc78663d7133035`, on 2026-10-27. Changes stay in `tests/behaviour/` and documentation. Release Version `2.1.0`, shipped code, Scenario definitions and verdict rules stay unchanged.

## Acceptance evidence

| Item | Change | Verification |
| --- | --- | --- |
| Codex Dedicated onboarding | Add `dedicated` to onboarded Entries; cite approved `B02d-onboarding-20261026` and [#68 closeout](https://github.com/kun-g/wayfinder_map_service/issues/68#issuecomment-6418579634). Update current onboarding documentation. | `dedicated.test.ts` checks the profile and capability visibility; `library.test.ts` checks applicability while retaining unverified concurrent-session capability. |
| HTTP 401 in usage scans | Classify recorded HTTP 401 as scan-only `unauthenticated` and screen it as refusal, including observations without a tool name. | `scan.test.ts` uses synthetic service metadata; 503 and absent status retain `transport-failure`. No change to shared result classification. |
| Dedicated startup failure | Catalog export cannot overwrite an earlier `service-failed` outcome. | `dedicated.test.ts` injects startup rejection for both Entries, asserts retained outcome/record, missing Maps and no client turns. |
| ChatGPT command | Recognize ad hoc `--name` / `-n` connectors, ignore UUID case in remote identity, append refusal observations as JSONL. | `chatgpt.test.ts` covers named/equal/short flags, diagnostic exclusions, own PID, unrelated tunnel and remote identity controls. The log regression preserves the inode and byte prefix across a late body update and 12 later refusals; counts remain one per refusal. Existing privacy, abrupt-exit, SIGKILL, forwarding and verdict-equivalence checks remain. |
| Interactive host limit | State the busy-parent-PID-poll race in Limits, with the fake Claude re-review's 6/7 observation and its relationship to pre-exit sockets. | Documentation checked against [PR #122 review](https://github.com/kun-g/wayfinder_map_service/pull/122); no interactive host behavior changed. |
| Pipe-race regression | Hold real drained-pipe close notifications until the overdue timer has run, then deliver them. | `turn.test.ts` covers 0 and 256 KiB output. Temporarily restoring the old unconditional watchdog fails both cases in all six runs (12/12); restored current code passes both in three runs (6/6). `runner/codex.ts` has no final diff. |
| Codex mirrored calls | Merge one native ID in either event order; retain the function input/locator and completion result/locator, ignoring trailing mirrored output. | `read.test.ts` checks both orders, one call, original arguments, `service-failure`, completion result reference and absence of a second result fragment. Claude parsing retains its existing behavior. |
| Isolation-snapshot documentation | Name the two allowed programmatic reads, hashes/booleans only, with agents continuing to leave contents unread. | One authoritative rule in `docs/agents/orchestration.md`; workers/reviewers still use synthetic roots. Existing snapshot tests use synthetic files. |

## Red / green record

The initial focused run produced **7 failures and 1 passing control**: onboarding, Dedicated startup classification, HTTP 401, both Codex mirror orders, named connectors and remote UUID case. After fixes all eight passed. The append-only regression separately failed because a late body update rewrote prior bytes, then passed with JSONL. Self-review added an input-locator assertion for completion-first Codex records; it failed before preserving the original function-call fragment and passed afterward. The deterministic watchdog mutation evidence is listed above.

The first broader focused run passed 216 of 217 cases; the remaining assertion still expected Dedicated to be unverified. It now reflects the approved onboarding while continuing to assert unverified capabilities separately.

## Standards self-review

No remaining finding. Scope follows `AGENTS.md`, the worker boundaries and §14.3: no shipped file, package version, rule source or Scenario verdict changes. The HTTP distinction is local to the scanner; native merging uses explicit IDs and completion provenance. Refusal persistence appends bounded records and updates bounded counters, with no accumulated-history rewrite or scan. Tests use synthetic data, fake clients/cloudflared and owned disposable services. No real models, private sessions, credentials, real tunnel or everyday database were used. No sub-agents were launched.

## Spec self-review

All eight criteria have a change and evidence above. Refusal admission rules, HTTP status precedence, privacy fields, tunnel ownership checks and shared Scenario verdicts are preserved. The privacy clarification belongs to the project's on-demand orchestration instructions; it grants no new agent-readable source and changes no global setting. No product behavior or ChatGPT acceptance run is triggered by these testing-tool/documentation changes.

## Compatibility and remaining work

New Attempts use `raw/relay-refusals.jsonl` instead of the old JSON array. Each line carries `index`, `kind` and `refusal`; a late body observation appends to the same index without incrementing totals. Reconstruct the last complete line per index, ignoring an interrupted final fragment. Existing historical JSON files remain unchanged. Summary paths and current documentation point to JSONL.

## Final validation

Node **26.3.0**: `npm ci`, `npm run build`, `npm run typecheck` and `git diff --check` pass. Two consecutive full `npm test` runs on the final test-tool source each pass **48 files / 2,200 tests** (192.91 s and 193.36 s). An earlier full run before the input-locator self-review correction also passed 48 files / 2,200 tests (193.20 s); it is not counted as one of the two final-source runs. The remote `main` remained at the base commit above during validation.

Independent review and merge belong to the coordinator; no merge is performed by this worker.
