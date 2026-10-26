# Codex upgrade checks through the isolated runner

Implementation of [B02c, Issue #67](https://github.com/kun-g/wayfinder_map_service/issues/67), against behaviour-testing R2/R3/R4 and §3. Real-model acceptance is pending an approved Batch. These checks remain outside the 26 candidate Scenarios.

## Lifecycle and isolation

`U-codex-process` creates `Upgrade.Probe`, reads it and adds one research Ticket in a single native process. The Controller holds that read response, replaces its own service with a canary build on the same fresh database and allocated port, then delivers the unchanged response. The client's next request carries an ended MCP session; transport reinitialization and recovery belong to Codex. There is no timed sleep, injected version, rewritten tool argument or Controller retry of an agent write.

`U-codex-resume` creates the same probe in turn 0, exits, replaces the owned service and uses `codex exec resume` for turn 1 in another process with the same native conversation ID. The new process receives fresh initialization metadata. If it nevertheless receives a version refusal, the same Resource/reread recovery checks apply.

Both paths use #94's shared sandbox, private HOME, protected launch configuration and session relay. Upgrade Batches refuse `--no-sandbox`. The sandbox receives only the relay port; neither the service nor the canary build becomes readable/reachable to the client. The service handle accepts no external restart port, PID, database or build path. It builds the canary inside its own temporary directory and replaces only its captured child. Ports 18765 and 18766 remain excluded. Cancellation drains in-flight Controller actions before exporting history and stopping the replacement process.

The runner reuses `writeCanaryCheckout` from `tests/helpers/canary-release.mjs` and the create/restart/Ticket journey of `upgrade-live.mjs`. It does not invoke the older launcher's `restart`, fixed port or fixed sleep. The canary has two observable changes: Ticket titles start with `v2: ` and the final reply starts with `LANTERN`; neither is put in the user prompt.

## Evidence and verdicts

The private Attempt retains:

- `upgrade.contracts`: before/after instructions, tool descriptions and workflow Markdown; these are Controller observations, separate from client visibility.
- Raw protocol and per-session relay logs: initialization, full tool schemas, HTTP 404, refusal, Resource reply and final write. `given` states `instructions` compatibility mode, full wire tool definitions and which descriptions/instructions the native model context actually contains.
- A successful native Resource read plus its matching wire reply and native tool output. It becomes a `resource` rules source. Resource text is never relabelled as refreshed initialization instructions or tools. Missing native context stays unknown.
- `upgrade.writes`: before/after snapshots of **all** persistent SQLite tables around each write, with wire request and result. Upgrade requests are serialized through the relay and responses are buffered until observation finishes. Refusals need matching native receipts and unchanged table contents.
- Full Map history and native commit receipts: exactly one create and one Ticket write under the agent credential. Missing receipts, extra Revisions or duplicate writes cannot pass. Controller actions and process PIDs remain separate events.

The Codex check definitions rise from v2 to v3; older Attempts cannot be silently re-judged under the stronger assertions. A version-only retry fails the canary content checks, including when a later timeout makes the run incomplete. `version_mismatch` remains a distinct result class even when the client marks it as failed; it never triggers W5's service-outage classification. Whether the model verbally treats the refusal as an outage remains the existing qualitative review item, so script evidence alone does not claim full acceptance.

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

Verified on 2026-10-26 with Node 26.3.0: `npm ci`, `npm run build`, `npm test` (35 files, 1837 tests passed), `npm run typecheck`, and `git diff --check`. No real-model run was performed.

Standards: no new package dependency, product code or sandbox permission; service ownership and cleanup remain explicit; raw evidence is redacted and kept outside the repository. Spec: R2 lifecycle and isolation, R3 actual client exposure and independent persistence evidence, R4 no false green or W5 conflation, separate upgrade accounting. Only tests and documentation change, so the Release Version stays 2.1.0 under mcp-sqlite §14.3; this changes no shipped mandatory rule or client tool contract and requires no pre-merge ChatGPT run. The outstanding gate is Kun's approval for real Codex quota, followed by the approved verdict reviews.
