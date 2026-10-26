# B09a isolated ChatGPT command

Implementation and review-remediation evidence for Issue #80 / PR #97, 2026-10-26. This record accepts no real ChatGPT behaviour or human verdict. The branch includes main through PR #92, Release Version 2.1.0; these test/documentation changes need no additional release bump under §14.3. The shipped daily runner remains unchanged.

## Delivered

`node tests/behaviour/chatgpt/run.ts plan|run` prepares a manually operated Batch using the shared Scenario library. The [operating guide](../../tests/behaviour/chatgpt/README.md) gives approval impacts, exact commands, capture format and old-chat/new-chat upgrade steps. The generated checklist gives each selected Scenario's messages and reply preconditions in order.

- Fresh database and credentials per Attempt in the behaviour-test cache; independent service/relay ports; no daily attach path or inherited database settings.
- Exclusive `opencode` ownership checks, temporary YAML ingress and cleanup. Existing target connectors are refused, never stopped; unrelated local tunnels do not block the Batch. The original config, credential files and DNS remain unchanged.
- Actual MCP request/result capture, native message and other-tool import, before/after Map history, receipts, service call metadata, explicit evidence gaps and separate Controller actions.
- Shared `verdict.ts`/`report.ts` results, all planned Attempts retained, separate app/web/mobile Combination keys and explicit untested surfaces.
- Controlled canary restart on the same owned database for both ChatGPT upgrade checks. No canary version or rule is injected into the Scenario message.

No implementation under `src/`, `scripts/`, `web/` or shared `tests/behaviour/runner/` changed in this PR. No global settings changed, no real database or credentials were inspected, and no real tunnel, model run or ChatGPT app operation was performed.

## Independent review remediation

Both full PR comments, **Independent review (Claude /code-review)** and **Independent review (Grok)**, were read before this follow-up. These regressions now run in `npm test` in `chatgpt/chatgpt.test.ts`.

| Finding | Change and regression evidence |
| --- | --- |
| Controller metadata could become client-visible rules and pass canary checks | Rules source and tool descriptions begin unknown. Only actual native `toolsShown` supplies parameter text and descriptions. Controller `serviceVersion` is separate; an explanatory string closes nothing. `judgeAttempt` on the complete canary record stays `insufficient-evidence` even after its model item is reviewed. A known native fixture passes; removing its canary description returns the item to unknown. |
| Aborted POST and absent `tools/call.params` orphaned the connector | Validate malformed requests, catch interrupted reads and protect observation callbacks. Full CLI tests reproduce both requests without a crash. Exception/rejection handlers wake the input loop and run teardown; a synchronous exit fallback terminates the child and removes config/lock. Tests cover both fatal events, direct exit, SIGINT, SIGTERM and EOF. |
| SIGKILL/power loss can leave an orphan | The child is no longer detached. Uncatchable exits cannot run cleanup; startup refuses a persistent lease or registered remote connector. The lease records owner/connector PIDs and config path; the error gives inspection and confirmed-orphan cleanup instructions. A SIGKILL test verifies refusal, then cleans up only its own fake orphan. |
| Isolation was asserted with constants | Record creation and `lsof` observations of the owning process's database paths, listeners and TCP ports at startup, turns, upgrade and shutdown. Compare 18766 listener PIDs before/after without connecting. Missing inventories stay unknown. The full CLI test supplies misleading daily environment variables and an owned sentinel, verifies only the new SQLite/listeners are open and verifies the sentinel remains unchanged. |
| New code missed the merge gate | Convert manual `verify.ts` to Vitest `chatgpt.test.ts`. Fake-only cases cover guards, seeding, captures, mode, missing evidence, old/new chats and cleanup. The real Batch command remains manual. |
| Resource support contradicted the profile | Start with `unavailable`; refuse contradictory imports for profile review. The old-chat test preserves one Revision; an invented Resource/read/retry path is violated rather than accepted. |
| Ownership detection was slow/nonfatal at begin | Check before every forwarded request, before begin and every second. Failures stop forwarding, record a Controller failure and terminate the Batch. All three paths are tested. This remains detection, not a distributed lock. |
| Empty connection arrays were ignored | Every registered connector counts as occupied; tests cover `conns: []`, reconnecting clients and a second connector beside the owned one. |
| JSON config had only fake coverage | Write actual YAML with quoted scalars, selected hostname/relay and final 404. The fake reads that shape; real parser verification remains a first-run step. |
| Report visibility/mode was hard-coded | Derive phases from the Attempt; not-run mode is unknown. Gate assertions cover actual `toolsOnly`, unknown instructions and a not-run result. |

