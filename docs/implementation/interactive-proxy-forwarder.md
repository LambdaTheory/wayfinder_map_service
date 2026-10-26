# Interactive proxy forwarding — Issue #118

Implemented for B09b on 2026-10-27. Only behaviour infrastructure and documentation change; the Release Version remains 2.1.0 under MCP/SQLite §14.3. This does not authorize a real client/probe/acceptance Batch.

## Lifecycle

The host creates the same `runner/proxy-channel.ts` channel used by the automatic MCP-only and Dedicated runners. Its opaque permit is passed to the shared sandbox builder; only the rewritten forwarding ports and the session relay are granted. The configured upstream proxy is not directly reachable. Proxy mode denies other direct socket destinations, including public IPv4 and Unix sockets; no-proxy routing keeps its existing policy.

```text
host setup → inactive forwarding listener
trusted wrapper → launch.jsonl: starting
host → activate shared channel → host.starting acknowledgement
wrapper → sandbox-exec client → launch.jsonl: started
client exit callback → timestamp + launch.jsonl: exited → profile verification
host → deactivate + disconnect sockets → host.exited acknowledgement
operator outcome / cancellation → revoke → observe 500 ms → close listener
```

This extends the existing manifest/control-directory and `launch.jsonl` trust boundary. It introduces no credential-bearing network protocol. The wrapper waits for each acknowledgement, with a 10-second ceiling, and the host consumes complete log lines before accepting each proxy connection, with a 10 ms polling fallback. Shutdown consumes pending exit evidence without activating a pending start. Log mutation or repeated start signals revoke forwarding and record failure. The sandbox cannot read the manifest or write the signal log/acknowledgements; the exclusive `launch.once` marker still prevents a second invocation. Lower-level launcher/profile fixtures can omit the channel; every actual `host()` launch supplies it, including the disabled no-proxy channel.

