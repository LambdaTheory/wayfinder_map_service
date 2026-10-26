# Isolated ChatGPT Batches

Manual B09a command for Issue #80. It prepares the same Scenario library for an operator who drives ChatGPT after Kun approves the Batch. It does not operate the app, send prompts, invoke a model review or give human verdicts. The real initial five, upgrade checks and human acceptance are still pending.

Use Node 26.3.0 and build this checkout first. The manual command is separate from `npm test`; its fake-tunnel regression tests run in that gate:

```sh
npm run build
node tests/behaviour/chatgpt/run.ts plan --model '<visible model to select>' --surface app
```

`plan` prints the approval impacts and an ordered checklist generated from the selected Scenarios, including each exact message, reply precondition and evidence item. It does not read local tunnel configuration or start a service. The defaults are S0b, S1, S5, S9 and F11, once each. Use `--scenarios` and `--count` for an explicitly approved selection. Unsupported fixtures, history, concurrent sessions and Controller actions are rejected before startup; a Scenario is never silently omitted. ChatGPT onboarding remains unverified until the real run proves its entry and evidence.

## Approval and startup

Present `plan` to Kun before requesting approval. Name the actual model, surface, Scenarios, repetitions, any separately approved reviews and the run ceiling. State that the operator occupies the ChatGPT window; Kun may take over the interface at any time. The daily ChatGPT route and every other hostname served by `opencode` are unavailable during the Batch. The operator must inventory those non-secret ingress hostnames from the existing configuration and list them with the approval request; `plan` does not read that configuration. The daily local service remains running. A pre-existing tunnel connector must be stopped by its operator with the required approval; this command refuses to take it over or kill it.

The public endpoint has no end-user authentication. Anyone who reaches the hostname can read or mutate the test Maps during an active turn, and their calls could be misattributed to the labelled chat. Discovery remains public between turns. Keep other chats idle, investigate unexpected calls, and do not leave the endpoint unattended. Do not use real/private Map data in these test databases.

After approval, in a foreground terminal:

```sh
node tests/behaviour/chatgpt/run.ts run \
  --batch B09a-app-20261026 \
  --surface app --model '<approved model>' \
  --scenarios S0b,S1,S5,S9,F11 --count 1 --ceiling 5 \
  --approval '<reference to Kun’s approval>' \
  --hostname '<existing Wayfinder connector hostname>'
```

Use the hostname already attached to the `opencode` named tunnel, without a scheme or path. The connector endpoint remains `https://<hostname>/mcp`. This does not change DNS or connector settings. The approval reference is an audit field, not an authorization granted by the program. There is no automatic model retry or extra Attempt. The runner stops at the ceiling and retains the rest of the plan as `not-run`. Batch IDs are at most 64 characters. A release mismatch between `dist` and `package.json` refuses startup; still build immediately before the run, including same-version source changes. The recorded service version comes from its handshake; the commit identifies the checkout, not a proof that a dirty build matches HEAD.

The fresh Batch directory is under `~/Library/Caches/wayfinder-behaviour-tests/`. Each Attempt gets its own SQLite database, random tokens, free service and relay ports (excluding 18765 and 18766), and output directory. Existing directories are refused. `.env.local`, `WAYFINDER_DATABASE_PATH`, `WAYFINDER_PORT` and `WAYFINDER_ATTACH_TOKEN` are not used. Controller seeds preserve the Scenario’s Claim conversions and use the current release. Agent writes receive no injected version: ChatGPT gets a `toolsOnly` credential and must use its write tool parameter description.

Each run records database creation and `lsof` observations of its own process: opened SQLite paths, listener ports and absence of connections to daily ports. It measures the 18766 listener PIDs before and after without connecting to that service. Unavailable inventories stay unknown. These are observations at the recorded checkpoints, not a continuous audit or access to the real database. Preserve `raw/isolation.json`, `raw/database-creation.json` and the Batch isolation fields with the evidence.

## Exclusive tunnel ownership

The command reads only the `tunnel` UUID and absolute `credentials-file` path from `~/.cloudflared/config.yml` (`--config` selects another configuration). It supports plain or quoted scalar values for those keys and fails on unsupported syntax. It never opens or copies the credential file. Only `cloudflared` reads that file and its normal account certificate.