Other suggestions addressed:

- Reuse `reservedPorts`; validate normal Scenarios; limit Batch IDs to 64 characters; stop at the ceiling with remaining items `not-run`. Gate tests cover refusals and the ceiling.
- Move ChatGPT upgrade turns and recovery kind into `upgrade-checks.ts`; use metadata rather than ID prefix/suffix semantics. All affected upgrade checks advance to version 2 because shared evidence requirements changed; older records are not re-judged.
- Rename the local type to `ChatGPTSurface`; add `canary-release.d.mts` and remove the corresponding type-error suppressions.
- Move ChatGPT guidance under Running a Batch and include `chatgpt/` in the existing two-review rule. That project rule remains the single review-policy location; PR review evidence verifies it was followed. No authorization gate changed.
- Allow ping and Resource/Prompt listing between turns. State reads/writes stay gated. Verify actual Refresh tools in the approved run.
- Bound registration/deregistration visibility retries and allow ten seconds for shutdown. Unknown/foreign state fails closed. Remote inventory is the authoritative guard for connectors, including service-manager launches without a visible target identity (see the startup fix below).
- Record handshake version and refuse a package/dist version mismatch. Still require a build immediately before every run: version comparison cannot detect same-version source edits. HEAD labels the checkout, not proof that a dirty build matches it.
- Print public read/mutate and attribution risks, unattended prohibition, other-hostname downtime, Kun takeover and surface-specific refresh steps. The operator must inventory original ingress hostnames before approval; generic `plan` intentionally reads no local configuration.
- Add approved daily-route restoration, refresh of normal tools and recording both actions. Explicitly retain S6 as a coverage gap.

Two suggestions remain deliberate limits: the restartable in-process service retains its small database/credential setup separately from the subprocess runner, while reusing ports, Controller and seeds; runtime databases/evidence stay in the mandated cache directory. The runbook requires the coordinator to archive the stopped Batch's evidence to an approved durable location before acceptance because macOS can purge Caches. The command does not silently select or write another destination.

## Second re-review remediation

Read the complete **Independent re-review (Claude /code-review)** comment. This round addresses its two must-fix findings and the related DELETE evidence defect; it does not claim that every optional design suggestion was implemented.

- Each fake fixture now uses a random tunnel UUID and therefore its own lease directory. CLI Batch IDs also use random UUIDs. Cleanup targets only that fixture's lease; it cannot delete the lease of another gate run. `verify-parallel.mjs` runs two independent copies of the ChatGPT suite in one checkout, or two complete `npm test` gates with `--full`.
- A supplied `toolsShown` array no longer establishes visibility by itself. Its `toolsShownSource` must name the exact `raw/wire.json#rpc-N` record for the same MCP session as the turn's observed tool calls. It must be the last POST `tools/list` before that session's first `begin` in the phase, after any service restart, with a successful result structurally identical to the full supplied definitions. Missing, mismatched, late, superseded and other-session evidence remains unknown. The validation result, source reference, session and phase boundary are preserved in `raw/tool-snapshot-N.json`.
- Eight canary cases exercise the actual capture import and `judgeAttempt`, with the model item reviewed: a matching pre-turn snapshot passes; no list, no reference, changed version, changed rule, another session, a superseded reference and a late list all leave the upgrade items unknown. The old-chat refusal test also verifies that a prior service/session's reference cannot populate the new phase.
- The relay records HTTP method and rejects bodies on session DELETE requests; the observer derives JSON-RPC events only from POST. A regression proves DELETE cannot fabricate a `map_apply` event.

Wire equality establishes what the identified client session fetched, not a direct observation of model cognition. Native chat evidence, intended-chat attribution, actual version use and Kun's acceptance are still required; an uncorrelatable real client stays unknown rather than inviting a Controller substitute. No shared verdict semantics, product code, release number or approval gate changed in this round.

## Local tunnel startup fix (2026-10-27)

The first real attempt was refused by the broad local process check even though the coordinator observed zero remote `opencode` connectors. The machine had two unrelated `cloudflared` services, one using `--token` and one using `--token-file`. Unrelated tunnels are common on a real machine; their presence alone cannot establish ownership of `opencode`.

