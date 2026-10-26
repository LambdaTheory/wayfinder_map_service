# Behaviour Scenarios

The Scenario library and evidence contract of the [behaviour testing requirements](../../docs/spec/behaviour-testing.md) (B01, Issue #64). Scenarios describe how an agent in a real client must behave on a Wayfinder Map; Drivers (B02 onwards) start clients against an isolated service and record what happened; verdicts (B03) judge the record.

Nothing here starts a service or a model. Runs that spend model quota happen only inside a Batch Kun has approved. Raw conversations and run records stay in a private directory outside the repository.

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
| `runner/` | The runner: isolated service, Controller, Codex Driver, normalizer (B02a) |
| `verdict.ts`, `report.ts` | Verdicts of Attempts and cells, and the comparison report (B03a) |
| `review.ts`, `reviews.ts`, `review-cli.ts`, `review-run.ts` | Other-vendor model readings, their evidence boundary, isolated CLI Driver and manual command (B03b) |

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

Run only a Batch Kun approved: it spends model quota. Every Attempt gets a new database under `~/Library/Application Support/Wayfinder/behaviour-runs/<batch>/<attempt>/`, a free port (never 18765 or 18766), a Controller credential and one credential per session, so each Revision names the session's credential. The Controller seeds the Maps with the current release's `version`; the agent must find its own `version` in what its client shows it.

Codex runs with a private `HOME` and `CODEX_HOME` under `/private/tmp`, `--ignore-user-config` and only this run's Wayfinder server, inside `sandbox-exec` with an allowlist: it reads nothing under the home directory except the Node that runs it, nothing under `/private/tmp` except its own scratch, writes only to that scratch and the system temp, and cannot connect to ports 18765 and 18766. The daily Codex login is copied into the scratch and deleted with it; its values are redacted from records like the Wayfinder tokens.

Before anything runs, the runner refuses what it cannot do (Controller actions, several or concurrent sessions, history seeds: B02b and B04) and an existing output directory. A plan larger than `--ceiling` runs up to it and lists the rest as not run; Ctrl-C stops the client and service and marks what is left cancelled. Each Attempt writes `attempt.json` (the evidence record plus isolation facts: whether the sandbox was on, whether the service opened only its own database and never the everyday one, scratch removed, built-in client skills, and whether every committed receipt matches a Revision its session's credential authored) and `raw/` (Codex JSON per turn, the session log, the service log and initialize report, the final working directory), with credentials replaced by placeholders. `batch.json` lists every planned Attempt's outcome and compares personal configuration and the everyday service before and after.

`runner/runner.test.ts` covers the runner without a model: refusals, every library seed against the real service, the sandbox profile, and one S0b Attempt played by `runner/fake-codex.mjs`, which makes real MCP calls.

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
# Plan only: no client, authentication check or generation. Pass one or more Attempt directories.
node tests/behaviour/review-run.ts /private/run/B/S12-1 /private/run/B/S12-2

# Only after Kun approves this review Batch and its ceiling:
node tests/behaviour/review-run.ts /private/run/B/S12-1 /private/run/B/S12-2 --execute --batch REVIEW-B1 --ceiling 10
node tests/behaviour/report.ts /private/run/B --json /private/run/reviewed.json --md /private/run/reviewed.md
```

For each Attempt with reviewable items, budget **4–5 CLI generations**: two small availability probes (one per exact model), two independent reviews carrying all the Attempt's evidence, and at most one arbitration covering the unresolved items. Thus N Attempts need a ceiling of **5N**; no reviewable items cost zero. Probes also spend quota. Authentication status checks spend no model quota. There are no automatic generation retries or model fallbacks; a fresh command is a separately approved round. Exit 2 means items still need a retry or human verdict; a decided behavioural failure is a valid completed review, not a command failure.

Claude under test uses `gpt-6.1-sol` twice and `gpt-6-astra` for arbitration; all other clients use `claude-sonnet-5-5` twice and `claude-opus-5-5` for arbitration. Claude model names in another harness also select the OpenAI reviewers. Native output must identify the requested model and a distinct session/response ID on every invocation. The Driver never replays completions; a cache hit or repeated native ID cannot supply the second reading. Provider token-prefix caching does not reuse a completion and is allowed. Review 2 sees the same complete evidence as review 1, with neither prior answer; arbitration receives the complete evidence and both readings for its disputed/undecided items.

The input includes the Scenario's target, item criteria, required-event script results, every normalized session/turn/event, Map history, receipts, missing markers and rule surfaces actually recorded. It does not import extra repository instructions or read raw paths named by the Attempt. Every decision must cite existing evidence locations, including a concrete event or turn; missing evidence cannot establish `holds`, even by arbitration. Script-proven results stay authoritative, script items explicitly escalated to the model join the review, and human/paused items stay outside it. Quality observations (including counts/examples for `status-narration`) appear in the report and cannot fail a Scenario alone.

Inputs, native outputs, exact invocation arguments (including the explicit system prompt/sandbox policy), validated readings, arbitration reasons and the batch plan are immutable files under `<attempt>/model-reviews/<round UUID>/`. The command appends a summary to `attempt.json` atomically, preserves Driver fields and prevents concurrent reviews with an exclusive lock. A hard-killed command may leave the lock; inspect its incomplete round before removing that lock manually. The evidence hash excludes only earlier review summaries: edited evidence makes old readings inapplicable. All rounds remain available; a later passing round cannot erase an earlier decided violation. `judgeAttempt`, `cli.ts check` and `report.ts` read saved summaries automatically. An unavailable model or rejected cache entry is marked for retry; undecided arbitration explicitly names the human as next. Review artifacts and private inputs stay with the Attempt, outside Git.

### CLI isolation and availability

The macOS Driver uses only locally signed-in subscription CLIs. It never opens/copies credentials or accepts API keys; each child receives a small environment without inherited API keys, tokens, `NODE_OPTIONS` or CLI overrides. Local `auth status` / `login status` must report the subscription login. Availability probes then verify both exact model IDs before either evidence review; a failed probe stops that Attempt without a substitute.

- **Claude Code:** fresh empty working directory; `--safe-mode`, `--restricted`, `--setting-sources ''`, explicit hooks/memory-off settings, `--tools ''`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`, and an explicit system prompt. Safe mode preserves the CLI's normal subscription authentication while suppressing personal instructions, plugins and hooks. No file or command tools are exposed. Native output exposing tools/MCP or attempting a tool is rejected. `--bare` is deliberately not used: its help says it skips keychain reads and would break that authentication route.
- **Codex:** fresh `HOME`/`CODEX_HOME` and working directory, a temporary symlink allowing only the CLI to read its existing daily login (no credential contents handled by the controller), `--no-daemon`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--sandbox read-only`, approval `never`, `project_doc_max_bytes=0`, `skip_host_skill_discovery`, web search off and explicit feature disables for apps, plugins, hooks, memory, commands, agents, browser/computer/image tools. An outer macOS sandbox hides the repository, personal home and unrelated temporary files, allows only the fresh runtime and CLI/Node installation plus the login file, denies writes outside the fresh runtime, and denies localhost network access. The model's native read-only sandbox also applies inside that boundary. No daily configuration is changed and the scratch is removed after every invocation.

Implementation inspection on 2026-10-26 used `claude --help` (2.1.310), `codex exec --help`, `codex --help` and a fresh-home `codex features list` (0.164.0); no real model was called. The exact Claude IDs are published in the [official model list](https://platform.claude.com/docs/en/models/overview); Codex flags/configuration are described in the [configuration reference](https://developers.openai.com/codex/config-reference). **Account-specific model availability and live CLI isolation remain unverified until the approved Batch.** The command records failures honestly, including changed CLI output or unavailable flags, instead of guessing a model or granting broader access.

`review.test.ts` uses synthetic Attempt evidence and a fake Driver for agreement, disagreement/arbitration, human escalation, unavailable models, duplicate/cache readings, invalid citations, missing evidence, persistence and report integration. The quota-bearing acceptance in Issue #70 still needs an approved fixed-evidence Batch that includes an actual disagreement.
