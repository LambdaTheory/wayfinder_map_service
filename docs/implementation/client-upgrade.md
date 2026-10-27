# Open conversations across an upgrade

What happens to a chat that stays open while the service is upgraded, including release `3.1.0` (2026-10-27); the live observations below remain from `2.0.1` (2026-10-25). The contract is in [the spec](../spec/mcp-sqlite.md) sections 4 and 14.3, and the reasoning is in [ADR 0005](../adr/0005-writes-attest-the-rules-version.md).

## What the service does

- **An upgrade is a restart.** The running process never swaps definitions, so it declares no `listChanged` capability and offers no notification stream. The case "update while the MCP session stays open" does not occur here. MCP cannot replace `instructions` within a session, so that case would deliver new tools under old rules ([ADR 0003](../adr/0003-mcp-service-carries-the-versioned-exploration-workflow.md)).
- **Old 2025-11-25 sessions end.** Graceful stop finishes admitted work and refuses new calls with 503. After the restart, a request carrying an old `mcp-session-id` gets HTTP 404, and the client must initialize again. The new session carries the new instructions, tool list, Prompt and Resource. The Resource text begins with `version: <version>`.
- **Modern requests have no session.** Release 3.1.0 adds `2026-07-28` discovery and per-request metadata. A modern caller continues after restart without `initialize` or a session-404; this transport success does not refresh its cached rules. The write `version` guard remains the authority. ChatGPT App 26.1016 probes this era first: when it succeeds, ChatGPT uses this path immediately after #110, not only after #114. Even on its prior legacy path, ChatGPT opened sessions per call, so restart-404 was not a reliable rule refresh.
- **Writes attest their rules.** `map_create` and `map_apply` require `version`, the release whose rules the caller follows. If it is missing or differs from the running release, the call returns `version_mismatch` with nothing written, and points at `wayfinder://workflow/exploration`. The refusal does not name the running version: the caller learns it only from the rules. Reads are not gated.
- **No double writes.** A write that the 404 interrupted never ran. Its automatic resend carries the old version and is refused. A write that is repeated after it committed hits a Conflict, because `expectedRevision` moved on. A dropped connection mid-write leaves an unknown outcome, which the caller settles with `map_read` before deciding.

## Clients

| Client, situation | What reaches the model after the restart | First write | Result | Evidence |
| --- | --- | --- | --- | --- |
| Codex 0.164.0, same process (`codex exec`) | Nothing new. It reconnects on the 404 and resends once, but keeps the tools and instructions from its first connection. | Old version, refused | Read the Resource, reread the Map, retried with the new version; followed both new rules | Real run |
| Codex 0.164.0, conversation resumed (`codex exec resume`, `wayfinder resume`) | New tools and new instructions; the new process connects fresh | New version | Followed both new rules | Real run |
| Claude Code 2.1.310, same process (`claude -p`, tool search on) | New instructions. Tool definitions it loaded earlier through tool search stay old. | Old version, refused | On 2.0.1: read the Resource, retried with the new version, followed both new rules. On 2.0.0 it once retried from the refreshed instructions without reading the Resource and missed the rule that lived only in the new `map_apply` description. | Real runs |
| Claude Code 2.1.310, conversation resumed (`--resume`, `wayfinder resume`) | New tools; the resumed conversation keeps the old instructions | Old version, refused | Read the Resource, retried with the new version; followed both new rules | Real run |
| ChatGPT app (Chat mode, developer-mode plugin), compatibility mode | Nothing. ChatGPT keeps a tool snapshot until **Refresh tools**, and a chat keeps the definitions it started with even after a refresh. It never shows its model the server instructions, so the service states the release in its write tools (`toolsOnly` credential). | Release from the old tool definition, refused | Said it could not read the rules and asked the human to refresh the plugin and start a new chat; after that, a new chat wrote with the new release and followed the rule that lives only in the new `map_apply` description | Real run |

**Known gaps:** the gate checks one source per client. For Claude Code (instructions mode), the instructions may refresh while a tool definition it already loaded does not. For ChatGPT (compatibility mode), the instructions are never seen at all. So by the authoring rule in spec section 14.2, a rule that changes what a caller writes lives in both the instructions and the descriptions of the tools it governs.

**2.0.0 without compatibility mode** could not write from ChatGPT at all. After a refresh, a new chat held a `version` parameter but no instructions, so it guessed `"1"` and was refused; asked directly, it said it could see the tool descriptions but no server instructions.

## Recovery when a client does not refresh

