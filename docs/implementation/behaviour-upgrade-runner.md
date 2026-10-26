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

The Codex check definitions are v6 after the third independent review; v2/v3/v4/v5 Attempts cannot be silently re-judged under the changed assertions. The `upgrade-evidence` expectation reads every phase's `instructions`, `toolDescriptions` and full `toolDefinitions`, verifies their agreement and instructions compatibility mode, and refuses to hold if `missing` contains any entry. It is evidence coverage, separate from the `upgrade-lifecycle` required event: missing unrelated coverage blocks a pass without suppressing a violation already proved after the restart. Required tool names come from the build contract, rather than a fixed count. A Resource read cannot replace missing tool-definition evidence.

Every version refusal needs its own Resource read and subsequent Map reread before the next retry; that retry must attest the version it learned. An eventual successful commit cannot excuse an earlier invalid retry. A real Conflict still forbids a same-turn write. After the lifecycle is proved, positively observed refusal-side mutations, excess commits, invalid retries and noncompliant replies fail before run completeness, so a later timeout cannot downgrade them to `incomplete`. If a declared trace gap could hide the refusal or read, those absence-dependent checks stay unknown. The final reply is still required, but it does not hide earlier noncompliant replies.

Every native Codex `agent_message` is a human-facing reply here, including progress notes between tool calls. After exposure to the new rule, even a note such as “Retrying with the new version” must start with `LANTERN`. This follows the canary rule's wording but is stricter than the final-reply-only judgement of the 2026-10-25 `upgrade-live.mjs` runs; the approved Batch must not be compared directly with those historical reply results.

The shared verdict engine first proves required events/capabilities and withholds dependent items when they are unmet or unknown. Proven non-occurrence or `precondition-not-met` yields `incomplete`; unknown prerequisites in an otherwise complete run yield `insufficient-evidence`. After that gate, a must-not proved from present evidence (including valid R4 review evidence), or a script-proven observed expectation violation, fails despite later timeout or gaps. A negative model/human expectation is not itself proof of an observed contradiction: an unfinished recommendation remains `incomplete`. Complete runs may fail for a proved absence, but declared missing events never prove absence. The full decision order is in [the runner README](../../tests/behaviour/README.md#verdicts-and-the-report) and the `judgeAttempt` comment.

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

The second round incorrectly allowed violations through unknown prerequisites and changed the offline Claude interactive fixture to `fail` despite unconfirmed capability. The third round retracts that ordering and restores the fixture's `insufficient-evidence` result; dependent items are not judged. No historical real report was regenerated or relabelled.

### Third-review verdict-order regressions

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
| Reviewed expected action absent in an interrupted run | Every one of the 26 candidate Scenarios / 26 fixed rows | Met or not yet proved | `incomplete` |
| Two valid agreeing model readings mark S12's recommendation absent | Fixed R4 review / 1 | Met | `incomplete`; two later passes can complete the cell as `pass` |
| Catalog first/later page or Conflict reread absent with a trace gap; file read may be in a missing command; final Map history or creation count missing | Shared helper audit / 10 fixed rows | Checked directly, then through verdict | `unknown` check, `insufficient-evidence` verdict |

The shared-helper audit found nine failing cases before its fix (the broad `events` file-read case already stayed unknown). Missing catalog pages affect S0b; Conflict rereads affect S6; missing command reads affect S15; final-history checks affect S9. Creation-count checks preserve positively observed excess Maps but cannot conclude zero/exactly one from incomplete history. Existing known-write violations, equivalent expectation alternatives, capability exclusions, compound checks, common-check violations and report aggregation retain their coverage.

Existing fixed-evidence changes are explicit:

- S9's early Settlement/common-check violations and W2's double Settlement now include labelled fixed annotations proving their model-judged prerequisites; their proved violations still fail.
- The generic unknown-prerequisite fixture now blocks dependent expectations; after proving the prerequisite, a wrong-write expectation still fails despite timeout.
- Minimal upgrade helper fixtures do not contain restart/process evidence, so the full adapter now withholds dependent verdicts. Direct old-version and duplicate committed-write violations remain visible; guessed-version, missing first refusal and invalid-recovery inferences become unknown when the relevant trace is declared missing.
- The adapter-only refusal fixture now marks `mismatch-as-outage` unknown (not judged), instead of pending review, until its lifecycle is proved. Review scheduling itself is unchanged.
- All offline interactive captures remain `insufficient-evidence`; Claude's unconfirmed capability is no longer bypassed. No fixture claims real-client capability acceptance.

For R5 comparisons, Codex upgrade definitions advance to v6. Other Scenario definitions and Claude/ChatGPT upgrade definitions remain unchanged, but these shared verdict/helper changes can affect their historical reports. Before B03 uses any affected real Batch in a comparison, it must record the original and new engine commits, compute an explicit before/after verdict comparison on the same evidence and explain every changed cell. That is pending coordinator work when a comparison is needed; this worker neither opened private historical records nor silently regenerated their reports.

Standards: no new package dependency, product code or sandbox permission; service ownership and cleanup remain explicit; raw evidence is redacted and kept outside the repository. Spec: R2 lifecycle and isolation, R3 actual client exposure and independent persistence evidence, R4 no false green or W5 conflation, separate upgrade accounting. Only tests and documentation change, so the Release Version stays 2.1.0 under mcp-sqlite §14.3; this changes no shipped mandatory rule or client tool contract and requires no pre-merge ChatGPT run. The outstanding gate is Kun's approval for real Codex quota, followed by the approved verdict reviews.
