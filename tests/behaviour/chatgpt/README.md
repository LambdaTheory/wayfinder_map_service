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

Controller, historical-author, observer and relay-to-service requests use the shared explicit-direct HTTP transport with private empty-proxy agents. Node environment proxy settings, including JSON configuration files, cannot redirect these credential-bearing requests; the command does not mutate the global agent or rely on a bypass list. `proxy-privacy.test.ts` verifies the actual fake-tunnel CLI in fresh processes under all five proxy activation routes, with an unauthenticated positive control and a synthetic captured turn. This does not change tunnel ownership or native ChatGPT network routing.

## Exclusive tunnel ownership

The command reads only the `tunnel` UUID and absolute `credentials-file` path from `~/.cloudflared/config.yml` (`--config` selects another configuration). It supports plain or quoted scalar values for those keys and fails on unsupported syntax. It never opens or copies the credential file. Only `cloudflared` reads that file and its normal account certificate.

1. Acquire an exclusive directory lock under the test cache. A stale lock is not stolen automatically.
2. Refuse another local `cloudflared tunnel` process whose command line identifies the target by its UUID, credentials-file path, selected config path or tunnel name (`opencode`), a target-identified legacy config-only launch, and any daily `scripts/local-chatgpt-test.mjs` runner. The owned connector PID is excluded. Only recognized read-only inspections (`info`, `list`, `token`, `ingress validate` / `rule`, help/version) with recognized options are exempt, including this command's own `info` children. Unknown actions or options count as connectors and refuse startup before remote inspection; this includes ad hoc `--name` / `-n` launches with `--hostname`, `--metrics`, `--logfile` or `--no-autoupdate=true`. Identifiers match complete arguments or option values, not prefixes; local UUIDs and tunnel names ignore letter case, paths match literally, and the remote UUID comparison also ignores case. Real machines often run unrelated tunnels: opaque `--token` / `--token-file` launches, bare `cloudflared tunnel run` using the default config, and launches through another or differently spelled config path without a visible target identity defer to the authoritative remote inventory. The command does not resolve those indirect identities by opening other configs. Tokens are never parsed or decoded, and token files are never opened. Process command lines are inspected only in memory and never printed or saved.
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

Send the printed Scenario message with the Wayfinder plugin mentioned. Capture the complete native assistant messages and all relevant intermediate content. The relay records actual requests/results in `raw/wire.json`; it never fabricates tool calls from prose. The local Map viewer is not forwarded. Outside a labelled turn, only `server/discover`, `initialize`, `notifications/initialized`, `ping`, `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list` and session deletion (HTTP DELETE with no body) are forwarded. ChatGPT App 26.1016 opens Refresh tools with `server/discover` (MCP `2026-07-28`). Release 3.1.0 supports that sessionless path; legacy `initialize` remains available. Its observed fallback used HTTP 400 / `-32000`; missing modern headers now yield HTTP 400 / `-32020` / `Protocol request failed`, and ChatGPT fallback on this response remains unverified until #114. #80 recorded the complete request body but not the required protocol/method headers, so the real app's selected era awaits #114. The relay forwards modern method/name headers and records terminal JSON or SSE responses for discovery and tools with null session IDs. The sole recorded request header is `protocolVersionHeader` (`MCP-Protocol-Version`, or null); authorization, cookies and all other request headers are excluded. `tools/call`, `resources/read` and `prompts/get` remain refused until a labelled turn begins. Discovery responses, including upstream protocol errors, are forwarded unchanged and recorded in the wire evidence; the current service returns JSON-RPC `-32601` for Resource Template listing. Verify Refresh tools in the real client before continuing; a forwarded discovery request does not establish client support for Resource reading.

Requests refused before forwarding are diagnostic evidence in the Attempt's private `raw/relay-refusals.jsonl` (mode `0600`). Each JSONL event carries a zero-based refusal `index`, a `kind` (`refusal` or `body`), and a `refusal` object containing its arrival time, HTTP status, reason enum, HTTP method, exact `/mcp` match boolean, Origin-presence boolean, JSON content-type boolean (`application/json` or an `application/*+json` media type), body shape, JSON-RPC method name and whether it arrived within a labelled turn. It never stores the path, header values, request ID, params, body text, credentials or ownership error details. JSON-RPC method names are bounded identifiers (letters/underscore first, then letters/digits/underscore/dot/colon/slash/hyphen; at most 128 characters); other values are recorded as null, and batch members are never extracted.

