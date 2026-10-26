# B09a isolated ChatGPT command

Implementation evidence for Issue #80, 2026-10-26. This record accepts no real ChatGPT behaviour or human verdict. The implementation is test/documentation only; the shipped daily runner and Release Version remain unchanged under §14.3.

## Delivered

`node tests/behaviour/chatgpt/run.ts plan|run` prepares a manually operated Batch using the shared Scenario library. The [operating guide](../../tests/behaviour/chatgpt/README.md) gives approval impacts, exact commands, capture format and old-chat/new-chat upgrade steps. The generated checklist gives the messages and reply preconditions of each selected Scenario in order.

- Fresh database and credentials per Attempt under the behaviour-test cache; independent service/relay ports; no daily attach path or inherited database settings.
- Exclusive `opencode` ownership checks, temporary ingress configuration and cleanup. Existing connector processes are refused, never stopped. The original config, credential files and DNS remain unchanged.
- `toolsOnly` credentials and recorded write parameter descriptions. Service-offered definitions are kept apart from client-exposed definitions; unknown client visibility is never promoted to evidence.
- Actual MCP request/result capture, native message and other-tool import, before/after Map history, receipts, explicit evidence gaps and separate Controller actions.
- Shared `verdict.ts`/`report.ts` results, all planned Attempts retained, separate app/web/mobile Combination keys and explicit untested surfaces.
- Controlled canary restart on the same owned database for both existing ChatGPT upgrade checks. No canary version or rule is injected into the Scenario message.

No code under `src/`, `scripts/`, `web/` or shared `tests/behaviour/runner/` changed. No global settings changed and no real tunnel, model run or ChatGPT app operation was performed.

## Verification

Node `v26.3.0`; dependencies installed with `npm ci`; `npm run build` preceded verification.

| Command | Evidence |
| --- | --- |
| `node --test tests/behaviour/chatgpt/verify.ts` | 5 manual verification cases passed; fake cloudflared only, no model |
| `npm test` | 18 test files, 1301 tests passed |
| `npm run typecheck` | Passed |
| `git diff --check` | Passed |

The five verification cases cover:

1. Initial-five checklist/messages, approval impacts, unsupported Scenario refusal and duplicate selection refusal.
2. Local connector detection from fixed process inventories; remote connector and reconnect refusal; malformed remote state; exclusive lock; reserved-port refusal; fake registration/ownership loss; startup failure; original config preservation and cleanup.
3. Real isolated service seeding with the stale Claim retained; out-of-turn call rejection; private viewer exclusion; compatibility parameter; actual refusal receipt; reply precondition gate; native other-tool capture; missing messages staying open; token redaction and credential cleanup.
4. Real owned service restart onto the existing canary build, refused old-version write without a Revision, new-version write with the canary Ticket title and distinct session-B author, and only two total Revisions.
5. The full manual CLI with fake tunnel: deliberately misleading `WAYFINDER_DATABASE_PATH`, `WAYFINDER_PORT=18766` and attach-token environment; fresh F11 seed; one labelled turn and capture; next Scenario on a different fresh database; SIGTERM cleanup and complete/cancelled/not-run accounting. `lsof` on **only the child PID** proves that it opened its own SQLite and listened on only its allocated ports, not 18765/18766. An owned sentinel file supplied as the purported daily database stays unopened and byte-identical. The real database was neither discovered nor opened for comparison.

The first verification run encountered the actual daily connector and the normal ownership guard correctly refused before any cloudflared invocation. It was left running. The final fake mode uses the checked-in non-networking test double, skips the actual process inventory and uses fake remote connector records; it cannot invoke a real tunnel binary. Fixed inventories test the normal local guard separately. Fake reports explicitly state that they are not ChatGPT acceptance.

The test cases remove only their own newly created directories. Real-run evidence is retained outside the repository; the command never overwrites an existing Batch directory.

## Standards self-check

Checked against `AGENTS.md`, `docs/agents/orchestration.md`, the release rules and the code-review skill’s two axes, without sub-agents as required by the worker brief. Boundaries remain in the worker’s worktree and newly created cache directories. The runner is manual, does not enter `npm test`, reuses Scenario seeds and verdicts, and makes no shipped change. Type checking and existing engineering gates pass. Independent review belongs to the coordinator.

## Spec self-check and remaining acceptance

The command implements preparation/isolation, the operator checklist, evidence collection and shared reporting required by R9 and §4. Isolation has the fake-tunnel evidence above. Actual client visibility is recorded only from native captures; client metadata, other-tool activity or version-source evidence that was not captured is listed per Attempt in the report. A Scenario pass is not final B09a acceptance.

Still required after Kun approves the Batch and app/tunnel impacts:

- App results for S0b, S1, S5, S9, F11 and any change-related applicable Scenarios.
- Actual `toolsOnly` client snapshot and evidence that the agent obtained the write version from it.
- Both ChatGPT upgrade checks: refusal in the old chat and correct new-rule recovery after refresh/new chat.
- ChatGPT driver onboarding evidence and any approved reviews needed to decide model items.
- Kun’s required human verdicts and final acceptance. The separate cross-client human journey remains B09c.
- Web and mobile remain untested unless approved and run as separate Batches.

The shared tunnel cannot be atomically reserved against arbitrary connectors started elsewhere. The command checks before startup, before turns and every 15 seconds, aborting on unknown/lost ownership. Operators must keep other connectors stopped during the Batch; this limitation is printed before approval. SIGKILL/power-loss recovery needs inspection of the recorded owner and surviving owned connector; stale locks are never stolen. The old daily runner remains unchanged.
