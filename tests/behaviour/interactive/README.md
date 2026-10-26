# Interactive acceptance (B09b, Issue #81)

This manual tool checks the four R9 capabilities separately in interactive **Codex CLI** and **Claude Code CLI**. It starts no model. The operator launches clients only after Kun approves the Batch. All committed records are synthetic; none establishes real client support.

`host.ts` reuses B02a's service, Controller and macOS allowlist sandbox. `cli.ts` imports explicitly named native files into B01 AttemptRecords and uses `verdict.ts` for script checks and content review. The B01 Scenario format, scripted W1/W7 verdicts and global client capability values are unchanged. Interactive variants B09Async, B09Prepare, B09Adjust and B09Continue now use **verdict version 2**: the review fixes tighten identity, support, timing and content-evidence gates. Version 1 results cannot be re-judged as version 2. These four outcomes do not replace the complete W1/W7 checks or B09c/B10 human acceptance.

## Confirm support before collecting acceptance evidence

1. Read the current [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Codex app-server reference](https://developers.openai.com/codex/app-server/), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Claude hooks reference](https://code.claude.com/docs/en/hooks), plus the installed binaries' `--help` and `--version`. Record the exact version, surface, mode, flags, model and effort. App-server support is not proof of CLI support; a blocking question tool or queued input is not asynchronous questioning.
2. Run one **separate approved minimal probe per Combination** with the same subscription authentication, Entry and isolation as acceptance. Ask it to propose a synthetic choice, ask for an answer without ending the turn, read a harmless fixture while waiting, adjust the recommendation to a contrary answer, and ask the next concrete question without a nudge. Wait for completed useful output, not a timer. Do not install a new tool or change mode to manufacture support.
3. Independently classify each capability as supported, unsupported or unverified. Supported requires the earlier probe's native JSONL **and Controller capture**, exact file hash, native line references, selection of relevant events, and an operator reading. Confirmation must finish before acceptance capture starts. Unsupported is an explicit operator declaration citing the version/mode documentation and reason; its coverage gap is not a passed probe. A missing observation remains unverified.
4. The importer actually parses the probe: it checks its time range, distinct native session ID, version, model, effort, surface, Entry, declared capture window and the native structural evidence for the claimed capability. `./` aliases, identical copies, same-session records and backdated metadata are rejected. Keep both redacted probe files and copy only those files into the fresh acceptance directory. If the acceptance record lacks model/effort/version evidence, the outcome stays insufficient evidence instead of borrowing the requested settings.

The adapters intentionally recognize a conservative native subset. The synthetic Claude `system/init` effort field is a parser test, **not a claim that the installed Claude emits it**. Validate the real format in the approved probe. Missing effort, unknown format, sidechains, compaction, ambiguous queued input or missing boundaries must stay unknown; never fill actual model/effort from requested flags. Changes to native schemas require fixed regression evidence before wider acceptance.

## Subscription prerequisites

API-key billing is removed. The launcher uses `env -i` and explicitly clears `CODEX_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. It never copies, reads or prints a login file or keychain entry itself.

- **Codex:** its private CODEX_HOME contains a symlink to the existing `~/.codex/auth.json`. The outer sandbox grants read access to exactly that file, not the containing directory; the normal config, sessions and other private files remain denied. No copy, sync-back or global login repair occurs. If the subscription login needs refresh or cannot be used under those permissions, stop the Attempt and have Kun resolve the normal login outside the test. `--no-daemon` keeps the MCP connection inside the isolated process. The unsupported interactive `--ignore-user-config` flag is gone. Fresh HOME/CODEX_HOME provide configuration isolation; the external sandbox remains authoritative.
- **Claude Code — requires Kun's action:** this isolated host keeps a scratch HOME and therefore does not use the normal keychain route. Before the Batch, Kun must approve **`claude setup-token` in the browser** if no valid subscription OAuth token is available. Only Kun performs that step. Supply the resulting `CLAUDE_CODE_OAUTH_TOKEN` through the private operator-terminal environment without echoing it or saving it in repository files. The generated launcher requires that variable and has no API-key fallback. Never copy keychain entries. The alternative documented in the dedicated launcher (`CLAUDE_SECURESTORAGE_CONFIG_DIR` empty with the real HOME) is deliberately not used here because it would broaden this host's isolation boundary.

The subscription route must pass the minimal probe before acceptance. The worker does not run login, auth-status, setup-token, credential reads or real model sessions.

## Proposed first Batch (not authorization)

| Combination | Entry / surface | Separate probes | W1 | W7 |
| --- | --- | ---: | ---: | ---: |
| Codex · `gpt-6-astra` · `xhigh` | MCP-only / interactive-cli | 1 | 2 | 2 |
| Claude Code · `claude-sonnet-5-5` · `high` | MCP-only / interactive-cli | 1 | 2 | 2 |

Maximum **10 interactive sessions**: 2 probes and 8 Attempts, no retries or substitute models. Two baseline Attempts per Scenario cover each new Combination. The exact model names and access must be confirmed in the approved probe; unavailable settings stop expansion.

One shared review-input bundle includes all four content items. Two independent reviews per Attempt mean **16 review invocations**; allow at most **8 arbitrations**. The total ceiling remains **34 model invocations**, including sessions. Codex uses Sonnet 5.5 reviews and Opus 5.5 arbitration; Claude uses GPT-6.1-Sol reviews and Astra arbitration, with exact model IDs recorded. The coordinator confirms availability and retains provenance. No model reviews run automatically here.

## Start a private Attempt

```sh
export PATH="$(dirname "$(npm exec --yes --package=node@26.3.0 -- node -p process.execPath)"):$PATH"
npm ci
npm run build

# Separately, after approval, using each actual absolute binary path.
node tests/behaviour/interactive/host.ts B09b-approved codex-W7-1 codex gpt-6-astra xhigh W7 /absolute/path/to/codex
node tests/behaviour/interactive/host.ts B09b-approved claude-W7-1 claude claude-sonnet-5-5 high W7 /absolute/path/to/claude
```

Use a fresh Attempt name for each probe and each W1/W7 repetition. The host refuses existing directories. It creates only its own database under `~/Library/Caches/wayfinder-behaviour-tests/<batch>-<attempt>/`, a free port excluding 18765/18766, distinct Controller/agent credentials, and scratch HOME/work directories under `/private/tmp`. It injects no Skill, AGENTS.md, workflow or service version into the client. It never starts a tunnel, `wayfinder`, or the everyday service.

Keep the host terminal open; run its printed private `launch.sh` in another terminal. Codex uses its subscription link; Claude requires the subscription OAuth variable in that terminal. Both use process-local MCP configuration, the outer `sandbox-exec` allowlist, and explicit approval modes suitable for that external sandbox. Verify those modes in the probe. The host has a 60-minute ceiling. Stop the manually launched client before finishing or cancelling the host; another terminal's client exit remains operator-attested, not measured.

## Operator checklist

1. Complete all capability confirmations and subscription prerequisites first. Preserve the probe JSONL and its capture before starting this Attempt. Use the host's opening line for W1/W7; do not paste this checklist, acceptance criteria or copied workflow rules into the client.
2. Answer only a proposal actually shown. For W7, supply a concrete contrary constraint, such as mobile-only entry when the proposal assumed desktop access. Record the actual answer. Do not send a nudge to manufacture continuation. An absent required proposal ends as `precondition-not-met`.
3. Record completed preparation while the answer is pending. Select a real output finding and cite where the later recommendation uses it. Agent/Task launch notices, lifecycle calls, command exit status and `sleep` are not findings. A faster next turn is observation only.
4. Exit the client first, then give the host its actual outcome: complete, precondition-not-met, launch-failed, timeout, rate-limited, cancelled, driver-failed or service-failed. Every started host Attempt retains a capture, including setup/service failure. Missing records remain missing.
5. Inspect `isolation.json`. It now contains before/after hashes and run-path checks for the two named non-credential personal config files, listener/database metadata snapshots, the actual service exit result, and its observed open database. It does not read auth files, service credentials or database contents. A missing observation is unknown. Stable snapshots do **not** prove absence of transient calls to the everyday service; that claim remains explicitly unknown. No request is sent to the everyday service. Cleanup removes only this host's scratch and temporary credential file; private test database/evidence remain.
6. Select the main session by native ID from `raw/native-*.jsonl`; never combine sessions or parent/child logs. Copy the fixture assessment as a **shape only**, replace every synthetic value, and keep `reviews: []`. The fixtures contain no ready-made reviews. Set `verdictVersion: 2`, event selectors, `preparationFinding` (an exact quote from completed output) and `preparationUse` (an exact quote from the later recommendation). Unknown facts stay unknown.
7. Import once without reviews. Use the emitted `review-input.json` for two independent other-vendor review sessions. Retain each actual input, output, visible model, reviewer and native session ID; the same cached output is not an independent reading. Review output may be one bundle with `items`, each naming `ability`, `status`, `reason` and `evidence` (native event `seq` plus exact content `quote`). There is deliberately no pre-filled `holds` example.
8. Supply a **separate** `wayfinder-interactive-reviews/1` manifest through the CLI's optional fifth argument. Each `records` entry identifies ability, role (`review` or `arbitration`), reviewer, sessionId, vendor, model, and input/output references (`path`, `sha256`). A grouped output file may be referenced for its four items. Arbitration also retains `basis` references to both independent outputs. The importer verifies hashes, exact Attempt/input binding, cited event content, distinct reviewers/sessions/outputs and the R4 vendor/model route. Re-import into a fresh output directory; earlier results remain intact.
9. File-supplied human verdicts are rejected, including entries claiming `by: Kun`. The importer cannot authenticate a human and therefore leaves missing evidence open. When Kun is needed, the coordinator asks him through the authorized human channel with the Attempt ID, item, review-input hash and native event locations, then preserves his actual reply and those bindings in the separate acceptance record. No local file can turn that into a machine `pass`; B09c/B10 acceptance stays with Kun.

```sh
node tests/behaviour/interactive/cli.ts \
  "$HOME/Library/Caches/wayfinder-behaviour-tests/B09b-approved-codex-W7-1" \
  raw/native-0.jsonl assessment.json judged-1

# After the approved independent reviews have completed:
node tests/behaviour/interactive/cli.ts \
  "$HOME/Library/Caches/wayfinder-behaviour-tests/B09b-approved-codex-W7-1" \
  raw/native-0.jsonl assessment.json judged-2 reviews.json
```

All paths except the private root are relative to that root. Output must be a fresh direct child outside the repository. Outputs include B01 AttemptRecords, the four verdicts with reasons and native locations, a snapshot of the assessment/review artifacts, and the common review input. If all capabilities are affirmatively declared unsupported, use `-` for the native filename and an explicit preflight capture; no acceptance session is needed. This produces coverage gaps, never pass. An unconfirmed unsupported declaration stays insufficient evidence without a misleading coverage-gap conclusion.

## Evidence limits

Asynchronous asking requires question, completed work **and answer in the same active native turn**. Preparation requires actual completed output before the answer and evidence of its later use; semantic relevance still needs review. The allowlist accepts direct read tools, Map reads, and simple read-only commands with a successful result and real output; arbitrary shell/agent-control success cannot count. Adjustment compares the original proposal, changed answer and new recommendation. W1 continuation requires answer and next concrete question/action in the same answer-handling turn, with no intervening nudge; its earlier question may belong to a previous turn.

Codex uses task_started/task_complete and response_items; duplicated event text is not double-counted. Claude uses transcript user/assistant blocks, tool IDs and explicit end_turn/turn_duration boundaries. Rejected/cancelled question results are not human answers; recognized metadata is not user choice; ambiguous mid-turn queue records leave a boundary gap. Unknown model or effort blocks pass, and conflicting observations are not overwritten by a convenient later value. A proved temporal violation remains fail even when a run times out.

Rules seen only by the Controller are never claimed to be shown to the model. Missing usage, file/delegation classes or process evidence remain explicit. Native formats and subscription operation still need the approved real probes; synthetic fixtures prove only the testing tool. Validate without models:

```sh
npm run build
npm test
npm run typecheck
```
