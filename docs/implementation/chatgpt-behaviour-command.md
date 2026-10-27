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
- Allow `server/discover`, `ping`, `resources/list`, `resources/templates/list` and `prompts/list` between turns, alongside initialization, `tools/list` and bodyless session DELETE. `tools/call`, `resources/read` and `prompts/get` stay gated. Verify actual Refresh tools in the approved run.
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

The local check now refuses only `cloudflared` connector launches with the target UUID, credentials-file path, selected config path or `opencode` name, plus the daily `scripts/local-chatgpt-test.mjs` runner. Matching uses complete arguments/option values, so another tunnel's name or path prefix is not enough; UUID matching ignores letter case. Opaque token, default-config and indirect-config launches without a visible target identity defer to the authoritative remote inventory. No token is parsed/decoded or token file opened; process command lines stay in memory and never appear in logs or evidence.

The directory lock, refusal of every registered remote connector (including connected, reconnecting and zero-connection records), exclusive post-registration ownership, per-request/turn/second verification and exit cleanup remain enforced. Concurrent ownership checks share one in-flight inspection and its outcome; callers arriving during that inspection use its existing snapshot rather than starting a second query. Diagnostic subprocesses are excluded by command action independently of that sharing, as corrected below.

The fake mode now runs the same local matcher against an optional synthetic process inventory; real mode always uses `ps`. With the old matcher, the new fake startup regression failed with `Another local tunnel connector or daily ChatGPT runner is active`; after the fix it starts, verifies ownership and cleans up with both unrelated token processes present and zero remote connectors. Additional regressions retain refusals for all four target identifiers, the daily runner and all three remote states. Existing full-CLI regressions still cover a later foreign connector, request/turn/timer aborts and exit cleanup. Neither the fixture credential path nor its token-file path exists.

This fix changes only the test command and its documentation, so §14.3 requires no Release Version bump. Real cloudflared, credentials, token files, models, ChatGPT and the daily service/database were not used for verification; the coordinator still owns the approved real retry and independent reviews.

Verified with Node `v26.3.0` after `npm ci`: `npm run build`, `npm test` (38 files / 1879 tests, including all 36 ChatGPT cases), `npm run typecheck` and `git diff --check` passed. The focused ChatGPT suite also passed 36 tests. The red run exercised the fake startup boundary and failed for the expected local-connector refusal before the matcher changed.

## PR #117 review follow-up (2026-10-27)

Read the full **Independent review (Claude /code-review)** and **Independent review (Codex gpt-6-astra)** comments. The broad target-identity matcher also treated diagnostic processes as connectors: an operator's `tunnel info opencode`, or this command's own `info` subprocess from an overlapping lease, could falsely abort an Attempt. Sharing `check()` calls alone did not solve that classification error.

The matcher now requires the `tunnel … run` action (only options may precede `run`), or the legacy config-only launch form; it ignores diagnostic actions and retains owned-connector PID exclusion. Six fake runtime tests inject operator `info`, the exact own-`info` command shape, `list`, `route`, `ingress` and `token` beside the owned connector. All six failed before this change and pass after it; adding a separate target connector still makes each check fail. Two case-swapped UUID startup refusals likewise failed before the case-insensitive local match and pass after it. Direct matcher assertions also pin both unrelated token forms.

The two Codex suggestions are covered: the fake records only an `info` counter marker, and 20 overlapping checks must issue one query, propagate a later foreign connector's rejection to all callers, then issue a fresh query after that failure. Temporarily removing sharing made this test fail (20 inspections instead of one); restoring sharing passes. The duplicate sharing wrapper in `run.ts` was removed, leaving the lease as the common path for requests, turns and the monitor. Default-config and alternate-config launches containing the same UUID are tested against connected, reconnecting and zero-connection registered remote states; temporarily removing the startup remote guard made all six cases fail, and restoring it passes. No other config is inspected to infer a running process's identity.

The operating guide now explicitly allows read-only diagnostics during a Batch and documents default/indirect config reliance on remote inventory. This follow-up used only synthetic process lists and the checked-in fake cloudflared; real-client acceptance and the approved retry remain with the coordinator.