1. Acquire an exclusive directory lock under the test cache. A stale lock is not stolen automatically.
2. Refuse another local `cloudflared tunnel … run` process or daily `scripts/local-chatgpt-test.mjs` runner. This is intentionally conservative about unrelated local tunnels. Process command lines are inspected in memory and never printed or saved. A launchd/Homebrew service may have different arguments; the remote inventory is the authoritative guard against those connectors.
3. Ask `cloudflared tunnel info --output json <UUID>` for the remote state. Require the name `opencode` and no connected or reconnecting connector. Unknown state refuses startup.
4. Generate a private temporary YAML `tunnel.yml` in the Batch directory, retaining only the UUID and credential **path**, and routing the supplied hostname to this Attempt’s relay. The last ingress rule returns 404. The original config is never modified.
5. Launch that config without detaching it, wait for a generated connector ID and registered connection, then require remote ownership by exactly that connector. Registered clients with zero active connections still count as occupied. Allow up to five seconds for an empty post-registration inventory to show this connector; foreign or malformed state fails immediately. Recheck before each turn, every forwarded request and every second. Loss of ownership or inability to verify it disables forwarding, records a Controller failure and aborts the Batch.
6. On normal exit, SIGINT, SIGTERM, SIGHUP, stdin EOF, startup failure, uncaught exception or unhandled rejection, stop only this connector, relay and service, remove temporary Wayfinder credentials/config/lock, and keep the evidence/database. The connector gets ten seconds to stop before forced termination; its remote deregistration is checked for up to five seconds before advancing. A synchronous process-exit fallback terminates the owned child and removes config/lock. It cannot flush a complete report. No daily connector is restarted implicitly.

The local lock coordinates copies of this command; existing daily launchers and a connector on another machine do not honor it. Operators must not start another connector during a Batch. Checks detect a competing connector and fail closed; there is no distributed atomic lock against an independently started Cloudflare connector, nor a way to prevent traffic going to it before detection. After SIGKILL or power loss, startup refuses a remaining lock or registered connector. Inspect the indicated `owner.json` (owner PID, connector PID, run and temporary config), verify process identity, stop only a confirmed orphan under the coordinator’s approval, and remove its stale config/lock only after it is gone. Confirm remote `tunnel info` has no registered connector before retrying. Never kill by a stale PID alone or stop another owner’s process.

Before the first approved real run, confirm that the original config uses a UUID and absolute credentials path (a tunnel name is deliberately refused). Have `cloudflared` validate the generated YAML, then verify real registration/`info` shape and tool refresh. None of these real-binary or client checks is claimed by the fake tests. The TypeScript process must not open the credential file.