The local check now refuses only `cloudflared` command lines with the target UUID, credentials-file path, selected config path or `opencode` name, plus the daily `scripts/local-chatgpt-test.mjs` runner. Matching uses complete arguments/option values, so another tunnel's name or path prefix is not enough. Opaque token processes defer to the authoritative remote inventory. No token is parsed/decoded or token file opened; process command lines stay in memory and never appear in logs or evidence.

The directory lock, refusal of every registered remote connector (including connected, reconnecting and zero-connection records), exclusive post-registration ownership, per-request/turn/second verification and exit cleanup remain enforced. Concurrent ownership checks share one inspection to avoid treating this command's own target-specific `tunnel info` subprocess as another connector.

The fake mode now runs the same local matcher against an optional synthetic process inventory; real mode always uses `ps`. With the old matcher, the new fake startup regression failed with `Another local tunnel connector or daily ChatGPT runner is active`; after the fix it starts, verifies ownership and cleans up with both unrelated token processes present and zero remote connectors. Additional regressions retain refusals for all four target identifiers, the daily runner and all three remote states. Existing full-CLI regressions still cover a later foreign connector, request/turn/timer aborts and exit cleanup. Neither the fixture credential path nor its token-file path exists.

This fix changes only the test command and its documentation, so §14.3 requires no Release Version bump. Real cloudflared, credentials, token files, models, ChatGPT and the daily service/database were not used for verification; the coordinator still owns the approved real retry and independent reviews.

Verified with Node `v26.3.0` after `npm ci`: `npm run build`, `npm test` (38 files / 1879 tests, including all 36 ChatGPT cases), `npm run typecheck` and `git diff --check` passed. The focused ChatGPT suite also passed 36 tests. The red run exercised the fake startup boundary and failed for the expected local-connector refusal before the matcher changed.

## Original command verification (PR #97)

Node `v26.3.0`; `npm ci`; latest main merged first. Final gates ran in this order:

| Command | Result |
| --- | --- |
| `npm run build` | Passed |
| `node tests/behaviour/chatgpt/verify-parallel.mjs --full` | Two concurrent `npm test` gates, each 20 files / 1347 tests passed, including 26 ChatGPT regressions |
| `npm run typecheck` | Passed |
| `git diff --check` | Passed |

The targeted ChatGPT suite passed 26 tests, and the default `verify-parallel.mjs` check passed two concurrent copies (26 each). The new regression tests only requested their own temporary loopback services. The fake cannot invoke real cloudflared, never reads its fixture credential path, and marks reports as fake. Daily-service observations used listener metadata without an HTTP request. The real database was neither discovered nor opened for comparison. Tests remove only their own directories and processes.

The original separate manual verification (five cases; 18 files / 1301 engineering tests at release 2.0.2) and first remediation's 20 files / 1338 tests plus 52 targeted ChatGPT/verdict tests are historical evidence. The gate results above supersede them for this revision.

## Standards self-check

Checked against `AGENTS.md`, `docs/agents/orchestration.md`, §14.3 and the two review axes, without sub-agents. Changes stay in the worktree and newly created test-cache directories. Fake tests enter the engineering gate following the existing runner precedent; real-model/client runs remain manual and authorized separately. No shipped behaviour changed. The coordinator owns independent follow-up review and merge.

## Spec self-check and remaining acceptance

The command supplies R9 / §4 preparation, isolation observations, operator steps, capture and shared verdicts. Regressions demonstrate the reported false-green and crash paths are closed; they do not prove real client visibility, Cloudflare behaviour or human acceptance.

Still required after Kun approves the Batch and impacts:

- Confirm the non-secret UUID/path configuration, affected hostnames, generated YAML, real registration/`info` shape and Refresh tools. The agent must not open credential files.
- App results for S0b, S1, S5, S9, F11 and applicable change-related Scenarios. S6 applies but remains rejected because its multi-session Controller actions are unsupported; this is a coverage gap, not a pass.
- Actual `toolsOnly` client snapshot and native evidence that the agent obtained the write version from it. Controller definitions or matching writes cannot substitute.
- Both upgrade checks: refusal in the old chat and correct new-rule recovery after refresh/new chat.
- Onboarding evidence, approved model-item reviews, Kun's verdicts and final acceptance. The separate cross-client human journey remains B09c.
- Approved route restoration and normal snapshot refresh if the daily connector was stopped; durable evidence archival. Web and mobile remain untested unless separately approved and run.

The shared tunnel cannot be atomically reserved against arbitrary connectors elsewhere. SIGKILL/power-loss recovery requires owner inspection; stale locks are never stolen. These limits are printed or documented before the first real run.
