# Shared sandbox proxy channel — Issue #101

Implemented on 2026-10-26 for the behaviour-test infrastructure. This changes only `tests/behaviour/` and documentation; the Release Version stays 2.1.0 under MCP/SQLite §14.3. No product rule, MCP tool, everyday launcher or real service changes.

## One route implementation

`tests/behaviour/proxy.ts` contains the selector and validator originally delivered by PR #99. Reviewer imports retain compatibility names through `review-proxy.ts`; `interactive/subscription.ts` retains its former selector name as an export of the same implementation. There is no second parser or proxy-rule generator.

The Batch CLI and interactive host select exactly `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, and `no_proxy`. For each key, a terminal value, including an empty string, overrides the corresponding `env` key in `~/.claude/settings.json`. No other settings fields or environment entries are forwarded. Missing settings are allowed; invalid JSON, invalid shape, unreadable settings or non-string selected values stop setup with fixed diagnostics that contain no paths or values. The client cannot read the source settings file.

`writeProfile(..., { proxyEnv })` validates the selected values, creates the TCP exceptions and returns the normalized `profile.proxyEnvironment`. All consumers must launch with that returned environment, so native routing matches the installed policy. The Codex runner and both interactive clients do this. The Dedicated Entry driver is not yet implemented on this base: its documented shared-API contract and a real sandbox consumer test cover this integration seam; this does not claim a completed Dedicated Entry model run.

Only HTTP(S) proxy URLs whose parsed hostname is `localhost` or `127.0.0.1` are accepted. They normalize to `127.0.0.1`; each grants only IPv4 TCP on its parsed port (default 80/443). Ports 18765/18766 are refused before launch, even on an otherwise unsupported hostname. IPv6, mapped IPv4 and other proxy hosts are refused. Empty proxies and bypass lists add no exceptions.

The client retains its own relay and the existing scenario-specific bait exception where required. Every other local TCP endpoint remains denied. All IPv6 TCP and all IPv4/IPv6 UDP are denied, including mapped-zero and UDP on an allowed TCP port. Public IPv4 TCP keeps the prior policy. The permitted proxy is trusted: Seatbelt checks the socket destination, not a subsequent HTTP CONNECT target, so it cannot prevent a trusted proxy from forwarding to another local service. No stronger transitive-destination guarantee is asserted.

## When to enable and how to record a Batch

A non-empty selected HTTP(S) proxy variable opens its narrow channel automatically at setup; no extra switch or separate firewall policy is needed. Use it when that approved client's network route requires a local HTTP proxy. This is routing setup, not authorization to spend model quota: the existing Batch gate still applies.

For an intended direct run, explicitly set all four HTTP(S) proxy variables to empty in the operator terminal if settings would otherwise supply them. `ALL_PROXY`/`all_proxy` are never forwarded. Bypass values are preserved, not silently amended; when using a proxy, confirm that the intended relay bypass is present in `NO_PROXY`/`no_proxy` and verify actual MCP reachability in the approved probe. Invalid settings still stop setup rather than fall back to direct access.

The approved Batch description records the client/version, whether the channel is enabled, selected variable names and their source (terminal/settings), intended direct/proxy route, and the native-client IPv4/proxy probe result. Keep URL values, userinfo, bypass-list values and credentials out of the description and repository. Runtime records add only `{ enabled, variables }`: `batch.json` and per-turn isolation events for the runner, `isolation.json` for the interactive host. The protected launcher manifest necessarily carries the selected environment and remains private. Original and normalized proxy URLs are included in runner/host redaction; this is not an exhaustive audit of unknown native-client credentials.

Do not rerun an earlier approved Batch against this change silently. Confirm that its client, route, Scenario and ceiling still match the approval, preserve the failed prior Attempt, and use a fresh Attempt directory. Any real availability check remains with the coordinator under that approval.

## Does Codex need the proxy?

**Codex supports an explicit proxy, but a requirement to use the known daily local proxy was not established.** The current shell has no proxy variables, and a passive snapshot of existing Codex TCP connections found non-loopback connections and no connection to the known daily proxy. Consequently, do not mark every Codex Batch as requiring that proxy. Conversely, an empty terminal is not a direct-route declaration for this harness: its shared selector also uses Claude's settings, for Codex as well as Claude, unless overridden.

Evidence collected without a model call or a real proxy connection:

- Installed npm package: `@openai/codex` 0.164.0. Static executable inspection found the eight conventional proxy variable names and reqwest 0.12.28 paths; only presence was printed.
- This worker terminal: the six supported names plus `ALL_PROXY` and `all_proxy` were all absent. In Claude settings, only membership of those names in `env` was inspected: the six supported names were present, the two ALL names absent. No configuration value, credential field or login file was inspected for this inventory.
- Passive `lsof` classification of existing Codex sockets: loopback and non-loopback established connections existed; the known daily proxy was not observed. This does not attribute every socket to a model request, prove every other terminal's environment, or exclude VPN/TUN/network routing below the application.
- System proxy observation reported only flags: HTTP/HTTPS/SOCKS disabled, automatic proxy configuration enabled. No PAC URL/content was read or fetched. These flags do not prove which route any individual request chose.
- `node tests/behaviour/runner/codex-proxy-probe.ts` ran the installed binary's **`mcp login fixture`**, with an empty HOME/CODEX_HOME, an invented `.invalid` MCP endpoint, a fake proxy that always returns HTTP 502, and Seatbelt allowing outbound traffic **only** to that owned proxy. It neither authenticates nor invokes a model. The expected nonzero exit is the deliberately failed fake discovery, not evidence of real login/API availability.

| Native probe input | Fake proxy reached |
| --- | --- |
| `HTTP_PROXY` or `http_proxy`, HTTP target | yes, each independently |
| `HTTPS_PROXY` or `https_proxy`, HTTPS target | yes, each independently |
| `ALL_PROXY` or `all_proxy`, HTTPS target | yes, each independently; intentionally excluded from harness forwarding |
| `HTTPS_PROXY` plus matching `NO_PROXY` or `no_proxy` | no, each bypass independently |
| No proxy variables | no |

The probe demonstrates the installed MCP HTTP transport, not a model request. As corroborating implementation evidence, OpenAI's [outbound route selector](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/http-client/src/outbound_proxy.rs) selects the conventional HTTP/HTTPS/ALL and bypass variables; its [Responses proxy regression](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/tests/suite/responses_system_proxy.rs) checks model-transport proxy routing. That source commit is upstream evidence, not a claim that it exactly matches the installed build. Real Codex/Claude API reachability and model-side fallback remain for an approved Batch.

## Verification and self-review

`runner/proxy.test.ts` runs 12 real-sandbox cases: runner, shared API consumer, interactive Codex and interactive Claude, each with settings/terminal/no proxy. It proves the allowed relay/proxy paths and EPERM for unrelated IPv4, `127.1`, `localhost`, zero-address, IPv6 and mapped-address paths; UDP remains denied even on allowed TCP ports. Unsandboxed positive controls establish that the owned TCP aliases and UDP listeners are live. Reserved ports are tested through setup refusal and generated denial rules, never socket probes. Existing #94 filesystem/process/relay attacks and #99 reviewer tests remain in the full suite.

An end-to-end synthetic S0b Batch also connects through the proxy on both turns, writes only safe routing metadata and scrubs a normalized proxy URL deliberately echoed by its fake client. Reserved proxy routing is refused before Batch output or a service is created. All listeners are owned ephemeral fixtures; the real proxy, 18765/18766 and real database were not used.

Standards self-review: one selector/validator, explicit environment inputs for tests, no private values in fixed errors or metadata, no shipped files or Release Version change, no sub-agents or model review invoked. Spec self-review: #101's shared route, six-key precedence, reserved/IPv6/alias/UDP refusals, Codex investigation and Batch documentation are covered; Dedicated Entry adoption remains an explicitly documented seam of the upcoming driver, not an invented completed Entry.

Final checks passed on Node 26.3.0: `npm run build`, `npm test` (35 files, 1,847 tests), `npm run typecheck`, and `git diff --check`. The optional installed-Codex no-model probe produced the routing results above.