Verification on Node `v26.3.0`, after merging the latest `origin/main` (already up to date): `npm run build`, the focused ChatGPT suite (51 tests), `npm test` (38 files / 1894 tests), `npm run typecheck` and `git diff --check` passed. Type checking caught an overly narrow inferred UUID type in the test fixture; an explicit string parameter fixed it and the rerun passed. No shipped files or Release Version changed.

## Out-of-turn Resource Template discovery fix (2026-10-27)

The coordinator reported that ChatGPT's Refresh tools failed twice during the approved Batch; its public-endpoint diagnostic isolated HTTP 503 to `resources/templates/list` outside a labelled turn. The relay's discovery allowlist omitted that method. It now forwards it, with the same ownership check and wire capture as the other discovery calls. No Map read/write methods were added to the allowlist.

A full CLI regression uses only the checked-in fake cloudflared and a fresh real local service/database. Without starting any turn, it exercises initialization, its notification, tool/Resource/Resource Template/Prompt listing, ping and bodyless session DELETE. It checks exact wire responses and session IDs, refuses both read and write `tools/call` requests plus `resources/read` and `prompts/get` with HTTP 503, and verifies the refused calls never enter forwarded wire or Scenario events. A ping after DELETE receives HTTP 404, proving the upstream session was terminated.

The new test failed before the fix with `resources/templates/list: 503 !== 200`. The current service has no Resource Template handler, so the expected forwarded response is HTTP 200 with JSON-RPC error code `-32601` and the service's sanitized message `Protocol request failed`, preserved unchanged in `raw/wire.json`. This fixes the relay rejection; actual ChatGPT acceptance of that upstream response remains for the coordinator's approved Refresh tools retry. No real tunnel, credential file, model, daily service or real database was used, and no Release Version bump is required for these test/documentation changes.

Verification on Node `v26.3.0`, after `npm ci` and confirming the branch includes the latest `origin/main`: `npm run build`, the focused new regression, `npm test` (38 files / 1895 tests, including 52 ChatGPT cases), `npm run typecheck` and `git diff --check` passed. An initial expectation used the SDK's error text; the service sanitizes that text, so the test now asserts the actual service response and the complete gate was rerun successfully.

## Out-of-turn `server/discover` fix (2026-10-27)

Batch `B09a-app-20261027d`'s `raw/relay-refusals.jsonl` named the next Refresh tools failure: ChatGPT App 26.1016.62342 opens refresh with `server/discover` (MCP `2026-07-28`), and the relay answered it twice with 503 `outside_turn`. The relay now forwards `server/discover` between turns like the other read-only discovery calls; `tools/call`, `resources/read` and `prompts/get` stay gated. With the same one-line change applied locally, Batch `B09a-app-20261027e`'s wire record showed `server/discover` → service HTTP 400 / JSON-RPC `-32000` (SDK v1 has no such method), the client's fallback `initialize` (`2025-11-25`) → 200 and `tools/list` → 200, and refresh succeeded (#80 comment). This matches the two protocol eras in [`mcp-sqlite.md` §15.2](../spec/mcp-sqlite.md#152-sdk-v2-and-two-protocol-eras).

The regression starts an Attempt with no turn, posts the real request shape without a session header, and checks that the client receives the service's status and body unchanged, that `raw/wire.json` records the exchange with the request intact, and that `raw/relay-refusals.jsonl` stays empty. It does not pin the service's answer, so it keeps holding after #110 moves the service to SDK v2. Before the fix it failed with `server/discover was not forwarded: HTTP 503`; the current service answers HTTP 400 `{"code":-32000,"message":"Initialization required"}`. Only the checked-in fake cloudflared and a temporary local service were used; no real tunnel, ChatGPT client, model or real database. Behaviour tooling only, so no Release Version change.

Verification on Node `v26.3.0` after `npm ci`, with the branch on the latest `origin/main`: `npm run build`, the focused ChatGPT suite (72 tests), `npm test` (48 files / 2218 tests), `npm run typecheck` and `git diff --check` passed.

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