Body shapes are `object`, `array`, `empty`, `unparseable`, `scalar` (including JSON null) or `unavailable` (not yet received, interrupted or over the 1 MiB limit). Path/Origin/HTTP-method refusals keep their immediate response: their record is saved first with `unavailable`, then a `body` event with the same index is appended if a complete bounded body arrives. Reconstruct one refusal per index using its last complete line; only `refusal` events increment the summary counts. No body is inferred from its Content-Type. Reasons are `path_mismatch` (404), `origin_present` (403), `method_not_allowed` (405), `body_too_large` (413), `body_interrupted`, `delete_body`, `invalid_json`, `non_object_json`, `invalid_rpc`, `invalid_tool_params` (400), and `outside_turn` or `ownership_check_failed` (503). A disconnected request's status is the relay's selected response status; the client may never receive it. Upstream refusals remain in `wire.json`, not this file.

The file starts empty and each observation appends one bounded line, flushed synchronously before a refusal response or ownership-failure callback. Earlier bytes are never rewritten; neither the relay nor the summary retains or rescans the full refusal history. Total log bytes grow linearly with observations. This replaces the old `relay-refusals.json` array; historical files keep their original format. It does not depend on `stop` or exit handlers: completed writes survive uncaught exceptions, immediate process exit and SIGKILL. A kill during an append can leave an incomplete trailing line; ignore that final non-newline-terminated fragment and retain all earlier complete lines. An unfinished body remains `unavailable`. On `stop`, `attempt.json` contains `diagnostics.relayRefusals` (total, counts by reason/status, inside/outside turns and raw path), and `report.json`/`report.md` list the same counts. Abrupt exit can leave that summary stale or absent; read the raw file for diagnostics. These counts do not change Scenario verdicts, prove the caller was ChatGPT, or change any refusal rule. Use them to diagnose tool-refresh failures before considering changes to admission rules.

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

Optional `toolsShown` is the exact array of four tool definitions exposed by the client, including the write tools’ `inputSchema.properties.version.description`. Supply `toolsShownSource: "raw/wire.json#rpc-N"` pointing to the last POST `tools/list` exchange for the **same MCP session** as this turn’s tool calls, completed before that session’s first `begin` in the phase. Read the array from that exchange’s successful `response.result.tools`; the command requires exact structural equality, including descriptions and schemas. A later list, another session’s list, a superseded reference, a failed response, or a missing list/reference cannot fill `given.rulesSource` or `given.toolDescriptions`. Both remain unknown with the reason in `raw/tool-snapshot-N.json`; only a verified snapshot closes those gaps. After a service restart, an earlier service/session’s artifact cannot establish the new phase’s snapshot.

Refresh tools and prepare the chat **before** `begin`. If the client does not expose a correlatable pre-turn exchange, leave the evidence unknown for Kun; do not issue Controller calls or manufacture a list to fill it. A management-screen listing alone is insufficient. Keep native chat evidence alongside the wire reference: the wire proves what the client fetched, while human acceptance still checks that it is the intended chat and that the agent obtained its version there. Optional `versionSourceEvidence` holds a verbatim explanation or reference to that native evidence; arbitrary text closes nothing. Never copy from `controller-tools-*.json`, which records only Controller observations. `given.serviceVersion` is separate from client visibility.

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
node tests/behaviour/chatgpt/verify-parallel.mjs
# Runs two independent copies of that suite concurrently in this checkout.
node tests/behaviour/chatgpt/verify-parallel.mjs --full
# Runs two npm test gates concurrently instead.
```

Each fixture has its own random tunnel UUID, lease directory and Batch ID; cleanup addresses only that fixture. The parallel check guards against independent engineering gates contending for a shared fake tunnel lock.

The fake CLI mode is `--fake-tunnel --config <fixture config under the test cache>`. It can run while the daily connector remains active: it always selects the checked-in non-networking test double, skips the real local process inventory, uses fake remote connector state and marks its reports as fake. It accepts no alternate executable. The normal command has no skip-ownership option. Fake mode must not be counted as a real ChatGPT result.

Sessionless tool snapshots remain unverified until native-chat attribution is available. Calls and results still enter `raw/wire.json` and the Attempt events, but `toolsShown` cannot be bound to a chat merely by null `sessionId` or shared `clientInfo`. Upgrade checks depending on the definitions exposed to that chat remain `insufficient-evidence` with an explicit diagnostic.
