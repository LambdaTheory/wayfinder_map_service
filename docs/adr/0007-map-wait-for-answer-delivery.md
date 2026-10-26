---
status: proposed
---

# A task-capable fifth tool delivers Desk Answers

Kun chose `map_wait` as a fifth business tool on 2026-10-26 ([#108](https://github.com/kun-g/wayfinder_map_service/issues/108)). It releases answers for the caller's claimed Tickets after the Map's Quiet Window: a client opting into MCP Tasks receives a task, while other clients can hold an ordinary blocking call. The choice keeps delivery in the service that owns the answers and makes the wait independent of an agent's terminal. The [Answer Desk specification](../spec/answer-desk.md) awaits Kun's confirmation under [#109](https://github.com/kun-g/wayfinder_map_service/issues/109).

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

This amends the four-tool boundary of [ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md), not its decision against a separate workflow-retrieval tool. Claude Code uses the `2026-07-28` Tasks extension; Codex keeps a blocking path; ChatGPT reads at turn start and does not call `map_wait`. Task completion delivers answers, never a Ticket Settlement.

The service moves to SDK v2 and serves both protocol eras on `/mcp`. The modern era is sessionless, so task records must outlive a request-scoped server instance. The service implements task discovery, retrieval and cancellation; merely upgrading the SDK does not supply that implementation ([upstream server implementation issue](https://github.com/modelcontextprotocol/ext-tasks/issues/30)). Questions, answers and Taken state are durable. The designer default permits a process-wide task registry, with task handles lost at restart; this refinement of #112's original durable-task wording awaits confirmation in the specification. Task state is distinct from Desk Question and Decision Ticket state.

Restart cannot invalidate a modern client's nonexistent MCP session. [ADR 0005](0005-writes-attest-the-rules-version.md)'s explicit Release Version attestation remains the protection against writes under old rules and also guards taking through `map_wait` or current `map_read` with `claimantId` and `version`; the historical restart-404 path applies only to sessionful clients. Ordinary/history reads still change no state. See [MCP/SQLite §15](../spec/mcp-sqlite.md#15-answer-desk-follow-on-slice) for the protocol and release boundaries.
