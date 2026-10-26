# Codex upgrade checks through the isolated runner

Implementation of [B02c, Issue #67](https://github.com/kun-g/wayfinder_map_service/issues/67), against behaviour-testing R2/R3/R4 and §3. Real-model acceptance is pending an approved Batch. These checks remain outside the 26 candidate Scenarios.

## Lifecycle and isolation

`U-codex-process` creates `Upgrade.Probe`, reads it and adds one research Ticket in a single native process. The Controller holds that read response, replaces its own service with a canary build on the same fresh database and allocated port, then delivers the unchanged response. The client's next request carries an ended MCP session; transport reinitialization and recovery belong to Codex. There is no timed sleep, injected version, rewritten tool argument or Controller retry of an agent write.

`U-codex-resume` creates the same probe in turn 0, exits, replaces the owned service and uses `codex exec resume` for turn 1 in another process with the same native conversation ID. The new process receives fresh initialization metadata. If it nevertheless receives a version refusal, the same Resource/reread recovery checks apply.

Both paths use #94's shared sandbox, private HOME, protected launch configuration and session relay. Upgrade Batches refuse `--no-sandbox`. The sandbox receives only the relay port; neither the service nor the canary build becomes readable/reachable to the client. The service handle accepts no external restart port, PID, database or build path. It builds the canary inside its own temporary directory and replaces only its captured child. Ports 18765 and 18766 remain excluded. Cancellation drains in-flight Controller actions before exporting history and stopping the replacement process.

The runner reuses `writeCanaryCheckout` from `tests/helpers/canary-release.mjs` and the create/restart/Ticket journey of `upgrade-live.mjs`. It does not invoke the older launcher's `restart`, fixed port or fixed sleep. The canary has two observable changes: Ticket titles start with `v2: ` and every human-facing reply after the new rule becomes visible starts with `LANTERN`. The prompt contains neither rule nor a hint to look for a title rule; the explicit Map read remains because it triggers the restart.

After replacement, the Controller records the actual initialization instructions, version and tool descriptions, and requires them to match the expected canary contract before releasing the client. A build that did not apply is `precondition-not-met`. Adding the Ticket before the restart is also `precondition-not-met` in both lifecycles, rather than a driver fault.

`resources: available` for these Codex upgrade probes is based on the same-process and resume runs recorded in [client-upgrade.md](client-upgrade.md), not on the fake driver. The broader `clients.ts` onboarding matrix keeps `resource-read: unverified`: that matrix covers the current isolated driver/Combination acceptance, still awaiting the approved Batch. This assumption makes asking for a refresh without attempting the available Resource a failed recovery; it does not promote the whole client profile.

## Evidence and verdicts

The private Attempt retains:

- `upgrade.contracts`: expected before/after instructions, tool descriptions and workflow Markdown from the builds. The Controller corroborates the restarted service's version, instructions and tool descriptions through initialization; workflow Markdown remains the expected build content. Actual client visibility is recorded separately below.
- Raw protocol and per-session relay logs: initialization, full tool schemas, HTTP 404, refusal, Resource reply and final write. `given` states `instructions` compatibility mode, full wire tool definitions and which descriptions/instructions the native model context actually contains.
- A successful native Resource read plus its matching wire reply and native tool output. It becomes a `resource` rules source. Resource text is never relabelled as refreshed initialization instructions or tools. Missing native context stays unknown.
- `upgrade.writes`: before/after snapshots of **all** persistent SQLite tables around each write, with wire request and result. Upgrade requests are serialized through the relay and responses are buffered until observation finishes. Refusals need matching native receipts and unchanged table contents.
- Full Map history and native commit receipts: exactly one create and one Ticket write under the agent credential. Missing receipts, extra Revisions or duplicate writes cannot pass. Controller actions and process PIDs remain separate events.

The Codex check definitions are v7 after the fourth independent review; v2–v6 Attempts cannot be silently re-judged under the changed assertions. The `upgrade-evidence` expectation reads every phase's `instructions`, `toolDescriptions` and full `toolDefinitions`, verifies their agreement and instructions compatibility mode, and refuses to hold if `missing` contains any entry. It is evidence coverage, separate from the `upgrade-lifecycle` required event: missing unrelated coverage blocks a pass without suppressing a proved must-not. Required tool names come from the build contract, rather than a fixed count. A Resource read cannot replace missing tool-definition evidence.

Every version refusal needs its own Resource read and subsequent Map reread before the next retry; that retry must attest the version it learned. An eventual successful commit cannot excuse an earlier invalid retry. A real Conflict still forbids a same-turn write. Positively observed refusal-side mutations, excess commits, invalid retries and noncompliant replies fail independently of run completeness or lifecycle evidence gaps. Each must-not still enforces its own applicability: a canary reply needs prior client exposure, for example. If a declared trace gap could hide the refusal or read, absence-dependent checks stay unknown. The final reply is still required, but it does not hide earlier noncompliant replies.

Every native Codex `agent_message` is a human-facing reply here, including progress notes between tool calls. After exposure to the new rule, even a note such as “Retrying with the new version” must start with `LANTERN`. This follows the canary rule's wording but is stricter than the final-reply-only judgement of the 2026-10-25 `upgrade-live.mjs` runs; the approved Batch must not be compared directly with those historical reply results.

The shared verdict engine preserves main's rule: a must-not proved by present evidence, including a valid R4 model/human reading, fails even when a required event is absent or capability unconfirmed. Required events gate positive expectations, quality items and absence-only must-nots. For those dependent items, proven non-occurrence or `precondition-not-met` yields `incomplete`; unknown prerequisites in an otherwise complete run yield `insufficient-evidence`. With prerequisites met, a script-proven observed expectation violation survives later timeout/gaps. A negative model/human expectation alone is not proof of a present contradiction: an unfinished recommendation remains `incomplete`. Missing evidence never establishes a violation. The fixed order is in [the runner README](../../tests/behaviour/README.md#verdicts-and-the-report), the `judgeAttempt` comment and the fourth-round table below.

Checks distinguish `observed: true` script contradictions from `absenceOnly` results. Exact history requires an actual restart and a native committed result placing the stored Ticket after it before applying the canary rule; a Ticket before the upgrade is not a canary violation. Once placed, the independently captured wrong/extra Ticket proves failure even if a later native receipt is missing. Similarly, a known Conflict and committed replay prove failure despite a later unknown native result. A cell containing either failure and successful reruns is `flaky`, never `pass`.

`version_mismatch` remains a distinct result class even when the client marks it as failed; it never triggers W5's service-outage classification. Whether the model verbally treats the refusal as an outage remains the existing qualitative review item, so script evidence alone does not claim full acceptance.

## Proposed Batch — not approved or run

| Combination / Entry | Checks | Repetitions | Attempt ceiling | Native process ceiling |
| --- | --- | --- | --- | --- |
| Codex · gpt-6-astra · xhigh / MCP-only | `U-codex-process`, `U-codex-resume` | 2 each | 4 | 6 |

No candidate Scenarios, automatic reruns, model reviews or arbitration are included. Each native turn is capped at 10 minutes: at most 60 native-process minutes. Tokens and money cannot be known before running; available usage is recorded per Attempt. Follow-up runs and the two independent Sonnet 5.5 reviews per Attempt (and any Opus 5.5 arbitration/probes) need their own explicit approved count and ceiling before spending quota. Until those reviews complete, qualitative items remain pending.

After Kun approves this Batch, the coordinator runs:

```sh
export PATH="$(dirname "$(npm exec --yes --package=node@26.3.0 -- node -p process.execPath)"):$PATH"
npm ci
npm run build
node tests/behaviour/runner/run.ts --batch B02c-20261026 \
  --upgrade-checks U-codex-process,U-codex-resume --count 2 --ceiling 4 \
  --model gpt-6-astra --effort xhigh --timeout-min 10
```

Choose a fresh Batch ID if the directory already exists. The command records `kind: upgrade-checks`, checks, combination, repetitions, Attempt/native-process ceilings, timeout and zero automatic reviews in `batch.json`. Mixing `--scenarios` with `--upgrade-checks`, selecting another harness's upgrade check, or duplicating IDs is refused before reading the CLI login or launching anything.

## Verification and self-review

`npm test` uses `runner/fake-upgrade.mjs`, which makes real MCP calls in the shared sandbox with synthetic client login state and no model. It covers both lifecycles, unchanged tables on refusal, receipt/history attribution, version-only failure, missing and failed Resource evidence, absent triggers, cancellation during replacement, cleanup and Batch ceilings. Build, full test suite and strict typecheck are required before handoff.

The third-review branch first merged `main` at `62304ca` (merge `43f9f8e`). The merged baseline passed build, 39 test files / 1905 tests, and typecheck. Dedicated Entry support from main remains intact; upgrade checks are still MCP-only, and the native process-start callback is forwarded through the merged shared turn launcher. Dependencies were installed with `npm ci`; all checks use Node 26.3.0. No real-model run was performed.

After the third-review fixes on 2026-10-26: `npm run build`, `npm test` (**39 files / 1964 tests**, including 51 upgrade runner tests; 82.70 seconds), `npm run typecheck`, and `git diff --check` passed. The 59 added cases comprise the 22-row runner table, all 26 candidates, one R4 model-review fixture and ten shared-helper gap cases.

### Independent-review regression evidence

The follow-up tests first ran against the implementation before each fix. The unrelated `mismatch-as-outage` item uses a fixed, in-memory verdict-engine annotation only; it is not a real model review or human acceptance record. Every driver uses synthetic login state and the shared sandbox with an owned service.

| Review finding | Reproduced before the fix | Required result after the fix |
| --- | --- | --- |
| Codex 1: actual Conflict then same-turn replay, both lifecycles | `pass` | `fail` |
| Codex 2: refusal → read → old-version refusal → commit without another read | `pass`; a later timeout yielded `incomplete` | `fail`, including after timeout |
| Codex 3: actual extra Ticket write followed by a native timeout | `incomplete`, with three Revisions | `fail` |
| Codex 3: changed refusal snapshots in fake-driver-derived evidence, then timeout | `incomplete` | `fail` |
| Codex 4: noncompliant reply followed by a compliant final reply, both lifecycles | `pass` | `fail`, including after timeout |
| Claude 1: omitted wire/native tool definitions; omitted native definitions alone; explicit `missing` marker | `pass` in all three cases | `insufficient-evidence` |
| Claude suggestions: early Ticket in-process; owned canary build with incorrect initialization | `driver-failed`; `complete` | `precondition-not-met` |

The wire-refusal/no-native-receipt regression also checks resume mode: unchanged snapshots stay unknown, changed snapshots stay violated. Lifecycle selection is explicit data on `UpgradeCheck`; canary words/prefixes and reserved ports use shared constants. The relay option is named `serializeAndBuffer`. Claude and ChatGPT definitions remain v2: their existing rule sources and recovery paths are unchanged; Codex's new strict checks are selected by its lifecycle definition.

### Second-review regression evidence (historical)

Each row was run red before its corresponding fix and green afterward. The first three use real isolated services and native fake-driver timeouts; subsequent audit rows use labelled fixed evidence. No model or real acceptance review was used.

| Finding | Before | After |
| --- | --- | --- |
| Codex: Conflict → committed replay → unknown native result → timeout, both lifecycles | `incomplete`, Conflict check `unknown` | `fail`, also with an explicit missing-event marker |
| Claude: one commit stores two Tickets or `Probe.Uno`, then timeout, both lifecycles | `incomplete` despite violated exact history | `fail`; successful reruns yield `flaky` |
| Combined: Conflict replay, two stored Tickets, later unknown receipt and timeout, both lifecycles | exact history `unknown` | both violations remain visible, including with missing receipt/event markers |
| Upgrade helper audit: old-version commit, duplicate commit, guessed version and stale retry plus later gaps | each apparent violation could become `unknown` | Initially all preserved; the third review below corrects absence-based inferences and unmet prerequisites |
| Common-check audit: empty Settlement evidence, identical input-error retry, or two placed Settlements plus an unplaced one | proved violations could become `unknown` | violations preserved |
| Claude suggestion: future tool added consistently to contract/native/wire evidence | `insufficient-evidence` because count was fixed at four | `pass`; omitting its definition still blocks acceptance |

The second round incorrectly allowed expectation violations through unknown prerequisites and changed the offline Claude interactive fixture to `fail` despite unconfirmed capability. The third round restored the fixture's `insufficient-evidence` result, but gated must-nots too broadly. The fourth round below corrects that regression while preserving the expectation gate. No historical real report was regenerated or relabelled.

### Third-review verdict-order regressions (historical)

The three must-fix findings from [Claude's second re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6418524540) were reproduced before changing judgement code and passed afterward. Codex's interrupted second re-review supplied no result. `runner/upgrade.test.ts` has one 22-row precedence table: native fake runs on owned isolated services, labelled damaged copies for missing evidence, and the existing offline interactive import. The first S12/W5/W2/early-Ticket/missing-event rows failed with `fail` instead of the outcomes below; the interactive row separately reproduced `fail` instead of `insufficient-evidence`. Both contrary-restart-boundary rows first failed their direct exact-history assertions. No fixture annotation is a real acceptance reading.

| Evidence condition | Scope / rows | Required event | Expected outcome |
| --- | --- | --- | --- |
| Negative human expectation after timeout or rate limit | S12 / 2 | No missing prerequisite | `incomplete` |
| Same negative expectation, completed run | S12 / 1 | Met | `fail` |
| No actual outage, even with negative reports-outage review | W5 / 1 | Unmet | `incomplete`; dependent items not judged |
| No proposal for the Controller continuation | W2 / 1 | Unmet | `incomplete`; dependent items not judged |
| Existing Claude interactive capture, capability unconfirmed | Offline fixture / 1 | Unknown | `insufficient-evidence`; dependent items not judged |
| Complete recovery and rule evidence | Both Codex lifecycles / 2 | Met | `pass` |
| Ticket added before any upgrade | Both lifecycles / 2 | Unmet | `precondition-not-met` completeness, `incomplete` verdict; exact history unknown |
| Stored Ticket precedes the recorded restart boundary | Both lifecycles / 2 | Unknown | `incomplete` on the interrupted run; exact history unknown |
| Conflict → committed replay → later missing native result → timeout | Both lifecycles / 2 | Met | `fail`; cell with successful reruns is `flaky` |
| One commit stores two Tickets, then timeout | Both lifecycles / 2 | Met | `fail`; cell with successful reruns is `flaky` |
| One commit stores the wrong Ticket, then timeout | Both lifecycles / 2 | Met | `fail`; cell with successful reruns is `flaky` |
| Resource read or refusal removed, explicitly missing `events` / `events.tool-call` | Process / 4 | Restart remains proved | `insufficient-evidence`; affected inference checks unknown |
| Reviewed expected action absent in an interrupted run | Every one of the 26 candidate Scenarios / 26 fixed rows | Met (W5/S6 traces completed in round four) | `incomplete` |
| Two valid agreeing model readings mark S12's recommendation absent | Fixed R4 review / 1 | Met | `incomplete`; two later passes can complete the cell as `pass` |
| Catalog first/later page or Conflict reread absent with a trace gap; file read may be in a missing command; final Map history or creation count missing | Shared helper audit / 10 fixed rows | Checked directly, then through verdict | `unknown` check, `insufficient-evidence` verdict |

The shared-helper audit found nine failing cases before its fix (the broad `events` file-read case already stayed unknown). Missing catalog pages affect S0b; Conflict rereads affect S6; missing command reads affect S15; final-history checks affect S9. Creation-count checks preserve positively observed excess Maps but cannot conclude zero/exactly one from incomplete history. Existing known-write violations, equivalent expectation alternatives, capability exclusions, compound checks, common-check violations and report aggregation retain their coverage.

Existing fixed-evidence changes are explicit:

- The third round's added S9/W2 prerequisite annotations were removed in round four: their positive must-not evidence must fail without those annotations, as on main.
- The generic unknown-prerequisite fixture now blocks dependent expectations; after proving the prerequisite, a wrong-write expectation still fails despite timeout.
- Minimal upgrade helper fixtures lack restart/process evidence, so positive expectations remain gated. Present old-version/duplicate commits and witnessed stale retries still fail independently. Inferences requiring an absent read or first refusal stay unknown when the relevant trace is missing.
- The adapter-only refusal fixture keeps `mismatch-as-outage` pending review independently of lifecycle proof, restored in round four. Review scheduling itself is unchanged.
- All offline interactive captures remain `insufficient-evidence`; Claude's unconfirmed capability is no longer bypassed. No fixture claims real-client capability acceptance.

For R5 comparisons, Codex upgrade definitions advance to v7. Other Scenario definitions and Claude/ChatGPT upgrade definitions remain unchanged, but shared verdict/helper changes can affect their historical reports. Before B03 uses any affected real Batch in a comparison, it must record the original and new engine commits, compute an explicit before/after verdict comparison on the same evidence and explain every changed cell. The model-free main comparison below covers repository fixtures, not private historical records.

### Fourth-review main baseline and fixed order

Main `18e15286d68c408047b8509c89218594368e9080` was merged in `1945a14` before these fixes. The [Codex review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6420792358) identified three proof/phase defects; the [Claude review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6420806790) identified the overbroad must-not gate. All four were reproduced before their fixes. The fixed policy is:

| Priority / applicability | Condition | Verdict |
| --- | --- | --- |
| Always | Missing event, record or native result | Cannot prove either success or violation; remaining present evidence may still prove a contradiction |
| Always | Phase-specific rule | Apply only within its own evidenced phase; no canary judgement before client exposure |
| 1 | Must-not proved by present script evidence or valid R4 model/human reading | `fail`, regardless of missing required event, unconfirmed capability or timeout |
| 2 | No such must-not; positive expectation prerequisite unmet / `precondition-not-met` | `incomplete` |
| 2 | No such must-not; prerequisite/capability unknown | `insufficient-evidence` if otherwise complete; `incomplete` if interrupted |
| 3 | Prerequisites hold; expected outcome contradicted by present script evidence | `fail` even if later evidence is lost or the run times out |
| 4 | No proved violation; interrupted positive requirement | `incomplete`; a negative review alone cannot convert absence into a witnessed contradiction |
| 5 | Complete exercised run | Judge expectations; unresolved evidence/reviews block pass |
| Cell | A failure plus successful reruns | `flaky`; later success never erases the failure |

The added fake native runs cover a stale retry followed by fully compliant recovery (then `events.resource-read` / `events.tool-call` gaps), a lost native Map reread result, and a pre-exposure reply followed by timeout. The stale retry stays `fail`/`flaky`; lost reread results stay `insufficient-evidence` when complete or `incomplete` after timeout; the pre-exposure reply stays `incomplete`, allowing successful reruns to finish the cell. Native unfinished calls are flushed at turn end, so their sequence cannot prove the read was attempted only after the commit. The earlier Conflict replay remains a failure even after removing process-exit or restart evidence in either lifecycle, and the wrong/extra Ticket timeout remains `fail`/`flaky`.

Fixed evidence restores main's failures for W5 bait use without a route failure (also with an unknown route trace), S0b creation before a proposal, W2 premature Settlements and S9 early Settlement with unknown/unmet prerequisite or timeout. A human must-not reading also survives those gates. S9/W2/common-check tests no longer add prerequisite confirmations. All 26 interrupted-expectation rows now establish their required events, including actual fixed Conflict and relay-cut/native-failure evidence for S6 and W5. Claude's additional S15 suggestion is fixed: a recorded read cannot prove it preceded the first write if file-change events might be missing. Both new S15 gap cases reproduced `holds` before the fix and now return unknown.

The manual command below compares every `judgeAttempt` outcome in the existing behaviour test corpus, including imported interactive fixed evidence, with pinned main. `engine` runs main's engine/common checks with exactly the same supplied Scenario/checks and evidence; `definition` uses main's own stock Scenario/upgrade checks; `helpers` uses main's factory-generated checks with the same captured parameters for custom fixed Scenarios. It preserves the older-version rejection test; only an explicitly labelled upgrade-definition comparison changes the synthetic subject version to match main's definition. No private Batch is read. Its [difference manifest](../../tests/behaviour/compare-main-allowed.json) lists exact test/scenario/mode/outcome/count changes and their reasons, without wildcard exceptions. New differences, changed counts, disappeared approved changes, missing Scenario coverage or failed tests make the command fail. Cell aggregation is separately covered by the timeout/replay/wrong-Ticket regressions.

```sh
export PATH="$(dirname "$(npm exec --yes --package=node@26.3.0 -- node -p process.execPath)"):$PATH"
npm run build
node tests/behaviour/compare-main.mjs --out /tmp/wayfinder-verdict-comparison.json
```

The [fourth-round comparison](https://github.com/kun-g/wayfinder_map_service/blob/37f9fee/docs/implementation/behaviour-upgrade-main-comparison.json) is from code commit `cf6d132` against main `18e1528`: **1048 Attempt outcomes, 970 unchanged, 78 changed outcomes in 66 exact manifest entries**. All 32 stock definitions were covered; existing interactive imports were compared through their supplied definitions. There were **zero unlisted changes, stale entries or count mismatches**. The comparison suite passed **23 files / 764 tests** in 92.08 seconds. These are repeated judgements of synthetic test inputs, not 1048 real Attempts. The intentional differences are completely enumerated in that JSON report and manifest; grouped here for review (the fifth-round extension follows):

| Changed evidence / rule | Manifest entries / outcomes | Main → branch | Why main's result cannot be retained |
| --- | --- | --- | --- |
| Successful process-mode Resource recovery controls | 10 / 10 | insufficient → pass | B02c / R3 / §3: v2 lacks the native Resource rules source; v7 verifies actual exposure, lifecycle, full tool definitions and exact history |
| Reply canary after exposure | 4 / 4 | incomplete, insufficient or pass → fail | B02c / R4 / §3 adds the reply rule and retains every observed violation |
| Conflict replay, including missing lifecycle/result evidence | 8 / 16 | incomplete, insufficient or pass → fail | B02c / R4 rules 1/5: present Conflict and committed replay prove the forbidden write |
| Repeated refusals / stale retry | 4 / 5 | incomplete or insufficient → fail | R4 rule 5: a witnessed request contradicts already-exposed rules |
| Wrong/extra Ticket in one commit, timeout | 16 / 16 | incomplete → fail | B02c exact-history expectation / R4 rules 3/5: present committed state already contradicts the requirement |
| Version-only canary write | 1 / 1 | incomplete → fail | §3 / R4: changing only the version does not follow the new rule |
| Refusal mutation / third commit | 2 / 2 | incomplete → fail | B02c / R3/R4 adds persistence boundaries and exact write ceiling |
| Lost native Map reread result | 1 / 2 | fail → insufficient | R3/R4 rule 2: missing result and end-of-turn placement cannot prove skipped recovery |
| No lifecycle evidence, only a refusal | 1 / 1 | fail → insufficient | B02c / R4 rule 3: new required lifecycle is unproved; no must-not is proved |
| Present old-version/duplicate commits or contradictory retry plus later gap | 3 / 3 | incomplete → fail | R4 rules 1/5: main returned the gap before inspecting the retained proof |
| Common malformed Settlement / identical retry plus later gap | 2 / 2 | incomplete → fail | R4 rules 1/5: present forbidden action survives missing unrelated evidence |
| Two placed Settlements plus a third unplaced one | 1 / 1 | incomplete → fail | R3/R4 rules 1/5: the first two already establish the excessive count |
| Custom expectation contradicted by a present write, prerequisite met | 2 / 4 | incomplete → fail | R4 rule 3: main incorrectly lets timeout erase the positive contradiction |
| Missing catalog page, Conflict reread, creation count, file-read command or final history | 9 / 9 | fail → insufficient | R3/R4 rule 2: missing evidence cannot prove absence |
| S15 first-write ordering with missing file changes | 2 / 2 | pass → insufficient | R3/R4: an earlier write may be missing, so the positive ordering is unproved |

The W5 bait, S0b early-create, S9/W2 early-Settlement, valid human/model must-not, interrupted reviewed expectations, pre-exposure reply and interactive capability fixtures retain main's outcomes; they are not exceptions in the manifest. S6/W5's interrupted-expectation cases now explicitly prove their script prerequisites. The fourth-round changes passed `npm run build`, full `npm test` (**39 files / 1984 tests**, including 54 upgrade runner tests; 92.89 seconds), `npm run typecheck` and `git diff --check` on Node 26.3.0 after `npm ci`. Only the comparison artifact and this verification text were added afterward; no product code, sandbox policy or real-model acceptance changed.

### Fifth-review S15 proof boundary

The [fourth Codex re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6421772350) confirmed all 78 listed outcome changes and found one uncovered converse of the S15 write-gap guard. Main `e4d54cc` was merged in `c96e7f7` before this fix. Its changes since the prior baseline concern the ChatGPT runner; the main verdict engine, common checks and Scenario definitions are unchanged. The comparison now pins this latest main.

`readBeforeWrite` now checks the present recorded write against the read/command trace before deciding whether missing writes defeat its proof. A missing earlier write can invalidate a claimed success, but cannot repair a recorded write that precedes every read in a complete read trace. If reads or commands themselves are missing, an earlier read remains possible and the result stays unknown. The requiredEvents API comment now describes the dependent expectation gate and explicitly excludes independently proved must-nots.

| S15 evidence, proposal prerequisite confirmed | Complete | Timeout |
| --- | --- | --- |
| Write before every read; only file-change records missing | `fail` | `fail` |
| Read before the recorded write; file-change records missing | `insufficient-evidence` | `incomplete` |
| Write before recorded read, but an earlier read/command may be missing | `insufficient-evidence` | `incomplete` |

The first row plus two passing reruns is `flaky`. An undecided complete Attempt still blocks a cell's pass; an interrupted Attempt without a proved violation can be rerun under the existing R4 cell rule.

The first row is tested through the actual S15 definition, with labelled fixed annotations only for the proposal prerequisite and unrelated free-text requirement. The complete, timeout and rerun regressions all failed before the fix; a command-based late read also reproduced the failure. Three controls cover missing `events`, `events.file-read` and `events.command`; the previous read-before-write/write-gap controls remain unchanged. The verdict test file passed all 105 tests after the fix, without any real model readings.

The similar-guard audit found no further change needed:

- `never`, `noFileChanged`, `usedBait`, Conflict replay, excess-creation/Settlement counts and upgrade committed-write checks inspect positive proof before returning an unrelated gap; existing regressions retain those failures.
- Catalog paging, Conflict rereads, first-refusal ordering and guessed versions depend on an absence within the same missing trace; an omitted page/read/refusal/source can change that conclusion, so unknown is correct.
- `atEnd` needs the final Map history, and command/reference-shape recovery needs the complete subsequent write trace; a missing later state or successful correction can change their conclusion.
- Upgrade retry attestation already preserves a request contradicting an exposed rules source before checking later trace gaps; its prior lifecycle-complete regression remains in the full suite.

The main-comparison manifest retains all 66 prior entries / 78 outcomes and adds only these S15 cases:

| New comparison | Entries / outcomes | Main → branch | Reason |
| --- | --- | --- | --- |
| Recorded write before all reads, timeout, with and without the write gap | 2 / 4 | `incomplete` → `fail` | R4: prerequisite and contradiction are proved before interruption; both engine and stock-definition comparisons |
| Same failure in the cell with two passing reruns | 2 / 2 | `incomplete` → `fail` | R4: retain the failed Attempt so cell aggregation remains `flaky`; both comparison modes |
| Possible omitted command read before the write, complete run | 1 / 1 | `fail` → `insufficient-evidence` | R3/R4: main's stock helper ignores the command trace gap; it cannot prove that the write preceded every read |

The complete write-before-read case (including a command read) is again `fail` on both main and this branch, so it needs no exception. The previous read-before-write/write-gap comparisons still block false success. These are repeated judgements of fixed inputs, not real Attempts or new scenario definitions.

The [fifth-round comparison](https://github.com/kun-g/wayfinder_map_service/blob/3c1a1b6/docs/implementation/behaviour-upgrade-main-comparison.json) judges code commit `593f8b0` against main `e4d54cc`: **1080 outcomes, 995 unchanged, 85 changed outcomes in 71 exact entries**, covering all 32 stock definitions and existing interactive fixed evidence. There are **zero unlisted changes, stale entries or count mismatches**; all 66 prior manifest entries and their 78 outcomes remain unchanged. The comparison suite passed **23 files / 799 tests**. Only that saved report and verification text were added after the compared code commit.

Fifth-round verification on Node 26.3.0 after `npm ci`: `npm run build`, `npm test` (**39 files / 2019 tests**, 92.75 seconds), `npm run typecheck` and `git diff --check` pass. The increase from 1984 is 28 tests merged from main and seven S15 regressions. No real models or private run records were used.

### Sixth-review missing native Resource results

The [fifth Codex re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6425196069) passed the previous fixes and all 85 comparison differences. The [fifth Claude re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6425275350) found a missing individual Resource result still being treated as a skipped read and guessed version. Latest main was fetched before changes; `e4d54cc` was already included, so the comparison pin is unchanged.

Unfinished native calls are flushed at turn end. Their sequence cannot prove whether a Resource read preceded the retry. Recovery, version attestation and guessed-version checks now distinguish a known contradiction from a potentially missing rules source in the same session and turn; both `result.known=false` and an explicit `.result` missing marker leave it unknown. The non-Codex committed-version branch follows the same rule. A Resource event's derived `ok` and `given` phase do not restore a missing native result; the audit found and fixed that same gap in canary reply applicability. A previously proved exposure followed by a stale retry remains a violation.

| Evidence | Complete | Timeout | Item proof |
| --- | --- | --- | --- |
| Process recovery, sole new rules source is an unresolved Resource call | `insufficient-evidence` | `incomplete` | `guessed-version`, `invalid-recovery`, rules read and new-version write are unknown |
| Resume recovery, unresolved Resource call after a forced refusal | `insufficient-evidence` | `incomplete` | Recovery is unknown; `guessed-version` still holds because fresh initialization independently states the current version |
| Missing native Resource result with its stale derived event/phase retained | `insufficient-evidence` | `incomplete` | Neither version/recovery nor canary reply applicability is inferred from the derived copy |
| Known new-rule exposure, then stale retry, then a later unresolved Resource call | `fail` | `fail` | Existing positive contradiction survives; two passing reruns yield `flaky` |
| Legacy shared checks, only an unresolved Resource may supply the new version | `insufficient-evidence` | `incomplete` | Includes the committed-version branch outside strict Codex retry attestation |
| Only an unrelated server, Resource URI, listing tool, session or later turn has an unresolved call | `fail` | `fail` | That call cannot supply the missing rules source for this retry |

The fake driver adds two variants: `fake-upgrade-lost-resource` loses the Resource completion while still performing the correct recovery; `fake-upgrade-stale-lost-resource` first exposes the rules, makes an old-version retry, then loses the later Resource completion. Resume probes deliberately send the old request once so they exercise a refusal despite fresh initialization. They use only the fake's owned session log and the existing sandbox. Complete/timeout, explicit-field-marker and stale-retry/rerun cases cover both lifecycles; the retained-derived-phase case uses a labelled damaged copy of a successful native fake run.

Claude's Conflict reread suggestion is fixed in this PR: an unresolved or declared-missing `map_read` result cannot prove a successful reread, while another independently completed `read` can. Two fixed controls verify unknown/`insufficient-evidence`, timeout/`incomplete`, and the completed-read alternative. The remaining read-dependent must-not audit found no further case: stored/committed old or duplicate writes, Conflict replay, forbidden file/bait operations, malformed Settlements and refusal mutations use present request/receipt/state evidence; missing rule exposure already leaves canary applicability unknown. The corrected Resource-derived source was the extra must-not path found by this audit.

All twelve new cases were run against pre-fix code: **6 failed / 6 passed**, then **12 passed** after the changes. The six failures are two native Resource lifecycle probes, one derived-phase probe, one legacy shared-check probe and two Conflict-read probes. The six controls are two witnessed stale-retry lifecycles and four unrelated-read scopes. Fixed qualitative annotations are fixtures, not real model or human acceptance; no historical private Attempt was opened or re-judged.

A thirteenth scope control caught an overbroad Resource-tool name match during self-review: `list_mcp_resources` with a missing result cannot expose the workflow rules. It failed before narrowing the helper to Resource read calls, then passed; its outcome agrees with main and adds no comparison exception.

A fourteenth control keeps Conflict reread uncertainty scoped to its own session/turn: an unresolved read in one turn cannot hide a definitively skipped reread in another completed turn. It first failed with the broad unknown guard, then passed after checking each Conflict's scope; completion is `fail`, timeout remains `incomplete` because this is an absence-only expectation. Both outcomes agree with main.

The comparison manifest retains the previous 71 entries / 85 outcomes and adds only the following 13 entries / 16 outcomes; all differences are against pinned main `e4d54cc`, not against the pre-fix PR:

| New comparison | Entries / outcomes | Main → branch | Reason |
| --- | --- | --- | --- |
| Process, unresolved Resource result / explicit missing-result field | 2 / 4 | `fail` → `insufficient-evidence` or `incomplete` | R3/R4: a missing rules source cannot prove a guessed version |
| Resume, unresolved Resource after a forced refusal | 1 / 2 | `pass` → `insufficient-evidence` | B02c/R4: v7 requires recovery after an actual refusal; main v2's resume definition does not |
| Legacy shared checks, unresolved workflow Resource | 2 / 2 | `fail` → `insufficient-evidence` or `incomplete` | R3/R4: same missing-source rule applies to the non-Codex committed-version path |
| Proven exposure then stale retry and later lost Resource result, both lifecycles | 4 / 4 | `insufficient-evidence` or `incomplete` → `fail` | R4: present contradiction survives the later gap and timeout |
| Intact process recovery controls for the stale/derived-phase tests | 2 / 2 | `insufficient-evidence` → `pass` | B02c/R3: complete native Resource exposure is recognized by v7 |
| Conflict reread, unknown / declared-missing result | 2 / 2 | `pass` → `insufficient-evidence` | R3/R4: a call without its read result cannot prove successful rereading |

The damaged Resource-derived phase/reply cases already agree with main's overall outcomes, so they need no comparison exception. The regression tests still expose their false must-nots in the pre-fix v7 code. Unrelated-read controls and all earlier fixed evidence retain their outcomes.

The [sixth-round comparison](https://github.com/kun-g/wayfinder_map_service/blob/092ba9b/docs/implementation/behaviour-upgrade-main-comparison.json) judges code commit `af32b7c` against main `e4d54cc`: **1154 outcomes, 1053 unchanged, 101 changed outcomes in 84 exact entries**, with **zero unlisted changes, stale entries or count mismatches**. All previous 71 entries / 85 outcomes retain their reasons and counts. All 32 stock definitions and existing interactive fixed evidence are covered; **23 files / 813 tests** passed in 98.48 seconds. Only this report and verification text were added after the compared code commit.

Sixth-round verification on Node 26.3.0 after `npm ci`: `npm run build`, full `npm test` (**39 files / 2033 tests**, including all fourteen new cases; 99.14 seconds), `npm run typecheck` and `git diff --check` pass. Only fake drivers and fixed evidence were used.


### Seventh-review native Resource shape and bounded guessing

The [sixth Claude re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6425963879) found two remaining Resource-evidence errors; the [sixth Codex re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6425852473) passed. Latest main was fetched and merged before changes; `e4d54cc` was already included, so the comparison pin is unchanged.

Codex's public [Resource helper implementation](https://github.com/openai/codex/blob/abf4bb91ec49fbf443ccec0069f9cab5dd1462d8/codex-rs/core/src/tools/handlers/mcp_resource.rs) wraps the Resource payload in text content and leaves structured content absent. Its [exec event definition](https://github.com/openai/codex/blob/abf4bb91ec49fbf443ccec0069f9cab5dd1462d8/codex-rs/exec/src/exec_events.rs) supplies the native completion envelope. The normalizer now recognizes completed, successful text-only Resource results, decodes their JSON payload and preserves non-JSON text without claiming that it contains the full rules. Native error flags, failed calls and empty/absent results remain unknown. The text fallback is restricted to Resource reads, so text cannot substitute for a Map write receipt.

The fake upgrade driver now defaults to this public text-only shape, including the same Resource payload in its owned synthetic function output. An explicit structured variant retains compatibility coverage. A unit test also reads the repository's [B08 synthetic McpToolCall sample](../../tests/behaviour/fixtures/scan/codex-mcp-0.164.jsonl), adapting only its event envelope and preserving its protocol result fields. No real session log was read. Both lifecycle probes force an actual refusal before recovering; they check native presence, full exposure, recovery, current-version attestation and the final verdict.

The guessed-version guard now limits the possible information from an unresolved read to the recorded current service version. With old rules at `2.0.2` and a current service at `9.9.9`, a write naming `7.7.7` remains a proved guess even if a later Resource completion is lost. The same missing read leaves a `9.9.9` write unknown because it could have supplied that version. Without service-version evidence, the read cannot prove a guess. Claude's URI consistency suggestion is also addressed: legacy checks use their existing Resource URI prefix match for both completed and unresolved reads; strict Codex checks keep their exact URI requirement.

| Evidence | Complete | Timeout / rerun |
| --- | --- | --- |
| Successful text-only Resource recovery, either lifecycle | `pass` | No interruption in the success fixture |
| Text-only new-rule exposure, then forbidden reply | `fail` | `fail`; two passing reruns produce `flaky` |
| Text-only new-rule exposure, then stale retry and later lost read/trace | `fail` | `fail`; two passing reruns produce `flaky` |
| Truly missing Resource result, correct recovery | `insufficient-evidence` | `incomplete` (previous round's controls retained) |
| Unstated `7.7.7` while the recorded current version is `9.9.9`, then unresolved Resource | `fail` | `fail` |
| Only current `9.9.9` could have come from the unresolved read | `guessed-version: unknown` | Missing evidence never proves success |
| Legacy workflow URI variant with a missing result | `insufficient-evidence` | `incomplete` |

Before the fix, the new lifecycle/guess/URI regression selection had **9 failures and 1 passing structured-result control**. The ten normalizer cases, run separately against the pre-fix normalizer, had **7 failures and 3 passing controls**. After the fix, the combined targeted selection passed **25 tests** (the twenty new cases plus five existing Resource-loss controls), followed by typecheck. The audit confirms that recovery, canary reply applicability and attestation share the normalized result-presence path; the new text-only negative probes exercise those consumers without changing the common verdict order. Present contradictions still survive later gaps, while missing or failed results cannot supply proof.


The main comparison retains all prior **84 entries / 101 changed outcomes** with identical counts and reasons. Only these seventeen new exact entries are added:

| New comparison | Entries / outcomes | Main → branch | Reason |
| --- | --- | --- | --- |
| Text-only recovery and positive controls in both lifecycles, plus the structured compatibility control | 7 / 7 | `insufficient-evidence` → `pass` | B02c/R3: native Resource content establishes the visible rules source absent from main v2's definition |
| Text-only exposure followed by a forbidden reply, complete and timeout | 4 / 4 | `insufficient-evidence` or `incomplete` → `fail` | R4 rules 4/5: the applicable rule and violation are present |
| Text-only exposure followed by stale retry, later lost result/trace, complete and timeout | 4 / 4 | `insufficient-evidence` or `incomplete` → `fail` | R4 rules 1/5: later gaps cannot erase the observed contradiction |
| Legacy unresolved workflow Resource URI variant, complete and timeout | 2 / 2 | `fail` → `insufficient-evidence` or `incomplete` | R3/R4 rule 2: missing native source cannot prove a guess; matching follows the legacy recovery contract |

The impossible `7.7.7` guess remains `fail` on both main and this branch, including timeout; no main exception is needed. It fixes a regression introduced within this PR. All existing fixed inputs keep their earlier main-comparison outcomes despite switching the fake's Resource responses to text-only content. No common verdict ordering or baseline expectation was relaxed.

The [seventh-round comparison](https://github.com/kun-g/wayfinder_map_service/blob/7a85b58/docs/implementation/behaviour-upgrade-main-comparison.json) judges code commit `4eead47` against main `e4d54cc`: **1192 outcomes, 1074 unchanged, 118 changed outcomes in 101 exact entries**, with **zero unlisted changes, stale entries or count mismatches**. All 32 stock definitions and existing interactive fixed evidence are covered; **23 files / 833 tests** passed in 108.14 seconds. The previous 84 entries / 101 outcomes retain their exact reasons and counts. Only this saved report and verification text were added after the compared code commit.

Seventh-round verification on Node 26.3.0 after `npm ci`: `npm run build`, full `npm test` (**39 files / 2053 tests**, including twenty new cases; 111.61 seconds), `npm run typecheck` and `git diff --check` pass. Only synthetic records and fake drivers were used; no product code, sandbox permissions or real-model acceptance changed.


### Eighth-review failed Resource calls are known failures

The [seventh Claude re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6426579690) found that failed Resource calls were still treated as potentially lost rules sources; the [seventh Codex re-review](https://github.com/kun-g/wayfinder_map_service/pull/107#issuecomment-6426525256) passed the preceding fixes. Latest main `f8b3900` was merged in `b050003` first. The shared proxy/cleanup integration preserves both native spawn evidence and exit cleanup, direct authenticated transport, excluded/protected ports, relay serialization, cancellation draining and upgrade Batch accounting. Service port ownership now stays held across its stop/start interval until final cleanup. Main's verdict engine, common checks and definitions have not changed since `e4d54cc`; the comparison pin advances to the merged main.

`unresolvedRules` now excludes calls marked `failed`. A failed native call still has no successful Resource payload, but it is not an unknown outcome: it supplied no rules and cannot excuse the subsequent retry. All consumers (capability recovery, retry attestation, committed-version proof and guessed-version checks) share this distinction. Unfinished calls and explicit missing-result markers without a known failure remain possible lost sources; no success is inferred from them.

Two native fake-driver regressions cover both lifecycles with an actual refusal, a synthetic Resource delivery failure, a Map reread and a retry. The service response is not exposed as a successful native Resource result or in the fake's function output. In process mode, recovery, invalid-recovery, guessed-version and new-version-write items are violated; in resume mode, fresh initialization independently states the version but cannot satisfy the required successful Resource recovery. Both are `fail` when complete and after timeout, and stay `flaky` with two passing reruns. Existing lost-call and explicit-marker controls remain `insufficient-evidence` / `incomplete`.

Claude's optional pre-restart suggestion is also fixed: the possible current-version source applies only to writes in the recorded after-restart phase. Two fixed-evidence regressions keep an unstated `9.9.9` write before that phase at `fail`, complete and after timeout, even when the same turn later has an unresolved read. The existing post-restart current-version unknown control and impossible `7.7.7` failure remain unchanged.

All four new regressions failed before the fix. The targeted run then passed **14 tests** (four new and ten existing controls), followed by typecheck. No common verdict-order or normalizer change was needed: successful text-only results remain present, failed calls remain failed, and only genuinely unknown results can create source uncertainty.


The first comparison run also caught four CLI refusal-format failures from the main integration: this PR's earlier preflight bypassed main's `refused:` prefix. That output path now keeps the prefix without changing any assertion or isolation rule. The refreshed Controller's close operation is registered with main's deferred cleanup, like the initial connection.

The updated comparison manifest retains all previous **101 entries / 118 changed outcomes** with identical counts and reasons. It adds only the following four exact entries against main `f8b3900`:

| New comparison | Entries / outcomes | Main → branch | Reason |
| --- | --- | --- | --- |
| Successful Resource recovery controls inside the two failed-read probes | 2 / 2 | `insufficient-evidence` → `pass` | B02c/R3: native Resource exposure supplies the rules source absent from main v2's checks |
| Resume after an actual refusal, failed Resource read, then retry: complete and timeout | 2 / 2 | `pass` or `incomplete` → `fail` | B02c/R4: v7 requires successful recovery after the refusal; a known failed read cannot supply it |

The process failed-read cases and both pre-restart guesses are `fail` on main too, so they need no exceptions. All earlier proof-preservation and genuine missing-result comparisons retain their counts. The comparison corpus includes the newly merged main tests and these four new regressions. These are fixed-input judgements, not real Attempts.

The [eighth-round comparison](https://github.com/kun-g/wayfinder_map_service/blob/43fc3f5/docs/implementation/behaviour-upgrade-main-comparison.json) judges code commit `ceee62c` against main `f8b3900`: **1222 outcomes, 1100 unchanged, 122 changed outcomes in 105 exact entries**, with **zero unlisted changes, stale entries or count mismatches**. All 32 stock definitions and existing interactive fixed evidence are covered; **29 files / 947 tests** passed in 200.63 seconds. All prior 101 entries / 118 outcomes retain their exact reasons and counts. Only this report and verification text were added after the compared code commit.

Eighth-round verification on Node 26.3.0 after `npm ci`: `npm run build`, full `npm test` (**45 files / 2167 tests**, 200.48 seconds), `npm run typecheck` and `git diff --check` pass. This includes the four new regressions, all prior proof-preservation fixtures and the newly merged proxy/privacy/cleanup tests; the four earlier CLI refusal-format failures are resolved with their original assertions intact.

Standards: no new package dependency, product code or sandbox permission; service ownership and cleanup remain explicit; raw evidence is redacted and kept outside the repository. Spec: R2 lifecycle and isolation, R3 actual client exposure and independent persistence evidence, R4 no false green or W5 conflation, separate upgrade accounting. Only tests and documentation change, so the Release Version stays 2.1.0 under mcp-sqlite §14.3; this changes no shipped mandatory rule or client tool contract and requires no pre-merge ChatGPT run. The outstanding gate is Kun's approval for real Codex quota, followed by the approved verdict reviews.


### Pre-merge test stabilization

Main `318e97d` (including #122's interactive proxy forwarding) was merged in `e48b89a` before this work. A full-suite reproduction failed the reported S6 missing-trigger case: **2190 passed / 1 failed, 47 files, 210.46 seconds**. Both native clients had exited normally with code 0; the recorded reason was `isolation failure: client output pipes remained open after exit`, not a turn timeout or a missing Controller trigger. A temporary 20-case concurrent reproduction then hit the same failure in 18 cases. The original assertion remains `precondition-not-met`, with safe process/failure details added to its assertion message.

The exit path arms a 250 ms pipe watchdog and performs synchronous owned-process scans. Under load, those scans can leave the watchdog overdue while normal EOF/close callbacks are queued. The old watchdog unconditionally reported a leak before those callbacks ran. `turn.test.ts` now reproduces that ordering using a real child with no descendants and controlled timer delivery, for short and 256 KiB output. Before the fix it produced **1 failed / 1 passed** despite a normal exit and complete output; after the fix both pass. The watchdog now crosses a full I/O poll phase before checking each pipe's `readableEnded` / `closed` state, and destroys only pipes still open. Its 250 ms deadline, immediate client-exit forwarding revocation, owned-process cleanup and failure for genuinely inherited open pipes remain. This changes the shared native-capture path, not S6's prerequisite classification or the verdict engine.

The same audit found upgrade fixtures that required their restart/read/write sequence to finish before a fixed three-second turn deadline. They now emit a fake-only synchronization marker after the intended evidence and remain alive until the parent expires the actual native-turn timer. The tests assert that the marker and timer were reached, then retain their existing timeout, failure and flaky assertions. No timer threshold serves as evidence of scenario progress, and the marker is not normalized into behavioural proof. Startup and cleanup watchdogs retain real clocks; a bounded native fallback still prevents a hung fixture. No new real-model execution path or sandbox permission was added.

After the fix the temporary concurrent S6 reproduction passed **20/20** and was removed. The focused native-drain, upgrade timeout/proof-preservation and inherited-pipe/proxy controls passed **39 tests**, followed by typecheck. The new two-case pipe regression remains in the ordinary fake-only suite. The verdict baseline advances to the merged main; its checks and definitions are unchanged, so no comparison exception is added for this stabilization.

Node 26.3.0 validation after the fix, without intervening code/test edits or rerun filtering:

| Full `npm test` run | Start (Asia/Singapore, 2026-10-27) | Files | Tests | Duration |
| --- | --- | --- | --- | --- |
| 1 | 05:42:58 | 48 passed | 2193 passed | 203.00 s |
| 2 | 05:46:21 | 48 passed | 2193 passed | 203.03 s |
| 3 | 05:49:45 | 48 passed | 2193 passed | 204.37 s |

`npm run build`, `npm run typecheck` and `git diff --check` also pass. These are complete ordinary suites, including original S6, both new pipe cases, all upgrade invariants and #122's interactive forwarding tests. Only fake clients and owned services were used; no real model, daily service or real database was accessed.

Standards: two-phase I/O scheduling is local to native capture; timer cancellation and cleanup stay explicit, with no new dependency or permissions. Spec: R2 still rejects actual containment failures and cleans owned resources; R3 retains complete native output; R4's prerequisite/must-not/expectation rules are unchanged. Real-model Batch acceptance remains behind Kun's quota gate.

The [final saved comparison](behaviour-upgrade-main-comparison.json) judges stabilization code `224a399` against main `318e97d`: **1222 outcomes, 1100 unchanged, 122 changed outcomes in the same 105 exact entries**, with **zero unlisted differences, stale entries or count mismatches**. All 32 stock definitions remain covered. The report is identical to the eighth-round report apart from the two commit IDs; no allowance or verdict expectation changed. Its complete comparison suite passed **32 files / 973 tests** in **201.67 seconds**, including #122 and the two new pipe regressions. Only this report and verification text were added after the compared/tested code commit.
