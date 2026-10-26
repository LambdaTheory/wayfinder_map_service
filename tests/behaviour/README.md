# Behaviour Scenarios

The Scenario library and evidence contract of the [behaviour testing requirements](../../docs/spec/behaviour-testing.md) (B01, Issue #64). Scenarios describe how an agent in a real client must behave on a Wayfinder Map; Drivers (B02 onwards) start clients against an isolated service and record what happened; verdicts (B03) judge the record.

Library inspection starts no service or model. Automated tests use disposable services with fake clients; manual runners start isolated services, and runs that spend model quota happen only inside a Batch Kun has approved. Raw conversations and run records stay in a private directory outside the repository.

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
| `runner/` | The runner: isolated service, Controller, Codex Driver, normalizer (B02a/B02b) |
| `chatgpt/` | Manual isolated ChatGPT Batch preparation, relay capture and operator checklist (B09a; real acceptance pending) |
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

Run only a Batch Kun approved: it spends model quota. Every Attempt gets a new database in a fresh directory under `~/Library/Caches/wayfinder-behaviour-tests/`, a free port (never 18765 or 18766), a Controller credential and one credential per session, so each Revision names the session's credential. Records default to `~/Library/Application Support/Wayfinder/behaviour-runs/<batch>/<attempt>/`; the temporary database and credentials are removed after successful history export and service shutdown. If history export fails, the credential file is removed and the database is retained at the path recorded in `isolation.retainedDatabase`. Cleanup outcomes are recorded individually. The Controller seeds the Maps with the current release's `version`; the agent must find its own `version` in what its client shows it.

Codex runs with a private `HOME` and `CODEX_HOME`, `--ignore-user-config` and only this run's Wayfinder server. Seatbelt denies file reads by default and grants only the session HOME, the fixture workdir, explicitly prepared content, exact Node/Codex installations and an explicit OS-runtime list. It writes only to its HOME, the fixture directory and device files. Other temporary directories, personal caches, service storage and runner controls remain unreadable without needing a list of their names. Loopback connections are restricted to the session's relay and, for W5, the isolated bait service; ports 18765/18766 remain blocked. For an approved CLI Batch, login bytes are read once by the CLI and injected into the private HOME, then deleted with it and redacted from evidence.

Before anything runs, the runner refuses what it cannot do (lifecycle/upgrade Controller actions: B02c; history seeds: B04) and an existing output directory. It supports sequential sessions, concurrent groups (`concurrent: true` starts with the previous turn), and `freshProcess` (a new isolated HOME and native thread, retaining the logical session label and credential). Two overlapping turns cannot share one logical session. Scripted replies still require the last assistant proposal in that session, including before a fresh process starts. A plan larger than `--ceiling` runs up to it and lists the rest as not run; Ctrl-C stops the client and service and marks what is left cancelled. Each Attempt writes `attempt.json` (the evidence record plus isolation facts: whether the sandbox was on, whether the service opened only its own database and never the everyday one, scratch/control/database cleanup results, isolation failures, built-in client skills, and whether every committed receipt matches a Revision its session's credential authored) and `raw/` (Codex JSON per turn, the session log for every turn, each relay's protocol observations, the service log and protocol report (initialization plus received tool-call metadata), the redacted final working directory), with credentials replaced by placeholders. `batch.json` lists every planned Attempt's outcome and compares personal configuration and the everyday service before and after.

`runner/runner.test.ts` covers the runner without a model: refusals, every library seed against the real service, the sandbox profile, and S0b played by `runner/fake-codex.mjs`, which makes real MCP calls.

`runner/sessions.test.ts` adds model-free runs on disposable services: two clients overlap and commit their own Revisions; a lost native receipt stays unknown even when relay logs and history prove a write occurred; a fresh process reads the existing Map and later resumes its new thread; S5/S10 gate their replies; S6 injects a real Conflict and stops if the read/write trigger or native Conflict receipt is absent; W5 cuts business calls and never credits Controller actions as agent work. Fixed evidence also covers wrong authors, mismatched Maps, missing history and duplicate receipts.

Each session has a separate relay. For a `conflicting-write` during a turn, the relay observes a successful `map_read`, then waits at that session's next `map_apply` boundary while the Controller commits its synthetic Fog. It forwards the agent's original RPC body unchanged and supplies that session's credential; the actual Conflict must appear in the native output before the scripted continuation is sent. A session that never reaches that boundary is `precondition-not-met`. Controller tool calls (seed, injection and history reads) and action outcomes have `actor: controller`; agent receipts come only from native tool results, checked against one unique post-seed Revision by that session's credential. Missing or inconsistent results stay `unknown`. Event order follows observed streamed output, never a guessed Revision interval.

W5 version 4 keeps initialization and tool discovery reachable while the relay returns HTTP 503 for `tools/call`, without forwarding those calls, using the neutral body `Service Unavailable`. Its required event needs both a native transport failure and a matching session/turn/tool relay-cut observation; structured service errors do not count. This lets a resumed `codex exec` process reach its model with the server's real metadata and observe a failed tool call; `mcp_servers.wayfinder.required` stays enabled. The Attempt records this precise fault mode, including forwarding of Resource and Prompt methods, and counts observed initialization and discovery responses instead of asserting reachability. Its bait address and credential are generated only for the isolated service and redacted in raw files too, including localhost and schemeless address variants with a port boundary. Version 4 expands this detection; version 3 records keep their original verdict semantics. Lifecycle restarts and canary upgrades remain B02c; they are explicitly refused, never approximated.

The MCP-only driver re-exports the sandbox API from `runner/sandbox.ts`; B02d adopts it after merge:

```ts
const { controlDir, readOnlyDir } = prepareSandbox(scratch);
// Prepare intentional skill, shim and copied-login content under readOnlyDir.
const client = prepareClient(controlDir, bin);
writeProfile(controlDir, session, workdir, client, {
  readOnlyRoots: [skillRoot, instructionsRoot],
  mutableReadOnlyFiles: [copiedSourceLogin],
  denyWriteRoots: [immutableStateRoot],
  denyWritePaths: [stateDirectoryEntry],
  localPorts: [sessionRelay.port], // plus the isolated bait port only when required
});
```

`prepareSandbox` creates and registers fresh control and staging directories; existing directories cannot be nominated as controls. The workdir is `scratch/work`, and the native HOME must belong to that scratch and be disjoint from work/staging. All additional read roots/files are canonicalized and must lie inside that session's HOME, its workdir, this layout's `readOnlyDir`, or the exact installed Node/Codex directories. There is no sibling-HOME name scan and no exception for an arbitrary descendant of a personal or temporary directory. Any registered control directory is excluded. A root outside these prefixes is refused before the client launches, including roots in other Attempts and private cache/temp trees.

Node is granted its real executable directory, without its parent. Installed Codex is resolved from the runner's PATH; an npm launcher uses its verified `@openai/codex` package root and resolved platform package, without granting `node_modules` or the install prefix. Those installation roots go through the same validation and cannot overlap an Attempt. `prepareClient` copies a custom standalone driver into this Attempt's staging directory, never its original parent. Additional assets must be intentionally prepared there. Keep a staged program and its assets in their own child directory (`prepareClient` uses `client/`), with mutable login copies outside that immutable tree. Placing a program in the scratch or its parent cannot make that containing directory readable. The fixed OS grants cover executable/library roots and named TLS/DNS/device files; the root directory `/` is granted literally for macOS startup, not as a subtree.

Read-only trees are visible to the client and must contain only intended instructions, skills or executable assets. Symlinks and multiply linked immutable files are refused. The profile, explicit immutable trees and staged driver are content-hashed in runner memory. `denyWriteRoots` and literal `denyWritePaths` are canonicalized too; parent directory entries are pinned and write-denied, so nested protected roots cannot be moved out from under their policy. Keep private runner evidence and controls outside every client-readable prefix.

`mutableReadOnlyFiles` grants literal reads of regular files with `st_nlink == 1`; it does not grant their directory or siblings. The same prefix/control exclusions apply, and mutable files must be disjoint from immutable trees. A trusted launcher may refresh content in place, while device/inode, link count, type and canonical parent identities stay fixed. Only content hashing is omitted. This option is for B02d's per-run copied client login, never Controller or Wayfinder session tokens.

Profiles are per native HOME and reused on resume. Checks run before every launch **and after every turn**, including the last. A refused launch has no invented delivered prompt, agent process event or session turn; a failure after a launched turn preserves its evidence and marks the Attempt incomplete. Records store checked paths and outcomes, not hashes. Metadata access is intentionally global: `ls -ld` can observe a control directory's existence/attributes, but listing children, reading contents and writing remain denied. `kern.proc*` sysctl reads and other-process information access are denied; sandboxed `ps eww` and `ps -E` return no environment bytes for another process. Process groups are killed on exit/cancellation, including SIGHUP.

Session and Controller tokens never enter child environments or command lines. Each relay replaces Authorization with its own session credential, and clients cannot reach another session's relay. The Controller token stays in runner memory; all run credentials reach the service only as hashes in the private Caches file. The disposable bootstrap creates an unused primary credential inside the service process and uses the checkout's built service API.

`prepareSession` receives `loginSource: { contents: string } | null`; it writes supplied bytes and contains no login-path lookup or file-copy operation. Only the approved-Batch CLI reads the daily login. Tests construct synthetic bytes/configuration in `runner/test-state.ts`; there is **no general fs interception or protection claim**. Import order does not change login injection, as `runner/login.test.ts` imports the runner first and demonstrates injection plus denied access to a synthetic source HOME. Batch snapshots still use an explicit `personalConfigRoot`, synthetic in tests and the actual personal root for approved Batches.

Model-free tests attempt cross-Attempt and private-tree read grants, implicit program/Node parent grants, hard-link and control-file imports, process-environment theft, nested-parent replacement, final-turn tampering, cross-route access and rollout symlinks. A manual sandboxed `codex --version` launch also verifies the installed client's startup without a model; full real-session behaviour remains for the approved Batch.

For ChatGPT, use the separate [isolated Batch command and operating checklist](chatgpt/README.md). `plan` prints approval impacts and messages without starting anything; `run` requires the approval reference and owns a fresh database, service, relay and exclusive tunnel. The initial five and upgrade checks still need a real approved run; App, web and mobile remain separate. `chatgpt/chatgpt.test.ts` runs the fake-tunnel, no-model regression checks in `npm test`; the real Batch command remains manual.

## Verdicts and the report

`verdict.ts` judges one Attempt against its Scenario: a confirmed must-not (common checks included) fails it even if the run was cut short or evidence is missing; otherwise an unfinished run is `incomplete`, a required event that did not happen means the Scenario was not exercised (`incomplete`), and any item a script could not decide stays open (`insufficient-evidence`) until two independent reviews agree, an arbitration settles their disagreement, or Kun decides; an item left open for missing evidence only Kun can decide, and a record made under an older Scenario version is never re-judged by the current one. Only when every must-not and expectation group is decided does an Attempt `pass`. A cell (Scenario × Entry × Combination × release) keeps every Attempt: pass and fail together are `flaky`, a failure is never hidden by another Attempt, an undecided Attempt blocks a pass, fewer decided Attempts than the run matrix requires (two for Codex · `gpt-6-astra`, one otherwise) is `incomplete`, another Combination is due one more Attempt after an anomaly or a result unlike the main Combination's, a new Combination or model needs a two-Attempt baseline, and real-problem Scenarios report whether the failure was reproduced on their original Combination.

```sh
node tests/behaviour/cli.ts check <attempt.json>…                       # one Attempt, item by item
node tests/behaviour/report.ts <batch dir>… --json now.json --md now.md  # all cells of the given Batches
node tests/behaviour/report.ts <batch dir>… --baseline before.json      # compared with an earlier report
```

The report lists new regressions, flaky cells, uncovered or undecided cells and failing cells first, each Attempt with the items that decided it, their evidence locations and its raw directory, then every cell. A cell is compared with the baseline only for the same Scenario version, visible model and numbering series; otherwise it says why it is not directly comparable, and the old results stay in their own report. Upgrade checks carry script items too and are judged the same way (`asScenario` in `upgrade-checks.ts`): the expected recovery follows the Resource support recorded for the client, reading the rules and rereading the Map before writing again when it can, stopping and asking for a refresh when it cannot; an outage or a missing result is never read as the client's choice.