The CLI and connector-record shape are defined by Cloudflare’s [tunnel command](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/subcommands.go), [Info JSON](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/info.go) and [active client JSON](https://github.com/cloudflare/cloudflared/blob/master/cfapi/tunnel.go).

## Operating an Attempt

Read the generated `checklist.md` after the readiness line. Only the labelled chat may use this connector during a turn; close or leave other Wayfinder chats idle. Refresh tools and open a new chat in Chat mode, outside projects. Do not inject Skills, repository files, the checklist or expected outcomes into the chat. The following commands go to the **runner terminal**, not ChatGPT:

```text
did refresh-tools
did new-chat
did plugin-mentioned
begin
```

Send the printed Scenario message with the Wayfinder plugin mentioned. Capture the complete native assistant messages and all relevant intermediate content. The relay records actual requests/results in `raw/wire.json`; it never fabricates tool calls from prose. The local Map viewer is not forwarded. Calls outside a labelled turn are refused except initialization, ping, tool/Resource/Prompt listing and session deletion. Verify Refresh tools in the real client before continuing; a supported discovery request does not establish client support for Resource reading.

Write a UTF-8 JSON capture in this Attempt’s private `raw/` directory, then run `end /absolute/path/capture.json`:

```json
{
  "messagesComplete": true,
  "otherToolsComplete": true,
  "messages": [
    { "text": "<verbatim native assistant message>", "afterCall": "rpc-4" }
  ],
  "nativeId": "<native chat ID or URL>",
  "clientVersion": "<observed client version>",
  "visibleModel": "<model visible in the UI>",
  "resources": "unavailable",
  "prompts": "undocumented"
}
```

Replace every example value with real evidence; omit fields the UI does not expose. `afterCall` is the corresponding `id` in `wire.json`, or `null` for a message before the first call (including a turn with no calls). Preserve message order within each position. If any message is missing, use `messagesComplete: false`. Do not label a screenshot or summary a complete transcript.

Relay evidence covers Wayfinder only. Capture other native tools, such as web search, in optional `otherToolCalls`: each entry has `callId`, `server` (not Wayfinder), `tool`, `arguments`, `result` (`{"known":true,"value":...}` or `{"known":false,"reason":"..."}`), `failed`, and `afterCall`. When this array is nonempty, give **every** native tool/message a distinct integer `order` to preserve their interleaving between relay calls. Keep the original native artifacts in `raw/`. Set `otherToolsComplete: true` only after collecting all other calls or confirming there were none; otherwise leave it false/absent and the report preserves the gap.

Optional `toolsShown` is the exact array of four tool definitions actually exposed to the model by the client, including the write tools’ `inputSchema.properties.version.description`. Keep its native source artifact. Only that snapshot fills `given.rulesSource` and `given.toolDescriptions`; both start unknown. A management-screen listing that does not establish the chat’s snapshot is insufficient. Optional `versionSourceEvidence` holds a verbatim native explanation or a reference to the native capture establishing where the agent learned the version; arbitrary nonempty text does not close a gap. Do not populate either field from `controller-tools-*.json`: those files prove only what the service offered. `given.serviceVersion` records that separate Controller observation.

`given.instructions` remains unknown, and Resource capability is `unavailable` as in the ChatGPT profile. The report derives each phase’s actual compatibility mode and visibility from the Attempt; a not-run Attempt has unknown mode. Matching write versions and canary Ticket titles alone cannot satisfy the upgrade checks when the client source/tool definitions are missing. Missing client visibility, model or version stays an acceptance gap even if other Scenario checks pass.

For a scripted reply, inspect the actual proposal and confirm that it is the one the Scenario answers. Then enter `did plugin-mentioned`, `begin confirmed`, send the printed line, and capture the result. The runner also checks the Scenario’s cue; that cue alone is not sufficient. If the proposal did not appear, use `stop precondition-not-met` without sending the reply. Do not add answers to a human question outside the Scenario: Kun gives those verdicts. Run `next` after all turns to preserve the Attempt and start the next isolated database. A premature `next` records cancellation, never completion. `stop`, EOF or Ctrl-C ends the Batch; future items remain `not-run`.

## Upgrade checks

Approve these separately from the initial five, with their own two-Attempt ceiling:

```sh
node tests/behaviour/chatgpt/run.ts plan --surface app --model '<approved model>' \
  --scenarios U-chatgpt-old-chat,U-chatgpt-new-chat --ceiling 2
```

Use the corresponding `run` command with a fresh Batch ID, approval reference and hostname. Each check starts a fresh Map at the current build. After capturing turn 0, `upgrade` copies the already built service into that Attempt’s private directory and restarts **only its own service on its same database and port**, using the existing canary helper. The canary changes a tool rule as well as the release; the new Ticket title rule is tested by the shared verdicts. The version and rule are never put into the user message.

- **Old chat:** refresh tools, record `did refresh-tools`, retain the original chat, mention the plugin and send turn 1. Capture the refused write, no new Revision and the agent’s request to refresh/start a new chat. Do not supply a version or retry for it.
- **New chat:** after `upgrade`, refresh tools, open a new chat, and record both actions. Mention the plugin and send turn 1 in session B. Capture the client definitions, new-version write, canary rule, receipt and exactly one committed change. The B credential distinguishes it from session A.

The old and new checks remain separate Attempts. Client observations go into their native captures; Controller restart/refresh/new-chat actions are separate events. If the operator stopped the daily runner, the coordinator restores `wayfinder chatgpt` under approval after this Batch stops, refreshes tools back to the normal snapshot, and records both actions with the Batch evidence. No real upgrade or ChatGPT evidence is claimed by the fake verification. Upgrade-check version 2 requires native rule visibility; version 1 records are retained and are not silently re-judged.

## Reporting and verification

`attempt.json` uses the shared evidence contract; `batch.json` keeps every planned Attempt, and `report.json`/`report.md` use `report.ts` and `verdict.ts`. The Combination includes `app`, `web` or `mobile`, so reports cannot merge those surfaces. Other surfaces are listed as untested. Controller seeds/evidence reads are separate from agent calls; call receipts plus the per-session credential connect agent writes to Revision history. Unknown results stay unknown. Native visibility and final acceptance remain explicit gates above the Scenario verdicts.

Approved review records can be passed to the shared report workflow. A model item is not decided by this command; reviewers and Kun use the same verdict items. The command does not finish the cross-client human journey (B09c), or certify ChatGPT onboarding merely because a fake run passed. S6 is applicable to ChatGPT but its multi-session Controller actions are not supported by this driver yet; it remains an explicit coverage gap.

The cache is the runtime location, not durable storage: macOS can purge it. Before presenting acceptance evidence, the coordinator must archive the stopped Batch’s records and native/raw artifacts to the approved durable evidence location (for example `~/Library/Application Support/Wayfinder/behaviour-runs/`) and record that path. Databases remain in the isolated cache. This command deliberately does not choose or write a second evidence destination automatically.

No-model verification, with a checked-in fake `cloudflared` and temporary real local services:

```sh
npm run build
npx vitest run tests/behaviour/chatgpt/chatgpt.test.ts
# The same no-model cases also run in npm test.
```

The fake CLI mode is `--fake-tunnel --config <fixture config under the test cache>`. It can run while the daily connector remains active: it always selects the checked-in non-networking test double, skips the real local process inventory, uses fake remote connector state and marks its reports as fake. It accepts no alternate executable. The normal command has no skip-ownership option. Fake mode must not be counted as a real ChatGPT result.
