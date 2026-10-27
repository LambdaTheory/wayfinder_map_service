# SDK v2 and two protocol eras (#110)

Implementation evidence for Release Version **3.1.0**, 2026-10-27. Contract: [MCP/SQLite §15.2](../spec/mcp-sqlite.md#152-sdk-v2-and-two-protocol-eras), [Answer Desk §9](../spec/answer-desk.md#9-implementation-and-release-sequence). This record establishes automated connectivity; real Codex/Claude connectivity is the coordinator's remaining #110 gate, and live ChatGPT belongs to #114.

## Versions and serving boundary

| Component exercised | Version |
| --- | --- |
| Node.js | 26.3.0 |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/node` | 2.1.2 |
| `@modelcontextprotocol/core` (transitive, lockfile) | 2.4.0 |
| `@modelcontextprotocol/client` (test dependency) | 2.4.0 |
| SDK HTTP client identity | `wayfinder-http-test` 0.1.0 |
| Legacy protocol, explicitly selected | `2025-11-25` |
| Modern protocol, explicitly pinned without fallback | `2026-07-28` |

The [official migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) requires explicit modern serving. The host uses the SDK's `isLegacyRequest` classification after the existing credential/Host/Origin/body checks. Legacy requests retain their sessionful transport, credential binding, DELETE draining and restart-404 behavior. Modern requests use `createMcpHandler` with `legacy: 'reject'`; every request gets the same server factory bound to its authenticated credential. A supplied modern session ID is refused. No session state, Claims or client identity is inferred from request `clientInfo`.

The Node adapter converts already bounded, parsed requests. Both eras use the same global four-call admission control and stop/drain ownership. Modern requests finish admitted work even if the HTTP client disconnects; their handler closes after the response work completes. No subscription streams are added (`maxSubscriptions: 0`). The four tools emit no progress, so modern auto-response mode returns JSON; no mandatory workflow, tool schema, Resource or Prompt content changes beyond the Release Version. SDK v2's malformed tool-call error is `InvalidParams` (`-32602`), replacing v1's `InternalError` (`-32603`), without publishing state.

## Automated evidence

`tests/mcp-service.test.ts` exercises both explicitly selected eras over real loopback HTTP:

- Four complete Ticket-type journeys, command-error/final-invariant matrix, conflicts, retained Claims and immutable history.
- Equal four-tool schemas, instructions, Resource contents and Prompt messages; modern discovery returns no session header and sends no `initialize`.
- `toolsOnly` credential descriptions and write-version refusals in both eras; stale modern writes remain refused after restart onto the canary release without requiring session-404 recovery.
- Modern bearer/Host/Origin checks, 1 MiB inclusive and over-limit requests, forged envelope identity, malformed metadata/header mismatches, protocol-error redaction and disabled subscriptions.
- The 100-command boundary and mixed-era four-call admission test: closing the modern client does not release occupied slots, and shutdown drains the admitted commits.
- Same modern client continues across restart; old legacy session IDs still return 404. Metadata records credential identity with null modern session IDs.

The existing in-memory tool tests remain on the SDK's legacy transport, as upstream requires; modern coverage uses the HTTP client. All behaviour-runner clients use the new client package; fake drivers and fixed evidence remain the only model substitutes exercised here.

## ChatGPT replay and evidence limits

The coordinator supplied the full non-secret body of **#80, B09a-app-20261027e/S0b-1, `raw/wire.json` rpc-1**, originally sent by ChatGPT App 26.1016 (`openai-mcp (Codex)` 1.0.0). The earlier #126 test contained only a shortened envelope. The full body is now pinned in `tests/behaviour/chatgpt/chatgpt.test.ts`; no raw private run files are copied into this repository.

With the required `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method: server/discover` headers, that exact body returns HTTP 200 and a result validated against the installed SDK's DiscoverResult schema. The SDK client then performs sessionless `tools/list` and `tools/call` through the same `toolsOnly` relay: exactly four tools expose the Release Version, and the wrong write version returns `version_mismatch` without publication. The original body advertises no Tasks extension; this slice adds no task service.

The original HTTP headers were **not recorded**. Without the required headers SDK 2.4.0 returns HTTP 400, JSON-RPC code `-32020`, with its diagnostic message:

> Bad Request: the request headers and body disagree: the body envelope names protocol version 2026-07-28 but the required MCP-Protocol-Version header is absent

The existing host redaction policy keeps that code and exposes **`Protocol request failed`**, without diagnostic data. The test asserts that exact exposed response and separately verifies legacy initialization still works. **ChatGPT fallback on this error is not established**: the live evidence only showed fallback after HTTP 400 / `-32000` / `Initialization required`. Actual header presence, selected era and fallback on `-32020` remain for #114. No compatibility bridge invents capabilities, headers or a legacy error code.

The relay now forwards `Mcp-Method` and `Mcp-Name` as well as protocol/session headers. It records only `protocolVersionHeader` from request headers; authorization, cookies and all other headers remain excluded. End-to-end fake-upstream tests cover unchanged JSON/SSE forwarding and terminal response extraction for discovery, listing and calls with null session IDs, including unrelated notifications and incomplete SSE events.

**Explicit follow-up:** `attempt.ts` cannot yet bind a sessionless tools snapshot to one native chat. It records calls/results normally, retains the exact supplied source, and emits `sessionless tool snapshot cannot yet be bound to this native chat; wire calls remain recorded`. Checks requiring those exposed definitions remain `insufficient-evidence`. Null session IDs and shared `clientInfo` are not proof of common chat identity. Add native-chat attribution before treating modern upgrade-snapshot scenarios as passing; this was the second PR #126 review concern.

## Verification and remaining gates

Commands: `npm ci`, `npm run build`, `npm test`, `npm run typecheck`, `git diff --check`, `npm ls @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/client @modelcontextprotocol/core`, `npm audit --omit=dev`. On Node 26.3.0, the final build and strict type check passed; the full suite passed **49 files / 2,240 tests** in 199.20 seconds, including 36 HTTP service tests and 74 ChatGPT/relay offline tests. `git diff --check` passed. Production dependency audit: zero vulnerabilities.

No real model, Codex, Claude or ChatGPT client was started; no everyday service, real database, port 18765/18766 or tunnel was operated. The coordinator still owns real-client connectivity, reviews, merge and the `v3.1.0` tag. This PR references #110 without closing it; #114 remains the one live ChatGPT run.
