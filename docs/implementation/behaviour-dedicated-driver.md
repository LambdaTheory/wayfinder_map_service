# Codex Dedicated behaviour Driver

Issue: [#68](https://github.com/kun-g/wayfinder_map_service/issues/68). Implementation evidence on 2026-10-26; **not** an approved model Batch, Driver onboarding or product behaviour acceptance.

The manual runner now accepts `--entry dedicated`. It invokes the repository's real `wayfinder` launcher with its existing path/port overrides and a private `HOME`. The Controller owns the temporary service; the launcher configures Codex and registers its per-launch credential. A private shim captures that credential for redaction and enters the existing allowlist sandbox. No shipped code or workflow changed, so the Release Version stays unchanged under §14.3.

## Standards self-review

- Shared process capture and native normalization remain in `codex.ts` and `normalize.ts`; Dedicated preparation is confined to `dedicated.ts`.
- Only newly created services are stopped. Database/credentials are under a fresh cache directory, and the launcher sees a projected checkout without a service build, preventing an untracked replacement process on service failure.
- Launcher setup receives a copied login through its private `HOME`; it cannot synchronize a refresh back into the daily login. The tested client cannot read personal context, service code, verdicts or the credentials directory, and cannot connect to 18765/18766.
- Raw launch credentials are retained only until redacted evidence is written, then removed with the owned service directory. Artifact copying removes literal credentials without corrupting other binary bytes or following symlinks.
- The branch does not modify the launcher lines changed by PR #92. Independent review belongs to the coordinator.

## Spec self-review

| Requirement | Evidence and limit |
| --- | --- |
| Real Dedicated Entry with isolated overrides | `dedicated.test.ts` invokes the actual launcher, records its argv and all overrides, verifies a cache database/free port, and asserts cleanup and unchanged personal-state hashes |
| Entry context | Installed launcher instructions, MCP Skill and its activation metadata, plus config are recorded in `raw/entry-context.json`; native-rollout exposure is distinguished from installation |
| Runs/resumes, native evidence and Map receipts | Fake Codex completes S0b's two turns in one native thread; both writes have matching receipts and launcher Client IDs |
| Fixture permissions and sandbox | Fixture reads/writes succeed, personal workspace reads fail; existing B02a sandbox tests retain the denied-port checks |
| Failure and refusal paths | Timeout cleanup, an existing Batch directory, sandbox opt-out and a stopped service are tested without a model |
| Separate reporting | Dedicated and MCP-only retain separate cells, baseline slots and Markdown tables; mismatched Batch/Attempt Entries are refused |
| Approved five-check onboarding | **Pending Kun's Batch approval and coordinator execution.** `clients.ts` still lists Dedicated as unverified |

Build, full test suite and strict type checking pass with Node 26.3.0. No model, ChatGPT app, tunnel or everyday service operation was run. The proposed four-Attempt Batch and exact commands are in [the runner README](../../tests/behaviour/README.md#proposed-onboarding-batch-not-authorized-or-run): Codex · gpt-6-astra · xhigh · Dedicated, S0b and F11 twice each, ceiling four, zero model reviews/arbitrations. This sample does not establish the full-library baseline.
