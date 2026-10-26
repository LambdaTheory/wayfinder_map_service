# B08 independent-review response

Responds to the [Claude review](https://github.com/kun-g/wayfinder_map_service/pull/100#issuecomment-6409261538) and [Codex review](https://github.com/kun-g/wayfinder_map_service/pull/100#issuecomment-6409329810) on PR #100. Only synthetic evidence and fake drivers were used. No real model, private session/configuration/metadata, database or scheduler was used.

## Required regressions

The first targeted run with the new regressions failed **four tests** and passed 15: unrelated dialogue appeared in output, confirmed leads produced another capture draft, proposals budgeted three instead of five calls, and Claude bookkeeping produced an extra session. The same tests pass after the changes below.

| Finding | Change and evidence |
| --- | --- |
| Unrelated dialogue copied into every inventory/lead | Inventories omit dialogue; pending leads contain evidence locators only. Accepted reviews export only their explicitly selected exact excerpts from incident evidence. Sentinels in an unrelated session are absent from every CLI output file; unselected earlier/later turns in a related session and rejected quotes are absent from the report, state, proposal and drafts. |
| Weekly repeats | State schema 2 records pending as well as reviewed leads with `new`/`changed`/`seen`. Unchanged screened/dismissed dispositions survive without re-supplying the old review file. Confirmations remain pinned across changed or missing evidence, never trigger another model proposal, and count as new failures only once, independently of earlier screening reminders. Seen leads do not produce another draft/proposal. |
| Proposal and B03b budgets disagree | B03b and B08 now share reviewer selection and the actual five-call plan: two availability probes, two readings, conditional arbitration. `scan/review.ts` binds exact B01 evidence before approval, passes the same ceiling to B03b and persists one reservation at each Driver call. Tests use the existing B03b executor with a fake driver: agreement spends four, disagreement spends five, interruption retains three spent/two remaining, and an unresolved durable reservation never replays probes. Under-budget or changed-evidence plans start no calls. |
| Claude session-less bookkeeping creates sessions | Ignore non-conversation records before creating a session. Fixed Claude fixtures include session-less `summary` and `file-history-snapshot` lines; both direct parser and full inventory tests retain one conversation. |
| Issue closure and scheduling | PR description uses `Refs #79`. The scan command and weekly/pre-release mechanism are documented; installing a weekly schedule remains Kun's decision after integration. |

## Additional review points

Standards: README now includes scan tests in `npm test` and states that real scans require coordinator/Kun approval. Public CLI errors are a closed set of useful fixed messages (including the exact Node version), while private exception details remain hidden. Tests locate checkout paths with `import.meta.url`. Typed ambiguity flags replace gap-string control flow; session keys, usage merging and harness narrowing share helpers; the output-path predicate is named and parenthesized.

Reviewer selection and the complete call plan have one pure source shared with B03b. The scanner uses the B07 `CallResult` type and the existing evidence result-class list. The tiny domain-separated request hash stays local to keep the source-only scan CLI independent of a runtime import of shipped service modules; a conformance test compares it with B07's `requestIdHash`. This is a deliberate alternative to importing the runtime helper, not an untested second protocol.

Spec: automatic signals stay pending until screening and produce no model proposal or capture draft. Injected Codex AGENTS/environment messages, Claude `isMeta` and command output cannot supply human quotations. Skill recognition requires an explicit invocation, including Claude slash/Skill-tool calls; maintenance reads and negated mentions do not count. The fresh-launch fixture removes the native ID and documents the resulting separate launch/native rows instead of guessing by timestamp. Correlation records distinguish native ID plus harness from credential fingerprint joins. Capture drafts carry the selected human quote references while leaving human words and other admission fields unset.

Refusal classes remain grouped into one screening lead per session, with every native/service call's exact result class retained in the inventory. This intentionally avoids multiple speculative reminders; B04 splits concrete incidents after screening. The grouping never treats different refusal classes as the same authorization verdict.

## Validation

Final verification after merging `origin/main` at `046043e` on 2026-10-26: Node **26.3.0** passed `npm run build`, `npm test` (**25 files / 1628 tests**), `npm run typecheck` and whitespace checks. This includes 26 scan tests and five tests of the real B03b handoff with fake drivers. The earlier run before that main update also passed (**24 files / 1511 tests**). The synthetic manual command still produces the summary recorded in the implementation document: 11 sessions, eight calls, 19 pending leads, zero failures, zero proposed invocations and zero models started.

The full suite uses the temporary private-files guard described in the [implementation record](behaviour-usage-scan.md#verification-and-self-review), removed after the run. One earlier full run used Node 26.10.0 in npm's script subprocess and failed the repository's runtime guards; it is not counted as a pass. A temporary local script-shell wrapper prepends the resolved Node 26.3.0 binary for npm scripts; no global configuration or version checks change.

Standards self-review checks minimal private output, safe diagnostics, shared B03b semantics, durable per-invocation accounting and no scan execution imports. Spec self-review checks all four mandatory regressions, conservative authorization/purpose handling, retained decisions, B04 drafts and no scheduler. Independent re-review and merge remain with the coordinator.
