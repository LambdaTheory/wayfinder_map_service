# Behaviour Scenarios

The Scenario library and evidence contract of the [behaviour testing requirements](../../docs/spec/behaviour-testing.md) (B01, Issue #64). Scenarios describe how an agent in a real client must behave on a Wayfinder Map; Drivers (B02 onwards) start clients against an isolated service and record what happened; verdicts (B03) judge the record.

Listing and validation start no service or model. Manual runners start isolated services; runs that spend model quota happen only inside a Batch Kun has approved. Raw conversations and run records stay in a private directory outside the repository.

## Layout

| Path | What it holds |
| --- | --- |
| `scenario.ts` | The Scenario format, structural validation and readiness |
| `clients.ts` | Client profiles and the applicability matrix |
| `evidence.ts` | The Attempt record every Driver produces (R3), write-result classes (R4) and redaction |
| `checks.ts`, `common.ts` | Script checks over an Attempt record, and the common checks attached to many Scenarios |
| `library.ts`, `scenarios/` | The 26 candidates of spec §3 |
| `upgrade-checks.ts` | Upgrade compatibility checks, listed apart from the 26 |
| `seeds/` | Seed Maps; `f11.json` is the redacted capture of a real Map |
| `fixtures/` | Working-directory fixtures copied into the agent's directory |
| `runner/` | The runner: isolated service, Controller, Codex MCP-only and Dedicated Drivers, normalizer (B02a/B02d) |
| `chatgpt/` | Manual isolated ChatGPT Batch preparation, relay capture and operator checklist (B09a; real acceptance pending) |
| `verdict.ts`, `report.ts` | Verdicts of Attempts and cells, and the comparison report (B03a) |
| `model-review.ts`, `review-verdict.ts`, `review-no-writes.ts`, `review-types.ts`, `review-cli.ts`, `review-run.ts` | Other-vendor model readings, their evidence boundary, isolated CLI Driver and manual command (B03b) |

```sh
node tests/behaviour/cli.ts list       # candidates, readiness, item counts
node tests/behaviour/cli.ts matrix     # applicability per client and Entry
node tests/behaviour/cli.ts upgrade    # upgrade compatibility checks
node tests/behaviour/cli.ts validate   # structural validation
```

Use Node 26.3.0. `library.test.ts` runs in `npm test`; it validates the library and pins check semantics on small fixed evidence.

## A Scenario

- **Identity and source:** a stable ID, a `version` raised whenever a verdict item changes, and a source: real problem or design hazard, what happened, portable references (Map ID and Revision, date, Issue). Diagnostic probes are not Scenarios.
- **Applicability:** the Entries (`mcp-only`, `dedicated`, `chatgpt`, `matt`) and client capabilities it needs. A cell stays "not onboarded" until that client's Driver passes the five onboarding checks of R2.
- **Seed:** Maps rebuilt to their current visible state, or (`restores: 'history'`) replayed Revision by Revision with their original authors when the Scenario depends on history; plus fixtures. A seed taken from a real Map lists every conversion step, including Claims kept or cleared and redactions.
- **Turns:** each `reply` names the proposal it answers and a runtime cue; the runner sends it only after that proposal appeared, and the precondition is judged again afterwards. `nudge` turns carry no answer.
- **Controller actions:** conflicting writes, cut routes, restarts. Each action that should provoke a reaction needs a script-proven required event.
- **Verdict items:** `requiredEvents` are proven first; any confirmed `mustNot` fails; every `expect` group needs evidence for one of its equivalent ways. Items are judged by script, or by a model or the human with a written criterion. An item whose correct behaviour is not yet decided is `paused` and goes to the human.

Script checks answer `holds`, `violated` or `unknown`. Missing records (the `missing` markers of `evidence.ts`) or a write without a receipt never become `holds`; only a receipt places a write in a session and turn.

## Adding a Scenario

1. Write it in the matching file under `scenarios/` and add it to `library.ts`; a new real problem also gets its ID in `candidateIds`.
2. Write must-not items as the wrong action itself and expectations as the right action, each with the evidence that proves it.
3. Run `node tests/behaviour/cli.ts validate` and `npm test`.
4. A real problem starts from the Revision before the incident and the human's own words (R6); record the conversion in `seed.derivedFrom` and redact private paths and credentials.

## Running a Batch

```sh
npm run build    # the runner serves this checkout's dist/
node tests/behaviour/runner/run.ts --batch B1-20261025 --scenarios S0b,F11 --count 2 --ceiling 4 --model gpt-6-astra --effort xhigh
```

Run only a Batch Kun approved: it spends model quota. Every MCP-only Attempt gets a new database under `~/Library/Application Support/Wayfinder/behaviour-runs/<batch>/<attempt>/`, a free port (never 18765 or 18766), a Controller credential and one credential per session, so each Revision names the session's credential. The Controller seeds the Maps with the current release's `version`; the agent must find its own `version` in what its client shows it.

Codex runs with a private `HOME` and `CODEX_HOME` under `/private/tmp`, `--ignore-user-config` and only this run's Wayfinder server, inside `sandbox-exec` with an allowlist: it reads nothing under the home directory except the Node that runs it, nothing under `/private/tmp` except its own scratch, writes only to that scratch and the system temp, and cannot connect to ports 18765 and 18766. The daily Codex login is copied into the scratch and deleted with it; its values are redacted from records like the Wayfinder tokens.

Before anything runs, the runner refuses what it cannot do (Controller actions, several or concurrent sessions, history seeds: B02b and B04) and an existing output directory. A plan larger than `--ceiling` runs up to it and lists the rest as not run; Ctrl-C stops the client and service and marks what is left cancelled. Each Attempt writes `attempt.json` (the evidence record plus isolation facts: whether the sandbox was on, whether the service opened only its own database and never the everyday one, scratch removed, built-in client skills, and whether every committed receipt matches a Revision its session's credential authored) and `raw/` (Codex JSON per turn, the session log, the service log and initialize report, the final working directory), with credentials replaced by placeholders. `batch.json` lists every planned Attempt's outcome and compares personal configuration and the everyday service before and after.

`runner/runner.test.ts` covers the runner without a model: refusals, every library seed against the real service, the sandbox profile, and one S0b Attempt played by `runner/fake-codex.mjs`, which makes real MCP calls.

For ChatGPT, use the separate [isolated Batch command and operating checklist](chatgpt/README.md). `plan` prints approval impacts and messages without starting anything; `run` requires the approval reference and owns a fresh database, service, relay and exclusive tunnel. The initial five and upgrade checks still need a real approved run; App, web and mobile remain separate. `chatgpt/chatgpt.test.ts` runs the fake-tunnel, no-model regression checks in `npm test`; the real Batch command remains manual.

## Codex Dedicated Entry

Select `--entry dedicated` to drive the repository's `scripts/wayfinder-agent/wayfinder` through its documented noninteractive passthrough. The default stays `--entry mcp-only`. Both Entries use the same Scenario inputs, Controller, native-output normalizer, receipts and allowlist sandbox. Dedicated Batches refuse `--no-sandbox`. Dedicated support remains **unverified** in `clients.ts` until its five onboarding checks have evidence from a Batch Kun approved; synthetic tests do not onboard it.

| Context | MCP-only | Dedicated |
| --- | --- | --- |
| Client invocation | `codex exec`, `--ignore-user-config` | Actual `wayfinder --harness codex --method mcp -- …`, including `--no-daemon` |
| Launcher instructions | None | Launcher installs its unchanged instruction template as the private `CODEX_HOME/AGENTS.md`, substituting the run's output path |
| Wayfinder Skill | None | Launcher installs the repository's MCP Skill, copied unchanged into the run's projected checkout |
| Configuration | Runner's command-line MCP configuration | Launcher's real `config.toml` template and command-line model, effort and MCP URL overrides |
| MCP unavailable | `required=true` makes client initialization fail | Launcher config does not require MCP; if it becomes unavailable after launcher probing, Codex may continue without the tools |
| Personal context | Denied by the allowlist | Also denied; the launcher's reference to project control planes does not make personal files readable |

The Controller creates and owns the service before invoking the launcher. All launcher overrides are supplied: `WAYFINDER_AGENT_STATE_ROOT`, `WAYFINDER_AGENT_SERVICE_DIR`, `WAYFINDER_AGENT_OUTPUTS`, `WAYFINDER_AGENT_PORT`, `WAYFINDER_AGENT_DATABASE` and `WAYFINDER_AGENT_CHECKOUT`; `WAYFINDER_AGENT_USAGE=test` marks launcher metadata as test use. `HOME` points to a runner-owned private launcher home in the cache, separate from the writable client home. Its copied login is pinned by file type, device/inode and parent identities; native auth may only link to that source or be a regular refresh file. Every turn rechecks those identities before synchronization and recollects refreshed login strings before writing evidence. No daily installation ID is imported. No new launcher overrides are needed.

The database and credentials live in a new directory under `~/Library/Caches/wayfinder-behaviour-tests/`; the writable client state, outputs and fixtures live in the Attempt's scratch. The shim, sandbox profile and projected checkout are kept in a separate runner-owned control directory in the cache. Final sandbox write denials protect that directory, launcher-owned files and parent directory entries; file identities and the complete control-tree hash are rechecked before every launch. The projection contains only the unchanged MCP Skill, with no service build: if the owned service disappears, the launcher fails instead of starting an untracked daemon. The actual launcher still comes from this repository. The launcher and private `codex` shim use an absolute Python interpreter with isolated imports. The shim validates the client HOME, CODEX_HOME and MCP URL, records its launch credential for redaction, strips bootstrap variables, and puts the client inside the shared allowlist sandbox. The client cannot read the service directory, repository source or verdicts; ports 18765 and 18766 remain denied. The Controller closes its connection, stops only its own service, preserves the stopped database under the Attempt's `database/` even if catalog export failed, and then removes the service directory, credentials and scratch. The effective sandbox profile, shim and control manifest are retained in `raw/`.

Each Attempt records `entry=dedicated`, the launcher surface, the additional context in `given[].extraContext`, and `raw/entry-context.json`: source names (including Skill activation metadata), installed text, hashes, whether that text appears in the native rollout, and redacted launch arguments and overrides. Installation is checked through the actual launcher-created Skill link; a staged copy does not count. Failed launches retain the context record with absent/unknown installation and missing-field markers. Installed context does not by itself prove the model read it, and the fake client never pastes these texts into its rollout. Raw outputs are saved under `raw/outputs/`. Dedicated artifact capture redacts literal credentials, preserves other binary bytes and omits symlinks and `node_modules`. The launcher's Client ID remains its real `Codex:<model>:<effort>` identity; single-session write receipts establish attribution. Unsupported multiple-session and Controller-action Scenarios are refused before launch.

The report keys and compares cells by Entry, labels anomalous cells with their Entry and renders separate Entry tables. A Batch/Attempt Entry mismatch is refused, including when other records in that Batch are missing.

### Proposed onboarding Batch (not authorized or run)

After Kun approves **Codex · gpt-6-astra · xhigh · Dedicated**, run S0b and F11 twice each, ceiling four Attempts, no model reviews or arbitration in this Batch. S0b proves same-session resume and native capture; F11 adds seeded Map/receipt evidence. The model-free sandbox test supplies fixture permissions and denied-personal-context evidence, as in B02a. A behavioural failure remains a failure and does not prevent proving that the Driver records it correctly.

```sh
npm run build
node tests/behaviour/runner/run.ts --batch B02d-onboarding --entry dedicated --scenarios S0b,F11 --count 2 --ceiling 4 --model gpt-6-astra --effort xhigh
node tests/behaviour/report.ts "$HOME/Library/Application Support/Wayfinder/behaviour-runs/B02d-onboarding"
```

Use a fresh approved Batch ID and never reuse its output directory. Check all five R2 onboarding items against the native records, `batch.json` isolation hashes/path checks, `attempt.json` database/cleanup/attribution evidence and `raw/entry-context.json`. Record any missing native fields explicitly and verify that the visible model and effort match the requested Combination. Capability evidence from MCP-only does not transfer to an unverified Dedicated Entry. This small Batch does not claim a full-library baseline or release acceptance. Any model reviews need their own approved counts and ceiling.

Model-free checks, with Node 26.3.0 and a built service:

```sh
npm exec vitest run tests/behaviour/runner/dedicated.test.ts tests/behaviour/verdict.test.ts
```

These invoke the actual launcher with a synthetic login and fake Codex, exercise two turns and Map writes, cross-turn code/policy planting, login-link substitution, refreshed-token redaction, actual denied TCP connections to 18765/18766, timeout cleanup, output-directory refusal, a stopped service, failed installation and separate report cells. They spend no model quota.

## Verdicts and the report

`verdict.ts` judges one Attempt against its Scenario: a confirmed must-not (common checks included) fails it even if the run was cut short or evidence is missing; otherwise an unfinished run is `incomplete`, a required event that did not happen means the Scenario was not exercised (`incomplete`), and any item a script could not decide stays open (`insufficient-evidence`) until two independent reviews agree, an arbitration settles their disagreement, or Kun decides; an item left open for missing evidence only Kun can decide, and a record made under an older Scenario version is never re-judged by the current one. Only when every must-not and expectation group is decided does an Attempt `pass`. A cell (Scenario × Entry × Combination × release) keeps every Attempt: pass and fail together are `flaky`, a failure is never hidden by another Attempt, an undecided Attempt blocks a pass, fewer decided Attempts than the run matrix requires (two for Codex · `gpt-6-astra`, one otherwise) is `incomplete`, another Combination is due one more Attempt after an anomaly or a result unlike the main Combination's, a new Combination or model needs a two-Attempt baseline, and real-problem Scenarios report whether the failure was reproduced on their original Combination.

```sh
node tests/behaviour/cli.ts check <attempt.json>…                       # one Attempt, item by item
node tests/behaviour/report.ts <batch dir>… --json now.json --md now.md  # all cells of the given Batches
node tests/behaviour/report.ts <batch dir>… --baseline before.json      # compared with an earlier report
```

The report lists new regressions, flaky cells, uncovered or undecided cells and failing cells first, each Attempt with the items that decided it, their evidence locations and its raw directory, then every cell. A cell is compared with the baseline only for the same Scenario version, visible model and numbering series; otherwise it says why it is not directly comparable, and the old results stay in their own report. Upgrade checks carry script items too and are judged the same way (`asScenario` in `upgrade-checks.ts`): the expected recovery follows the Resource support recorded for the client, reading the rules and rereading the Map before writing again when it can, stopping and asking for a refresh when it cannot; an outage or a missing result is never read as the client's choice.

## Reviewing recorded Attempts

```sh
# Plan only: no client or generation. Keep evidence and report outputs in the private run directory.
runs="$HOME/Library/Application Support/Wayfinder/behaviour-runs"
node tests/behaviour/review-run.ts "$runs/B/S12-1" "$runs/B/S12-2"

# Optional zero-generation preflight: native subscription authentication inside the same isolation boundary.
node tests/behaviour/review-run.ts --check-login

# Only after Kun approves this review Batch and its generation ceiling:
node tests/behaviour/review-run.ts "$runs/B/S12-1" "$runs/B/S12-2" --execute --batch REVIEW-B1 --call-ceiling 10
node tests/behaviour/report.ts "$runs/B" --json "$runs/reviewed.json" --md "$runs/reviewed.md"
```

For each Attempt with reviewable items, budget **4–5 CLI generations**: two small availability probes (one per exact model), two independent reviews carrying all the Attempt's evidence, and at most one arbitration covering disputed items. N Attempts need a ceiling of **5N**; no reviewable items cost zero. Probes spend quota; `--check-login` does not. There are no automatic generation retries or model fallbacks. Exit 1 means pending review/human input or failed authentication; exit 2 means usage/execution error. A decided behavioural failure is a completed review, not a command failure.

An ordinary command refuses unchanged evidence that already has a review round. A separately approved `--retry` can reread only unfinished items that need valid readings or arbitration. It never rereads a completed decision or an item left for the human by undecided arbitration. Every prior claim remains in the aggregate verdict, including a rejected output that claimed a violation. Two valid readings are required before arbitration; rejected outputs are preserved with their original status and a rejection reason, but do not count. A later agreeing pair cannot erase an earlier violation claim, and arbitration must address all claims across rounds. Confirmed violations remain failures. Only a human decision can clear the human boundary.

Claude under test uses `gpt-6.1-sol` twice and `gpt-6-astra` for arbitration; all other clients use `claude-sonnet-5-5` twice and `claude-opus-5-5` for arbitration. Claude model names in another harness also select the OpenAI reviewers. Review 2 sees the same complete evidence as review 1, without any earlier answer; arbitration receives the full evidence and all prior readings for each disputed item. The Driver never replays completions. Native IDs, including probes and rejected outputs, are persisted across rounds (even when evidence changes); neither explicit replay markers nor a repeated native ID count as another reading. Provider token-prefix caching is not a completion replay.

The input includes the Scenario's target, item criteria, required-event script results, every normalized session/turn/event, Map history, receipts, missing markers and rule surfaces actually recorded. It does not read raw paths named by the Attempt. Each decided item needs a reason, existing locators, and `support` entries with exact quotations and item-specific explanations. The final reply is valid quoted content for deciding what the agent said, for both `holds` and `violated`; it must also have independently quoted, relevant corroboration for the same recorded session and turn. That can be a concrete non-final agent event, a receipt matched to a recorded call/result, or a Revision matched to such a receipt. Every supplied support is validated, so quoting the reply while merely listing a receipt does not suffice. A user question or turn input is citable context, but cannot supply the independent corroboration. Dangling receipts, unsupported quotations and evidence from another turn are rejected. The validator checks provenance, quotations and turn association; semantic relevance and the conclusion remain the responsibility of both reviewers and the arbiter.

For a reply with no tool call, the packet provides `turnWrites[i][j]`, a deterministic projection of the original record for `sessions[i].turns[j]`. It covers **every Map in the complete catalog and every receipt**, including agent-created Maps and an empty catalog. A usable record lists no committed receipts in that session/turn and equal before/after heads for every Map. Heads are reconstructed from the seed and Revisions placed by receipts at Scenario-wide turn indices; a Map created in a later turn has `null` on both sides of the earlier boundary, while an earlier creation can have equal non-null heads in a later quiet turn. A creation or update in the reply's turn makes that no-write record unavailable, even if a different seed Map stayed unchanged.

The projection requires complete catalog/history/receipt/session records, known receipt outcomes, write-call/receipt matches, and a consistent Revision chain with every agent write placed by a receipt and its author Client ID. Gaps, orphaned or duplicate commits, unplaced Revisions and post-seed Controller changes with unknown turn boundaries withhold the proof. Multiple sessions additionally need recorded non-overlapping turn boundaries in Scenario order; timestamps never assign a write to a session or replace a receipt. These checks apply to both `holds` and `violated`. Other missing required fields still block `holds` as before.

Only usable no-write locations appear in `evidenceLocations`; null `turnWrites` entries cannot be cited. Quote the **entire generated statement**, including session/turn, empty committed receipts and all before/after heads, and explain its relevance to the item. A decorative fragment such as `{` does not qualify. The input artifact saves this projection with the complete underlying Attempt, and the verdict independently recomputes it. The old whole-single-Map `maps[i].history` shortcut is no longer a no-write source; individual receipt-backed Revision citations remain available. This supports S12/S0 with empty catalogs, S0b's proposal before a later-turn creation, and F11 only when no Map was changed in the reply's turn. A reply alone or paired only with the human's question remains insufficient for either conclusion.

Missing evidence is checked per item by `missingForReview` and included in its prompt:

- Every behavioural item, including script escalations, conservatively requires the full rule and action trace. Unknown missing markers block `holds`. Explicit missing instructions/tool definitions and unknown rule fields also block it; instructions are legitimately absent in `toolsOnly` mode. Unknown tool results, null command exit codes, unknown receipts and unassigned agent Revisions block `holds` even without a missing marker.
- `status-narration` requires recorded messages, user inputs and supplied rules (to identify unrequested rule quotations). Missing Map/receipt/action-result details do not affect that count. Unknown markers still block `holds`.
- Usage, client version/surface and reasoning-effort metadata do not establish any item's behaviour, so their absence does not block it. Missing model identity is not exempt.

Missing evidence cannot establish `holds`, including in arbitration, but does not erase an evidenced violation. Thus the missing `given[0].instructions` and `given[0].toolDescriptions` in the historical B2 S0b-1/F11-1 records cannot turn into passing model verdicts. Script-proven results remain authoritative, script items explicitly escalated to the model join the review, and human/paused items stay outside it. Quality observations cannot fail a Scenario alone.

Inputs, native outputs, invocation arguments (including system prompt and sandbox policy), rejected/validated readings, arbitration reasons and `review-plan.json` are private immutable files under `<attempt>/model-reviews/<round UUID>/`. The approval and complete plan are written **before the first probe**. The command atomically appends a summary to `attempt.json`, preserves Driver fields and takes an exclusive lock. A hard-killed command may leave a lock or an unattached round; inspect and reconcile its private evidence before another invocation. Unattached rounds block new calls so their native IDs cannot disappear on a retry. The evidence hash excludes only review summaries: edited evidence makes old readings inapplicable, without deleting them. `judgeAttempt`, `cli.ts check` and `report.ts` use the same cross-round decision rule. Reportable model reasons redact local paths; full diagnostics remain in the private artifacts.

### CLI isolation and availability

The macOS Driver uses locally signed-in subscription CLIs. The controller never opens/copies credential contents or accepts API keys. Children receive only PATH, HOME, TMPDIR, LANG, USER/LOGNAME and already-exported proxy variables; no API keys, tokens, NODE_OPTIONS or CLI overrides are inherited. Local `auth status` / `login status` checks subscription authentication without a generation. Approved availability probes then check access to the two exact configured models; failure stops the Attempt without substitution.

Both CLIs run under the same outer `sandbox-exec` policy in a fresh empty working directory. The policy hides personal home, the repository, unrelated temporary files, resolved workspace symlinks and known managed-configuration locations; cached preferences through cfprefsd are blocked too. It denies workspace/file writes outside the disposable runtime and native authentication refresh exception, and blocks localhost outbound connections, including ports 18765/18766. Only the runtime, CLI/Node installations and the native authentication resources below are opened inside those blocked paths. No daily settings are changed; scratch is removed after each invocation. The review boundary intentionally differs from the behaviour runner, which must permit fixture writes and MCP calls.

- **Claude Code:** retain HOME for native keychain authentication but set a fresh empty `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=''` (the launcher's shared daily keychain route), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `DISABLE_AUTOUPDATER=1`. The sandbox grants read access only to the login keychain file, not the rest of the home; no keychain entry is copied. Use `--safe-mode --restricted --setting-sources user`, explicit hooks/memory-off settings, `--tools ''`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--disable-slash-commands --no-chrome --no-session-persistence --permission-prompts none --system-prompt-snapshot off` and an explicit system prompt. Native output exposing tools/MCP or tool use fails closed. `--bare` is not used because it skips keychain authentication.
- **Codex:** fresh HOME and working directory, `--no-daemon exec --strict-config --json --ignore-user-config --ignore-rules --ephemeral --sandbox read-only`, approval `never`, `project_doc_max_bytes=0`, `skip_host_skill_discovery`, web search off and feature disables for apps, plugins, hooks, memories, commands, agents, browser/computer/image tools. State/log directories point to runtime. Generation retains the native daily CODEX_HOME but the sandbox exposes only its authentication file and narrowly named refresh temporary files; configuration/history remain unreadable. Refresh writes land in that same shared store, never in a discarded copy. The read-only `login status` command has a fresh empty config directory with an auth symlink and `--no-daemon`; this CLI does not accept the exec-only strict/ignore-config flags there. The JSON parser rejects tool activity, failed turns and unsupported event types.

Claude records the provider message ID separately from the session ID and accepts only the exact requested model or its dated snapshot. Codex records a native response ID when exposed, otherwise its native thread plus final message-item ID. When the Codex JSON stream does not name the served model, `modelEvidence: requested-only` explicitly records that limitation: the request/access probe cannot prove absence of a server-side reroute. Streams without explicit completion-replay metadata are labelled `cacheEvidence: not-reported`; the controller still makes two fresh calls and rejects reused IDs. A native stream is not a claim that an unreported provider replay can be detected.

On 2026-10-26, CLI help was checked for Claude Code 2.1.310 and Codex 0.164.0. Both **isolated native subscription status checks passed**, without generations. Tests launch an actual fake Claude process through the Driver and sandbox: working-directory writes, private fixture reads and a connect to 127.0.0.1:18766 fail with EPERM; empty configuration and memory-off environment are checked inside that process. Another sandboxed process updates a synthetic shared login file, survives scratch cleanup and cannot read/write adjacent settings. These are operating-system tests, not flag-name assertions. Real token refresh and model availability remain untested until the approved Batch; failures are recorded without broader permissions or model fallback. Managed-source locations follow the [Claude settings documentation](https://code.claude.com/docs/en/settings); CLI configuration references are [Claude](https://code.claude.com/docs/en/cli-reference) and [Codex](https://developers.openai.com/codex/config-reference).

`review.test.ts` uses synthetic Attempt evidence and fake Drivers for agreement, arbitration, the human boundary, unavailable models, replay IDs/cache markers, invalid citations, missing dependencies, explicit retry, approval provenance, persistence and reports. No test generates model output. Issue #70's quota-bearing acceptance still needs an approved fixed-evidence Batch with an actual disagreement; do not rerun decided evidence to manufacture one.
