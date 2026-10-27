---
status: accepted
---

# A task-capable fifth tool delivers Desk Answers

Kun chose `map_wait` as a fifth business tool on 2026-10-26 ([#108](https://github.com/kun-g/wayfinder_map_service/issues/108)). It releases answers for the caller's claimed Tickets after the Map's Quiet Window: a client opting into MCP Tasks receives a task, while other clients can hold an ordinary blocking call. The choice keeps delivery in the service that owns the answers and makes the wait independent of an agent's terminal. Kun accepted the detailed decisions on 2026-10-26; the [Answer Desk specification](../spec/answer-desk.md) records them for the design session's transcription check under [#109](https://github.com/kun-g/wayfinder_map_service/issues/109).

## Considered options

- A waiting mode on `map_read`: overloads current/history inspection with a potentially long operation and obscures client scheduling. Keep waiting explicit; the specified ChatGPT current-read delivery path is bounded and does not wait.
- Terminal reminders or injected messages: tie delivery to terminal handles and harness behavior and require an additional relay instead of returning the service's authoritative answers.
- Claude channels: Claude-specific rather than cross-client, and require a locally spawned stdio server instead of the existing independent Streamable HTTP service. They remain a research preview as of 2026-10-26; see the official [channels reference](https://code.claude.com/docs/en/channels-reference) and [preview description](https://code.claude.com/docs/en/channels). Adding a channel bridge would introduce another process and delivery contract.
- A fifth tool with task and blocking paths (chosen): a locally sufficient description says when to wait, what a release means and how to recover a missing result.

## Evidence and limits

The two spikes recorded in #108 establish feasibility, not Wayfinder feature acceptance:

- At 21:11 on 2026-10-26, Claude Code 2.1.310 used server-everything 2.0.1 over HTTP; a task handle ended the turn, and completion two minutes later resumed the idle session.
- At 21:12, Codex 0.164.0 negotiated `2025-11-25`, did not discover task tools, and completed a 90-second blocking call with `tool_timeout_sec = 300`.

## Consequences

This amends the four-tool boundary of [ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md), not its decision against a separate workflow-retrieval tool. The [client paths and public contract](../spec/answer-desk.md#6-client-paths-and-protocol-state) define task, blocking and taking-read use, result schemas, admission, cancellation and task lifetime; [release semantics](../spec/answer-desk.md#agent-delivery) define the durable taking boundary. [Reopen Request handling](../spec/answer-desk.md#reopen-requests) and [publication retirement](../spec/answer-desk.md#publication-after-reopening) define what a delivered request authorizes and how its answers remain distinct from a fresh verdict.

The [current-read projection contract](../spec/answer-desk.md#62-public-results-and-recovery-reads) defines `FoundMap.reopenContexts`, preserving the handled request context needed for the agent's default re-post recommendation and the desk's “Requested by Kun” marker and text context. This accepted 2026-10-26 design detail makes the request available to a resumed agent after handling and before re-posting.

The server needs the SDK v2 dual-era transport described in [MCP/SQLite §15.2](../spec/mcp-sqlite.md#152-sdk-v2-and-two-protocol-eras). Merely upgrading the SDK does not supply a Tasks server implementation ([upstream implementation issue](https://github.com/modelcontextprotocol/ext-tasks/issues/30)); the separate task and desk persistence contracts are specified in the Answer Desk, not inferred from SDK lifetime.

The [upgrade contract](../spec/mcp-sqlite.md#143-versioning-build-and-release) retains [ADR 0005](0005-writes-attest-the-rules-version.md)'s protection for both protocol eras. The Answer Desk's public inputs apply it to taking as well as agent writes; a task handle is not evidence that the model learned new rules.
