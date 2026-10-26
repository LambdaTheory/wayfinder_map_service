# Codex Dedicated behaviour Driver

Issue: [#68](https://github.com/kun-g/wayfinder_map_service/issues/68). Implementation evidence on 2026-10-26; **not** an approved model Batch, Driver onboarding or product behaviour acceptance.

The manual runner now accepts `--entry dedicated`. It invokes the repository's real `wayfinder` launcher with its existing path/port overrides and a private `HOME`. The Controller owns the temporary service; the launcher configures Codex and registers its per-launch credential. A private shim captures that credential for redaction and enters the shared allowlist sandbox; the shim, profile and projected checkout are stored outside client-writable scratch and verified before every launch. No shipped code or workflow changed, so the Release Version stays unchanged under §14.3.

## Isolation boundaries

- Shared process capture and native normalization remain in `codex.ts` and `normalize.ts`; Dedicated preparation is confined to `dedicated.ts`.
- Only newly created services are stopped. Database/credentials are under a fresh cache directory, and the launcher sees a projected checkout without a service build, preventing an untracked replacement process on service failure.
- Launcher setup receives a copied login through a runner-owned private `HOME`; file type, link target, parent identity and inode checks stop substitutions before synchronization. Refreshed native tokens are recollected each turn. The tested client cannot read personal context, service code, verdicts or the credentials directory, and cannot connect to 18765/18766.
- Raw launch credentials are retained only until redacted evidence is written, then removed with the owned service directory. The stopped database and effective control policy remain as private evidence even if catalog export fails. Artifact copying removes literal credentials without corrupting other binary bytes or following symlinks.
- Cross-turn regressions exercise attempts to replace the shim, plant a PATH interpreter or service build, rewrite the sandbox policy and redirect auth synchronization; sandbox denials and prelaunch integrity checks are asserted independently.

## Evidence and remaining acceptance

| Requirement | Evidence and limit |
| --- | --- |
| Real Dedicated Entry with isolated overrides | `dedicated.test.ts` invokes the actual launcher, records its argv and all overrides, verifies a cache database/free port, and asserts cleanup and unchanged personal-state hashes |
| Entry context | Actual installed launcher instructions, MCP Skill link and its activation metadata, plus config are recorded in `raw/entry-context.json`; native-rollout exposure is distinguished from installation |
| Runs/resumes, native evidence and Map receipts | Fake Codex completes S0b's two turns in one native thread without fabricating Skill exposure; both writes have matching receipts and launcher Client IDs |
| Fixture permissions and sandbox | Fixture reads/writes succeed, personal workspace reads fail; actual Dedicated-profile connection attempts to 18765/18766 receive EPERM |
| Failure and refusal paths | Timeout cleanup, an existing Batch directory, direct Attempt sandbox opt-out, altered control/auth identities and a stopped service are tested without a model |
| Separate reporting | Dedicated and MCP-only retain separate cells, baseline slots and Markdown tables; mismatched Batch/Attempt Entries are refused |
| Approved five-check onboarding | **Pending Kun's Batch approval and coordinator execution.** `clients.ts` still lists Dedicated as unverified |

Build, full test suite and strict type checking pass with Node 26.3.0. No model, ChatGPT app, tunnel or everyday service operation was run. The proposed four-Attempt Batch and exact commands are in [the runner README](../../tests/behaviour/README.md#proposed-onboarding-batch-not-authorized-or-run): Codex · gpt-6-astra · xhigh · Dedicated, S0b and F11 twice each, ceiling four, zero model reviews/arbitrations. This sample does not establish the full-library baseline.
