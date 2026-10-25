# Open conversations across an upgrade

What happens to a chat that stays open while the service is upgraded, as of release `2.0.0` (2026-10-25). The contract is in [the spec](../spec/mcp-sqlite.md) sections 4 and 14.3, and the reasoning is in [ADR 0005](../adr/0005-writes-attest-the-rules-version.md).

## What the service does

- **An upgrade is a restart.** The running process never swaps definitions, so it declares no `listChanged` capability and offers no notification stream. The case "update while the MCP session stays open" does not occur here. MCP cannot replace `instructions` within a session, so that case would deliver new tools under old rules ([ADR 0003](../adr/0003-mcp-service-carries-the-versioned-exploration-workflow.md)).
- **Old sessions end.** Graceful stop finishes admitted work and refuses new calls with 503. After the restart, a request carrying an old `mcp-session-id` gets HTTP 404, and the client must initialize again. The new session carries the new instructions, tool list, Prompt and Resource. The Resource text begins with `version: <version>`.
- **Writes attest their rules.** `map_create` and `map_apply` require `version`, the release whose rules the caller follows. If it is missing or differs from the running release, the call returns `version_mismatch` with nothing written, and points at `wayfinder://workflow/exploration`. The refusal does not name the running version: the caller learns it only from the rules. Reads are not gated.
- **No double writes.** A write that the 404 interrupted never ran. Its automatic resend carries the old version and is refused. A write that is repeated after it committed hits a Conflict, because `expectedRevision` moved on. A dropped connection mid-write leaves an unknown outcome, which the caller settles with `map_read` before deciding.

## Clients

| Client, situation | What reaches the model after the restart | First write | Result | Evidence |
| --- | --- | --- | --- | --- |
| Codex 0.164.0, same process (`codex exec`) | Nothing new. It reconnects on the 404 and resends once, but keeps the tools and instructions from its first connection. | Old version, refused | Read the Resource, reread the Map, retried with the new version; followed both new rules | Real run |
| Codex 0.164.0, conversation resumed (`codex exec resume`, `wayfinder resume`) | New tools and new instructions; the new process connects fresh | New version | Followed both new rules | Real run |
| Claude Code 2.1.310, same process (`claude -p`, tool search on) | New instructions. Tool definitions it loaded earlier through tool search stay old. | Old version, refused | Retried with the new version taken from the new instructions, without reading the Resource. **Followed the new instruction rule, missed the rule that lives only in the new `map_apply` description.** | Real run |
| Claude Code 2.1.310, conversation resumed (`--resume`, `wayfinder resume`) | New tools; the resumed conversation keeps the old instructions | Old version, refused | Read the Resource, retried with the new version; followed both new rules | Real run |
| ChatGPT custom connector | Nothing until the human refreshes the connector. OpenAI documents a tool snapshot that only a manual Refresh updates, and no `listChanged` handling. | Old version, refused | Cannot read Resources, so it cannot recover by itself | Not run; OpenAI docs as of 2026-10-25 |

**Known gap:** when Claude Code's instructions refresh but a tool definition it already loaded does not, the gate cannot tell. The caller attests the instructions it holds, and those are current. A rule that a release puts only in a tool description can then be missed until the conversation is resumed. Rules that matter across tools belong in the instructions summary or the safety core.

## Recovery when a client does not refresh

- **Codex:** no action is needed for correctness, because the gate makes the model read the new rules. To give the model the new tool definitions as well, exit and run `wayfinder resume <id>` (or `codex resume <id>`). Codex has no in-session reconnect command.
- **Claude Code:** no action is needed for instruction rules. To refresh tool definitions loaded through tool search, exit and run `wayfinder resume <id>` (or `claude --resume <id>`). Whether `/mcp reconnect wayfinder` also replaces them is not verified.
- **ChatGPT:** open the connection under chatgpt.com plugins (connectors), choose **Refresh**, then start a new conversation. Until then its writes are refused.

## What was verified how

- **Automated (`npm test`):**
  - U00: missing, wrong, oversized and non-string versions are refused, with nothing written; a leftover field from an older schema does not hide the version refusal.
  - U01: a real child process is replaced by a canary build on the same database. The old session gets 404, and a new session receives the canary's instructions, tool description, Resource and server version. The old-version resend is refused unwritten, the new-version write lands once, and repeating it is a Conflict.
  - D10, D11 and P08 (existing): graceful stop completes an active commit and refuses new calls; SIGKILL at each boundary leaves an atomic outcome that a reread settles.
- **Real clients, 2026-10-25** (Codex `gpt-6-astra`, low effort; Claude Code `sonnet`, low effort; isolated service, disposable database):
  - Baseline on `1.0.1` without the gate: both clients, in a single process, reconnected silently and wrote under the old rules.
  - On `2.0.0`, four runs: the table above.
  - The runner is [`tests/helpers/upgrade-live.mjs`](../../tests/helpers/upgrade-live.mjs), and the canary rules are in [`tests/helpers/canary-release.mjs`](../../tests/helpers/canary-release.mjs).
- **Not verified:**
  - Interactive TUI sessions. The runs used `codex exec` and `claude -p`, one process waiting across the restart.
  - A real client's write cut off mid-commit by a crash.
  - Claude Code's `/mcp reconnect`.
  - Codex with deferred tool search, where only the first line of the instructions reaches the model and the `version:` line would not.
  - ChatGPT.

Rerun with `WAYFINDER_LAUNCHER=~/workspace/runtime/tools/wayfinder_agent/wayfinder node tests/helpers/upgrade-live.mjs <codex|claude> <live|resume>` after `npm run build`. Each run uses real model quota and writes its evidence to a new private folder under `~/Library/Application Support/Wayfinder/`.
