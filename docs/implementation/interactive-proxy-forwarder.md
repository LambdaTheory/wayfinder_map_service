# Interactive proxy forwarding — Issue #118

Implemented for B09b on 2026-10-27. Only behaviour infrastructure and documentation change; the Release Version remains 2.1.0 under MCP/SQLite §14.3. This does not authorize a real client/probe/acceptance Batch.

## Lifecycle

The host creates the same `runner/proxy-channel.ts` channel used by the automatic MCP-only and Dedicated runners. Its opaque permit is passed to the shared sandbox builder; only the rewritten forwarding ports and the session relay are granted. The configured upstream proxy is not directly reachable. Proxy mode denies other direct socket destinations, including public IPv4 and Unix sockets; no-proxy routing keeps its existing policy.

```text
host setup → inactive forwarding listener
trusted wrapper → launch.jsonl: starting
host → activate shared channel → host.starting acknowledgement
wrapper → sandbox-exec client → launch.jsonl: started
client exit → wrapper → launch.jsonl: exited
host → deactivate + disconnect sockets → host.exited acknowledgement
operator outcome / cancellation → revoke → observe 500 ms → close listener
```

This extends the existing manifest/control-directory and `launch.jsonl` trust boundary. It introduces no credential-bearing network protocol. The wrapper waits for each acknowledgement, with a 10-second ceiling, and the host consumes complete log lines every 10 ms. Log mutation or repeated start signals revoke forwarding and record failure. The sandbox cannot read the manifest or write the signal log/acknowledgements; the exclusive `launch.once` marker still prevents a second invocation. Lower-level launcher/profile fixtures can omit the channel; every actual `host()` launch supplies it, including the disabled no-proxy channel.

The listener rejects and counts connections before startup and after the exit signal. The final observation also runs on cancellation, premature operator completion and error paths, before evidence export or subscription cleanup. `raw/proxy-channel.json` and `isolation.json.proxyChannel` retain enabled/closed flags and total/blocked counts, with no endpoints or credentials. Any blocked connection, handshake failure or missing exit evidence prevents `complete`. An operator report cannot substitute for a missing wrapper exit: exposed scratch and subscription synchronization stay deferred while forwarding is closed.

Original, normalized and rewritten proxy values use separate entries in the existing redactor. Controller/history and session-relay requests keep #106's private direct HTTP agents. No global HTTP setting or proxy environment is changed by the host or wrapper.

## Evidence and review

All probes use owned ephemeral fake proxies, synthetic subscription state, disposable service databases and fake clients under real macOS `sandbox-exec`:

- Ten full host runs cover Codex/Claude with normal completion, a connection before startup, a detached descendant with cwd `/`, Node proxy mode with a replaced global dispatcher, and operator completion while the client still runs.
- The detached child continues making requests for a bounded interval after its parent exits. Both hosts record inactive connections and return `driver-failed`; upstream request counts stay unchanged after wrapper return and host closure. The child exits itself; no unrelated process is signalled.
- A before-start connection never reaches the upstream and prevents completion. Normal runs complete. Premature completion closes the channel and preserves controls/scratch until the owned fixture wrapper exits.
- Real sandbox clients cannot forge `launch.jsonl` or host acknowledgements, read the manifest, or connect to the original upstream. They can use the channel and make an MCP initialization request through their credential relay.
- Node proxy tests prove activation with a successful unauthenticated control, then complete with zero authenticated requests through the fake proxy. The existing wider #106 activation matrix remains in the full suite.
- Four focused lifecycle tests cover acknowledgement-before-spawn, refusal after host closure, held-socket revocation, inactive connection evidence, invalid/repeated lifecycle input and terminal shutdown state.
- Existing interactive launch, privacy, source-selection, subscription-refresh and capture regressions remain in the suite. The synthetic host fixture now launches its wrapper asynchronously so the host can service the handshake.

The new detached regression was also run with the original `host.ts` from the base commit: it fails because the descendant still reaches the upstream after wrapper return (8 → 15 requests in 80 ms). Restoring the implementation makes the test pass. No real model/client, credential source, configured proxy, everyday service, reserved port or real database was used.

Standards self-review: one TCP forwarding implementation, one sandbox policy builder, the existing protected file channel, explicit ownership and early revocation, fixed failure messages, shared redaction/direct transport, no shipped-file/version changes, no sub-agents. Spec self-review: all #118 criteria are exercised by host-level fake-client tests; the interactive exception is removed from current documentation. Real B09b acceptance remains a separately approved Batch.

Final validation on Node 26.3.0, based on main `f8b3900`: `npm run build`, `npm test` (46 files, 2,021 tests; 208.77 seconds), `npm run typecheck` and `git diff --check` passed. The source-selection host regressions use two owned fake proxies and assert which one responds, preserving terminal precedence and Claude settings fallback through the rewritten forwarding URL.

## Limits

The file handshake has scheduling/polling latency; session end is acknowledged only after revocation. A wrapper that disappears without an exit signal cannot produce a complete capture; host finish/cancellation or its 60-minute ceiling still revokes forwarding. These controls do not prove all descendants exited. Connections after final listener closure are refused but not recorded. Port retirement is controller-process-local, and indirect system-broker actions remain outside the direct-socket guarantee. #99 reviewer routing and the separately tracked shipped-script transport work (#121) are unchanged.
