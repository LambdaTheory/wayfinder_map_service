# Interactive acceptance (B09b, Issue #81)

This manual tool checks the four R9 capabilities in interactive **Codex CLI** and **Claude Code CLI** separately. It does not run a model. The operator starts an interactive client only after Kun approves the Batch. Fixed fixtures test the tooling; they prove no real client capability.

`host.ts` reuses B02a's service, Controller and macOS allowlist sandbox without editing the scripted runner. `cli.ts` imports an explicitly named native file into `evidence.ts`'s AttemptRecord and calls `verdict.ts` for each capability. `scenario.ts`, the W1/W7 scripted verdicts and their versions are unchanged. The assessment pins `verdictVersion`; a mismatched version is never re-judged. Interactive variants have their own IDs/version 1: B09Async, B09Prepare, B09Adjust and B09Continue. Their verdicts cover these capabilities only, not all W1/W7 assertions or the human journey.

## Confirm support before collecting acceptance evidence

The scripted `clients.ts` table does not describe an interactive surface. Its `async-questions: false` and unverified delegation values remain unchanged: no real interactive Batch has run. Never promote them from these synthetic tests or from another interface's documentation.

For each exact client binary/version, model, effort, mode and flags:

1. Read the current official [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Codex app-server reference](https://developers.openai.com/codex/app-server/), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Claude hooks reference](https://code.claude.com/docs/en/hooks). Save the URLs, observation date, version output and relevant mode/flags in the private confirmation. App-server capabilities do not prove CLI capabilities. A question tool can be blocking; a queued input or resumed process does not prove asynchronous questioning. Public documentation is a discovery source, not a support claim made by this implementation.
2. In one **approved, separate minimal probe per Combination**, using the same isolation and Entry as below, ask the client to propose a synthetic choice, ask for an answer, read a harmless fixture while the answer is pending, then change the recommendation after a contrary answer and pose the next question without a nudge. Before answering, wait for an actual completed read/result, not a fixed number of seconds. Do not install a new question tool or change the Entry to make it pass. The probe is a diagnostic, not a library Scenario or regression result.
3. Inspect the native record and exact UI behaviour. For each capability independently, record `supported`, `unsupported` or `unverified`, a reason, exact surface/version, documentation, confirmation time, and (for supported) the earlier probe's relative path, SHA-256, end time, line locations and operator reading. Unsupported requires affirmative evidence of the missing mechanism in that version/mode; a failed or absent observation remains unverified. Explain the missing coverage. A blocking question tool can leave asynchronous asking unsupported while recommendation adjustment and continuation remain testable.
4. Finish confirmation before starting acceptance capture. Preserve the probe and its reading outside the repository. Supported requires the retained probe hash; confirmation after capture or for a different version/surface remains insufficient evidence. Check model/effort availability here; stop on an unavailable approved Combination, never substitute.

The supported JSONL fixtures intentionally invent successful behaviour. The public docs do **not** promise the exact persisted JSONL schemas used here; adapters recognize a conservative subset, derived from synthetic records, with explicit boundaries. Validate the format in the probe. Unknown event types, malformed records, mixed session IDs, sidechains, compaction or missing boundaries cannot silently pass; retain the files and extend the adapter in a separate reviewed change if necessary.

## Proposed first Batch (not authorized by this document)

| Combination | Entry / surface | Diagnostic probes | W1 | W7 |
| --- | --- | ---: | ---: | ---: |
| Codex · `gpt-6-astra` · `xhigh` | MCP-only / interactive-cli | 1 | 2 | 2 |
| Claude Code · `claude-sonnet-5-5` · `high` | MCP-only / interactive-cli | 1 | 2 | 2 |

Maximum: 10 interactive sessions (2 probes + 8 Attempts), no retries or extra models. A new Combination receives two baseline Attempts per Scenario. The exact Claude model name and availability must be checked in the approved probe; the table is a proposal, not evidence of access.

Content review uses the existing R4 route: two independent Sonnet 5.5 readings for each Codex Attempt, Opus 5.5 arbitration if needed; two independent GPT-6.1-Sol readings for each Claude Attempt, Astra arbitration if needed. All four content items can share one review input. Budget up to 16 review invocations plus 8 arbitrations, total **34 model invocations** including sessions. Confirm current availability and the coordinator's review driver configuration before the Batch. No automatic model reviews run here. Unresolved evidence stays open for Kun; scripted operator answers do not replace B09c/B10 human acceptance.

## Start an isolated interactive Attempt

Use Node 26.3.0 and build first. Run every probe and Attempt with a fresh name. The host refuses an existing directory. It creates a database only under `~/Library/Caches/wayfinder-behaviour-tests/<batch>-<attempt>/`, allocates a free port excluding 18765/18766, and creates separate Controller and agent credentials. The fresh client HOME and work directory are under its own `/private/tmp` scratch, with no Skill, AGENTS.md, copied workflow, personal login or user configuration. It never launches `wayfinder`, a tunnel or the everyday service.

```sh
export PATH="$(dirname "$(npm exec --yes --package=node@26.3.0 -- node -p process.execPath)"):$PATH"
npm ci
npm run build

# After Batch approval; supply the exact absolute binary path from command -v.
node tests/behaviour/interactive/host.ts B09b-approved codex-W7-1 codex gpt-6-astra xhigh W7 /absolute/path/to/codex
node tests/behaviour/interactive/host.ts B09b-approved claude-W7-1 claude claude-sonnet-5-5 high W7 /absolute/path/to/claude
```

These are separate host invocations, one per Attempt. Keep the host terminal open. In a second terminal, invoke the private `launch.sh` path it prints, with a run credential supplied through `B09_CODEX_API_KEY` or `B09_CLAUDE_API_KEY`. Provision those credentials through the coordinator's approved credential flow; never copy normal client homes, login files, transcripts or settings. Set the same run-key variable in the host terminal so capture redacts it. Do not paste a key into a prompt, report or repository file. This first tooling supports API-key authentication; subscription/keychain onboarding remains unverified and is not silently substituted.

The launcher uses `env -i`, private HOME/CODEX_HOME/CLAUDE_CONFIG_DIR, process-local MCP configuration and `sandbox-exec`. It permits only its scratch and installed client/runtime under the home directory; it denies access to the source checkout, verdicts, other runs and ports 18765/18766. Verify the binary's documented flags during the minimal probe; an unsupported flag is a launch failure, not permission to drop isolation. Record built-in context and any managed policy separately. The host has a 60-minute ceiling and never changes global configuration.

## Operator checklist

1. Finish the four capability confirmations and retain the separate probe before starting this Attempt. Copy only that redacted probe file into the new private Attempt directory afterwards. Use the host's generated opening line for W1 or W7. Do not paste acceptance criteria, rules, the service version or this checklist into the tested client's context.
2. Observe the real questions. Answer only a proposal that appeared. For W7, give a concrete contrary constraint that changes a recommendation, e.g. require mobile-only entry when the visible proposal assumed desktop access. Record exactly what was sent. Do not send a nudge to manufacture continuation. For W1, observe whether the answer's turn proceeds to the next available question. If the proposal needed for a reply is absent, end as `precondition-not-met`.
3. While an asynchronous question is pending, wait for actual independent work; inspect its completed content. No minimum delay or speed threshold proves it happened. When asynchronous asking is unsupported, record that gap and exercise the remaining supported capabilities through their normal interaction.
4. Exit the client first. Return to the host and enter the actual outcome (`complete`, `precondition-not-met`, `launch-failed`, `timeout`, `rate-limited`, `cancelled`, `driver-failed`, `service-failed`). A failed/aborted session still gets `capture.json`; mark missing evidence, never silently discard an Attempt. On cancellation, explicitly stop the manually launched client before treating cleanup as complete. The host stops only its own service; it cannot attest another terminal's client exit.
5. Inspect `isolation.json`, the captured files and client process exit. The host exports the catalog/history, closes the Controller, stops its service and removes its scratch and temporary credential file. It retains the private database and redacted raw evidence. Native filenames are `raw/native-*.jsonl`; choose the main session by its native ID. Do not concatenate main and child logs or different sessions. Missing or unsupported native detail remains a gap.
6. Copy a fixture assessment JSON as a **shape only**, replacing every synthetic value. Remove all synthetic reviews. Select event sequence numbers for question, completed preparation, answer, revised recommendation and continuation from the imported native records. Keep semantic reviews with their actual inputs, independent outputs and provenance, using the coordinator's review tooling; no fabricated review or operator guess may stand in for that chain.
7. Import to a fresh output directory. Inspect every item and its native line mapping; retain earlier assessments. If a capability has no suitable evidence, omit its selector and keep the result unknown. Report counts of every planned Attempt, capability-specific not-applicable gaps, unfinished attempts and the remaining Batch ceiling to the coordinator.

```sh
# Paths inside the private Attempt are explicit. No home-directory discovery occurs.
node tests/behaviour/interactive/cli.ts \
  "$HOME/Library/Caches/wayfinder-behaviour-tests/B09b-approved-codex-W7-1" \
  raw/native-0.jsonl assessment.json judged-1
```

The last argument is relative to the private Attempt, or an absolute fresh child directory. The output includes the normalized B01 `attempt.json`, four capability-specific B01 records and `result.json` with verdicts, item evidence, native source locations and duration observations. Content reviews are ordinary `Review[]` records consumed by `verdict.ts`; the content items escalate to the same review chain with their evidence locations. This importer does not spend quota.

If all four capabilities are affirmatively unsupported, collect no acceptance session: supply a preflight `capture.json` with the observed client version/surface, planned Scenario, Batch identity, `complete` preflight status and explicit missing evidence, then use `-` for the native filename. Only all-unsupported confirmations permit this route; its four results are not applicable with gaps, never pass.

## What the evidence proves

- **Asynchronous asking:** the question and completed main-session work belong to the same native turn, with the work before the human answer. Blocking, queued or resumed interaction is not inferred to be asynchronous.
- **Preparing while waiting:** completed substantive work lies strictly between question and answer, and review confirms that later recommendations use it. A tool's result time, not its start time, places completed work. Work may cross a turn boundary; this capability is separate from asynchronous asking.
- **Adjusting recommendations:** the old recommendation, changed human constraint and revised recommendation are ordered and review confirms the substantive change. It can happen across turns.
- **Continuing in the same turn:** the answer and next concrete question/action share the native turn handling that answer, with no intervening human nudge. The earlier question may have ended a previous turn, as in W1.

Codex boundaries require `event_msg/task_started` and `task_complete`; messages and calls come from `response_item`, not duplicated `event_msg` text. Claude uses user/assistant transcript blocks, tool-use IDs and explicit `end_turn` or `system/turn_duration` boundaries. A missing boundary remains unknown. Tool calls retain arguments/results; write receipts reuse B02a's normalizer and require a matching Revision author. Rules observed by the Controller are stored separately and never claimed to have been shown to the model. Usage, rule exposure, process exit, file activity or delegation classes the adapter cannot reconstruct are explicitly missing; raw records remain available for follow-up.

No text-length or elapsed-time score is a verdict. A structurally plausible trace still awaits semantic review. A sub-agent launch without completed useful material cannot prove preparation. The fixtures contain no real dialogue, credentials or user logs. Run the fixed tests with:

```sh
npm run build
npx vitest run tests/behaviour/interactive/interactive.test.ts
npm test
npm run typecheck
```