The listener rejects and counts connections before startup and once it observes the exit signal. The wrapper records `exitAtNs` at the start of the child’s `exit` callback, before profile verification. The channel timestamps accepts on that same monotonic clock: connections already forwarded at or after `exitAtNs` become `postExitConnections`, independently of when the host reads the signal. `blockedConnections` remains the count actually refused; either count prevents completion. The macOS-only host uses the shared machine clock exposed by Node 26.3.0 [hrtime](https://github.com/nodejs/node/blob/v26.3.0/src/node_process_methods.cc) and its [Darwin libuv implementation](https://github.com/nodejs/node/blob/v26.3.0/deps/uv/src/unix/darwin.c), rather than wall time or a process-relative performance clock. The final observation also runs on cancellation, premature operator completion and error paths, before evidence export or subscription cleanup. `raw/proxy-channel.json` and `isolation.json.proxyChannel` retain enabled/closed flags and total/blocked/post-exit counts, with no endpoints or credentials. Any blocked connection, handshake failure or missing exit evidence prevents `complete`. An operator report cannot substitute for a missing wrapper exit: exposed scratch and subscription synchronization stay deferred while forwarding is closed.

Original, normalized and rewritten proxy values use separate entries in the existing redactor. Controller/history and session-relay requests keep #106's private direct HTTP agents. No global HTTP setting or proxy environment is changed by the host or wrapper.

## Evidence and review

All probes use owned ephemeral fake proxies, synthetic subscription state, disposable service databases and fake clients under real macOS `sandbox-exec`:

- Sixteen full host runs cover Codex/Claude with normal completion, a connection before startup, a continuously reconnecting detached descendant with cwd `/`, an immediate one-shot child, a child delayed until final observation, a deliberately delayed exit signal, Node proxy mode with a replaced global dispatcher, and operator completion while the client keeps sending traffic.
- The detached child continues making requests for a bounded interval after its parent exits. Both hosts record inactive connections and return `driver-failed`; upstream request counts stay unchanged after wrapper return and host closure. The child exits itself; no unrelated process is signalled.
- A before-start connection never reaches the upstream and prevents completion. Normal runs complete. Premature completion closes the channel and preserves controls/scratch until the owned fixture wrapper exits.
- Real sandbox clients cannot forge `launch.jsonl` or host acknowledgements, read the manifest, or connect to the original upstream. They can use the channel and make an MCP initialization request through their credential relay.
- Node proxy tests prove activation with a successful unauthenticated control, then complete with zero authenticated requests through the fake proxy. The existing wider #106 activation matrix remains in the full suite.
- Seven focused lifecycle tests cover acknowledgement-before-spawn, refusal after host closure, held-socket revocation, inactive connection evidence, invalid/repeated lifecycle input, accept-time signal checks and terminal shutdown state. A shared-channel regression confirms that a connection forwarded before signal delivery is still counted against the original exit time, without double counting on cleanup.
- Existing interactive launch, privacy, source-selection, subscription-refresh and capture regressions remain in the suite. The synthetic host fixture now launches its wrapper asynchronously so the host can service the handshake.

The new detached regression was also run with the original `host.ts` from the base commit: it fails because the descendant still reaches the upstream after wrapper return (8 → 15 requests in 80 ms). Restoring the implementation makes the test pass. No real model/client, credential source, configured proxy, everyday service, reserved port or real database was used.

Standards self-review: one TCP forwarding implementation, one sandbox policy builder, the existing protected file channel, explicit ownership and early revocation, fixed failure messages, shared redaction/direct transport, no shipped-file/version changes, no sub-agents. Spec self-review: all #118 criteria are exercised by host-level fake-client tests; the interactive exception is removed from current documentation. Real B09b acceptance remains a separately approved Batch.

Initial validation on Node 26.3.0, based on main `f8b3900`: `npm run build`, `npm test` (46 files, 2,021 tests; 208.77 seconds), `npm run typecheck` and `git diff --check` passed. The source-selection host regressions use two owned fake proxies and assert which one responds, preserving terminal precedence and Claude settings fallback through the rewritten forwarding URL.

## PR #122 review correction

Claude reproduced a one-shot descendant passing through the 10 ms polling gap with `complete` and zero blocked connections. Both committed immediate-child cases first reproduced that false green at `731fd2c`. The implementation now publishes the monotonic exit time before verification, checks the protected log on every accept, and retrospectively counts any already-forwarded post-exit connections. This is an evidence correction as well as earlier revocation; it does not claim that no bytes can cross before the host receives the signal.

A deterministic full-host regression delays publication of the wrapper’s exit line by 100 ms after its timestamp is captured. The owned one-shot child waits for that test-only capture marker, then sends one request. Both clients must record `postExitConnections: 1`, `blockedConnections: 0`, and `driver-failed` even though the request was forwarded. A separate delayed-child case begins only during the final observation window and must be refused and counted. Normal immediate-child tests use only parent exit detection, without the injected delay.

Review suggestions also restore direct-upstream denial checks in the detached parent and descendants, retain live traffic after early completion, add a final shutdown poll, distinguish missing wrapper exit in metadata, and list raw proxy evidence only after successful retention. Shared launch-phase types, acknowledgement paths and channel-secret registration replace duplicated definitions. Controller/relay direct transports and automatic runner lease timing are unchanged. Wrapper liveness monitoring is not added; its remaining boundary is explicit below.

Review-fix validation on Node 26.3.0: `npm run build`, `npm test` (46 files, 2,031 tests; 214.75 seconds), `npm run typecheck` and `git diff --check` passed. Immediate-child and delayed-signal host tests also passed four consecutive rounds for both clients (16 cases). Standards self-review confirms one shared channel and typed trusted lifecycle, distinct refused/already-forwarded evidence, no ambient authenticated transport changes and test/documentation-only scope. Spec self-review reproduces both original false greens, verifies retrospective failure independently of delivery latency, and retains the final-observation and compatibility boundaries.

## Limits

The recorded boundary is the wrapper’s observation of the child exit, not a kernel-provided process-exit timestamp. Signal publication and scheduling still have latency; already-forwarded connections at or after that timestamp prevent completion, but their bytes cannot be recalled. Data sent after exit on a socket accepted before the timestamp cannot be attributed to a process and is not separately counted; host revocation disconnects that socket when the signal is observed. A wrapper that disappears without an exit signal cannot produce a complete capture, but forwarding can remain open and traffic uncounted until the operator finishes/cancels the host or its 60-minute ceiling expires. These controls do not prove all descendants exited. Connections after final listener closure are refused but not recorded. Port retirement is controller-process-local: each interactive Attempt starts a new host, so retirement does not prevent a later Attempt from reusing an earlier port. Indirect system-broker actions remain outside the direct-socket guarantee. The approved B09b probes must check compatibility with denied direct public IPv4 and Unix-socket access; no real client was run here. #99 reviewer routing and the separately tracked shipped-script transport work (#121) are unchanged.
