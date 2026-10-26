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
| `runner/` | The runner: isolated service, Controller, Codex MCP-only and Dedicated Drivers, normalizer (B02a/B02d) |
| `verdict.ts`, `report.ts` | Verdicts of Attempts and cells, and the comparison report (B03a) |

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

## Codex Dedicated Entry

Select `--entry dedicated` to drive the repository's `scripts/wayfinder-agent/wayfinder` through its documented noninteractive passthrough. The default stays `--entry mcp-only`. Both Entries use the same Scenario inputs, Controller, native-output normalizer, receipts and allowlist sandbox. Dedicated Batches refuse `--no-sandbox`. Dedicated support remains **unverified** in `clients.ts` until its five onboarding checks have evidence from a Batch Kun approved; synthetic tests do not onboard it.

| Context | MCP-only | Dedicated |
| --- | --- | --- |
| Client invocation | `codex exec`, `--ignore-user-config` | Actual `wayfinder --harness codex --method mcp -- …`, including `--no-daemon` |
| Launcher instructions | None | Launcher installs its unchanged instruction template as the private `CODEX_HOME/AGENTS.md`, substituting the run's output path |
| Wayfinder Skill | None | Launcher installs the repository's MCP Skill, copied unchanged into the run's projected checkout |
| Configuration | Runner's command-line MCP configuration | Launcher's real `config.toml` template and command-line model, effort and MCP URL overrides |
| Personal context | Denied by the allowlist | Also denied; the launcher's reference to project control planes does not make personal files readable |

The Controller creates and owns the service before invoking the launcher. All launcher overrides are supplied: `WAYFINDER_AGENT_STATE_ROOT`, `WAYFINDER_AGENT_SERVICE_DIR`, `WAYFINDER_AGENT_OUTPUTS`, `WAYFINDER_AGENT_PORT`, `WAYFINDER_AGENT_DATABASE` and `WAYFINDER_AGENT_CHECKOUT`; `WAYFINDER_AGENT_USAGE=test` identifies future launcher metadata. `HOME` also points to the run's private home, so authentication linking and refresh synchronization remain confined to the copied login. No daily installation ID is imported. No new launcher overrides are needed.

The database and credentials live in a new directory under `~/Library/Caches/wayfinder-behaviour-tests/`; the private client homes, outputs, fixtures and projected checkout live in the Attempt's scratch. The projection contains only the unchanged MCP Skill, with no service build: if the owned service disappears, the launcher fails instead of starting an untracked daemon. The actual launcher still comes from this repository. A private `codex` shim records its launch credential for redaction, strips bootstrap variables, and puts the client inside the existing allowlist sandbox. The client cannot read the service directory, repository source or verdicts; ports 18765 and 18766 remain denied. The Controller closes its connection, stops only its own service, captures evidence, then removes the service directory, credentials and scratch.

Each Attempt records `entry=dedicated`, the launcher surface, the additional context in `given[].extraContext`, and `raw/entry-context.json`: source names (including Skill activation metadata), installed text, hashes, whether that text appears in the native rollout, and redacted launch arguments and overrides. Installed context does not by itself prove the model read it. Raw outputs are saved under `raw/outputs/`. Dedicated artifact capture redacts literal credentials, preserves other binary bytes and omits symlinks and `node_modules`. The launcher's Client ID remains its real `Codex:<model>:<effort>` identity; single-session write receipts establish attribution. Unsupported multiple-session and Controller-action Scenarios are refused before launch.

The report keys and compares cells by Entry, labels anomalous cells with their Entry and renders separate Entry tables. A Batch/Attempt Entry mismatch is refused, including when other records in that Batch are missing.

### Proposed onboarding Batch (not authorized or run)

After Kun approves **Codex · gpt-6-astra · xhigh · Dedicated**, run S0b and F11 twice each, ceiling four Attempts, no model reviews or arbitration in this Batch. S0b proves same-session resume and native capture; F11 adds seeded Map/receipt evidence. The model-free sandbox test supplies fixture permissions and denied-personal-context evidence, as in B02a. A behavioural failure remains a failure and does not prevent proving that the Driver records it correctly.

```sh
npm run build
node tests/behaviour/runner/run.ts --batch B02d-onboarding --entry dedicated --scenarios S0b,F11 --count 2 --ceiling 4 --model gpt-6-astra --effort xhigh
node tests/behaviour/report.ts "$HOME/Library/Application Support/Wayfinder/behaviour-runs/B02d-onboarding"
```

Use a fresh approved Batch ID and never reuse its output directory. Check all five R2 onboarding items against the native records, `batch.json` isolation hashes/path checks, `attempt.json` database/cleanup/attribution evidence and `raw/entry-context.json`. Record any missing native fields explicitly. This small Batch does not claim a full-library baseline or release acceptance. Any model reviews need their own approved counts and ceiling.

Model-free checks, with Node 26.3.0 and a built service:

```sh
npm exec vitest run tests/behaviour/runner/dedicated.test.ts tests/behaviour/verdict.test.ts
```

These invoke the actual launcher with a synthetic login and fake Codex, exercise two turns and Map writes, timeout cleanup, output-directory refusal, a stopped service, and separate report cells. They spend no model quota.

## Verdicts and the report

`verdict.ts` judges one Attempt against its Scenario: a confirmed must-not (common checks included) fails it even if the run was cut short or evidence is missing; otherwise an unfinished run is `incomplete`, a required event that did not happen means the Scenario was not exercised (`incomplete`), and any item a script could not decide stays open (`insufficient-evidence`) until two independent reviews agree, an arbitration settles their disagreement, or Kun decides; an item left open for missing evidence only Kun can decide, and a record made under an older Scenario version is never re-judged by the current one. Only when every must-not and expectation group is decided does an Attempt `pass`. A cell (Scenario × Entry × Combination × release) keeps every Attempt: pass and fail together are `flaky`, a failure is never hidden by another Attempt, an undecided Attempt blocks a pass, fewer decided Attempts than the run matrix requires (two for Codex · `gpt-6-astra`, one otherwise) is `incomplete`, another Combination is due one more Attempt after an anomaly or a result unlike the main Combination's, a new Combination or model needs a two-Attempt baseline, and real-problem Scenarios report whether the failure was reproduced on their original Combination.

```sh
node tests/behaviour/cli.ts check <attempt.json>…                       # one Attempt, item by item
node tests/behaviour/report.ts <batch dir>… --json now.json --md now.md  # all cells of the given Batches
node tests/behaviour/report.ts <batch dir>… --baseline before.json      # compared with an earlier report
```

The report lists new regressions, flaky cells, uncovered or undecided cells and failing cells first, each Attempt with the items that decided it, their evidence locations and its raw directory, then every cell. A cell is compared with the baseline only for the same Scenario version, visible model and numbering series; otherwise it says why it is not directly comparable, and the old results stay in their own report. Upgrade checks carry script items too and are judged the same way (`asScenario` in `upgrade-checks.ts`): the expected recovery follows the Resource support recorded for the client, reading the rules and rereading the Map before writing again when it can, stopping and asking for a refresh when it cannot; an outage or a missing result is never read as the client's choice.