- **Codex:** no action is needed for correctness, because the gate makes the model read the new rules. To give the model the new tool definitions as well, exit and run `wayfinder resume <id>` (or `codex resume <id>`). Codex has no in-session reconnect command.
- **Claude Code:** no action is needed for instruction rules. To refresh tool definitions loaded through tool search, exit and run `wayfinder resume <id>` (or `claude --resume <id>`). Whether `/mcp reconnect wayfinder` also replaces them is not verified.
- **ChatGPT:** Plugins, Wayfinder-Save, Manage, **Refresh tools** (chatgpt.com plugins on the web), then start a new conversation. Until then its writes are refused; the old conversation keeps refusing even after the refresh.

## What was verified how

- **Automated (`npm test`):**
  - U00: missing, wrong, oversized and non-string versions are refused, with nothing written; a leftover field from an older schema does not hide the version refusal.
  - U01: a real child process is replaced by a canary build on the same database. The old session gets 404, and a new session receives the canary's instructions, tool description, Resource and server version. The old-version resend is refused unwritten, the new-version write lands once, and repeating it is a Conflict.
  - D10, D11 and P08 (existing): graceful stop completes an active commit and refuses new calls; SIGKILL at each boundary leaves an atomic outcome that a reread settles.
- **Real clients, 2026-10-25** (Codex `gpt-6-astra`, low effort; Claude Code `sonnet`, low effort; isolated service, disposable database):
  - Baseline on `1.0.1` without the gate: both clients, in a single process, reconnected silently and wrote under the old rules.
  - On `2.0.0`, four runs, and on `2.0.1` four more: the Codex and Claude Code rows above. Each run ended with exactly two Revisions; every post-upgrade write went refused, Resource read, one retry.
  - With an intermediate 2.0.1 wording ("if you cannot read it, ask the human to refresh"), Codex in one process twice stopped and asked for a refresh instead of reading the Resource. The final wording says a `version_mismatch` is not a tool failure and reserves the human route for clients that cannot read Resources; with it Codex read the Resource and recovered.
  - ChatGPT app, driven by the agent through computer use against the public test endpoint: on `2.0.0` (no compatibility mode) the four steps 1.0.1 create, in-place upgrade, refresh in the old chat, new chat after refresh; on `2.0.1` with a `toolsOnly` credential, a new chat writing at `2.0.1`, the in-place upgrade to the `9.9.9` canary refusing the old chat, and a new chat after refresh writing at `9.9.9` with the canary Ticket rule. ChatGPT model GPT-6, thinking level 2 of 5.
  - The runner is [`tests/helpers/upgrade-live.mjs`](../../tests/helpers/upgrade-live.mjs), and the canary rules are in [`tests/helpers/canary-release.mjs`](../../tests/helpers/canary-release.mjs).
- **Not verified:**
  - Interactive TUI sessions. The runs used `codex exec` and `claude -p`, one process waiting across the restart.
  - A real client's write cut off mid-commit by a crash.
  - Claude Code's `/mcp reconnect`.
  - Codex with deferred tool search, where only the first line of the instructions reaches the model and the `version:` line would not.
  - ChatGPT on the web and on mobile; only the macOS app was driven.

Rerun with `WAYFINDER_LAUNCHER=scripts/wayfinder-agent/wayfinder node tests/helpers/upgrade-live.mjs <codex|claude> <live|resume>` after `npm run build`. Each run uses real model quota and writes its evidence to a new private folder under `~/Library/Application Support/Wayfinder/`.

## SDK v2 evidence and remaining client check

[Issue #110 evidence](sdk-v2.md) records automated SDK clients for both eras and the complete recorded ChatGPT discovery body from #80. The original HTTP headers were not captured. With the required modern protocol/method headers, discovery succeeds and sessionless tools retain `toolsOnly` descriptions and refuse an old write version. Without required headers, discovery returns HTTP 400 with code `-32020` and the service-redacted message `Protocol request failed`; legacy initialization remains available, but ChatGPT fallback for this code is unverified (only `-32000` / `Initialization required` was observed). Which path the real ChatGPT app takes, and whether it falls back on `-32020`, remain for #114; #110 runs no real clients or models.

The ChatGPT relay forwards modern `Mcp-Method`/`Mcp-Name` headers and records JSON or SSE responses without a session. A sessionless tool snapshot cannot yet prove which native chat received the definitions: upgrade checks that need that proof remain explicitly `insufficient-evidence`. A future native-chat binding is required; neither a null session ID nor shared `clientInfo` is treated as identity.
