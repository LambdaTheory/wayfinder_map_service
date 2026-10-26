# Shared sandbox proxy channel — Issue #101

Implemented on 2026-10-26 for the behaviour-test infrastructure. This changes only `tests/behaviour/` and documentation; the Release Version stays 2.1.0 under MCP/SQLite §14.3. No product rule, MCP tool, everyday launcher or real service changes.

## One route implementation

`tests/behaviour/proxy.ts` contains the selector and validator originally delivered by PR #99. Runner, host and reviewer import it directly; the temporary compatibility exports were removed during independent review. There is no second parser or proxy-rule generator.

The Batch CLI and interactive host select exactly `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, and `no_proxy`. Codex selects only terminal values and never opens Claude settings. Claude additionally uses the corresponding `env` key in `~/.claude/settings.json`; a terminal value, including an empty string, wins. The same client-specific rule applies to reviewers. No other settings fields or environment entries are forwarded. For Claude, missing settings are allowed; invalid JSON, invalid shape, unreadable settings or non-string selected values stop setup with fixed diagnostics that contain no paths or values. Codex is unaffected by missing or malformed Claude settings. The client cannot read the source settings file. Invalid runner CLI proxy configuration produces one `refused:` line before any subscription read, not a stack trace.

`writeProfile(..., { proxyEnv })` validates the selected values, creates the TCP exceptions and returns the normalized `profile.proxyEnvironment`. All consumers must launch with that returned environment, so native routing matches the installed policy. The Codex runner and both interactive clients do this. The Dedicated Entry driver is not yet implemented on this base: its documented shared-API contract and a real sandbox consumer test cover this integration seam; this does not claim a completed Dedicated Entry model run.

Only HTTP(S) proxy URLs whose parsed hostname is `localhost` or `127.0.0.1` are accepted. They normalize to `127.0.0.1`; each grants only IPv4 TCP on its parsed port (default 80/443). Ports 18765/18766 are refused before launch, even on an otherwise unsupported hostname. IPv6, mapped IPv4 and other proxy hosts are refused. Empty proxies and bypass lists add no exceptions. The validator also refuses any registered harness service/relay port and the caller's `localPorts`/additional `protectedPorts`. `startService` and `startRoute` register their ports (including a relay's upstream) until shutdown. Proxy grants stay reserved while their runner-owned control directory exists; later harness endpoint allocation excludes those grants. Runner and host also exclude configured proxy ports before allocating their own listeners, so a down proxy cannot have its port reused as a service/relay. This ownership registry is process-local; a consumer split across controller processes must supply every additional known protected port explicitly.

The client retains its own relay and the existing scenario-specific bait exception where required. Every other local TCP endpoint remains denied. All IPv6 TCP/UDP and local IPv4 UDP are denied, including mapped-zero and UDP on an allowed TCP port. Public IPv4 TCP and UDP keep the prior policy. The initially added blanket IPv4 UDP deny was removed during review: it was unnecessary for local isolation and changed reviewer/public-network behaviour. The IPv6 UDP deny remains necessary because Seatbelt's localhost matcher misses mapped-zero destinations. The permitted proxy is trusted: Seatbelt checks the socket destination, not a subsequent HTTP CONNECT target, so it cannot prevent a trusted proxy from forwarding to another local service. No stronger transitive-destination guarantee is asserted.

## When to enable and how to record a Batch

A non-empty selected HTTP(S) proxy variable opens its narrow channel automatically at setup; no extra switch or separate firewall policy is needed. Use it when that approved client's network route requires a local HTTP proxy. This is routing setup, not authorization to spend model quota: the existing Batch gate still applies.

For a Codex run, absent or empty HTTP(S) terminal proxy variables leave the channel closed; Claude settings have no effect. For a Claude direct run, explicitly empty the four HTTP(S) terminal variables if settings would otherwise supply them. `ALL_PROXY`/`all_proxy` are never forwarded. Bypass values are preserved, not silently amended; when using a proxy, confirm that the intended relay bypass is present in `NO_PROXY`/`no_proxy` and verify actual MCP reachability in the approved probe. Invalid Claude settings still stop Claude setup rather than fall back to direct access.

The approved Batch description records the client/version, whether the channel is enabled, selected variable names and their source (terminal/settings), intended direct/proxy route, and the native-client IPv4/proxy probe result. Keep URL values, userinfo, bypass-list values and credentials out of the description and repository. Runtime records add only `{ enabled, variables }`: `batch.json` and per-turn isolation events for the runner, `isolation.json` for the interactive host. The protected launcher manifest necessarily carries the selected environment and remains private. `proxySecrets` supplies runner/host redaction with original and normalized proxy URLs plus non-empty userinfo, username and password, in their original, decoded and percent-encoded forms; this is not an exhaustive audit of unknown native-client credentials.

Do not rerun an earlier approved Batch against this change silently. Confirm that its client, route, Scenario and ceiling still match the approval, preserve the failed prior Attempt, and use a fresh Attempt directory. Any real availability check remains with the coordinator under that approval.

## Does Codex need the proxy?

**Codex supports an explicit proxy, but a requirement to use the known daily local proxy was not established.** The current shell has no proxy variables, and a passive snapshot of existing Codex TCP connections found non-loopback connections and no connection to the known daily proxy. Consequently, do not mark every Codex Batch as requiring that proxy. The reviewed implementation therefore selects Codex proxies only from its terminal, matching the everyday Codex and Dedicated Entry launcher. This corrects the first PR revision, which also consulted Claude settings for Codex.

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

`runner/proxy.test.ts` runs 12 real-sandbox cases: runner, shared API consumer, interactive Codex and interactive Claude, each with settings/terminal/no proxy; Codex ignores settings-only input. It proves the allowed relay/proxy paths and EPERM for unrelated IPv4, `127.1`, `localhost`, zero-address, IPv6 and mapped-address paths; UDP remains denied even on allowed TCP ports. Unsandboxed positive controls establish that the owned TCP aliases and UDP listeners are live. Reserved ports are tested through setup refusal and generated denial rules, never socket probes. Existing #94 filesystem/process/relay attacks and #99 reviewer tests remain in the full suite.

An end-to-end synthetic S0b Batch also connects through the proxy on both turns, writes only safe routing metadata and scrubs original/normalized and slash-less URLs, CONNECT errors, standalone userinfo, username and password deliberately echoed by its fake client, including percent-encoded and decoded forms. Reserved proxy routing is refused before Batch output or a service is created. All listeners are owned ephemeral fixtures; the real proxy, 18765/18766 and real database were not used.

Standards self-review: one selector/validator, explicit environment inputs for tests, no private values in fixed errors or metadata, no shipped files or Release Version change, no sub-agents or model review invoked. Spec self-review: #101's shared route, six-key precedence, reserved/IPv6/alias/UDP refusals, Codex investigation and Batch documentation are covered; Dedicated Entry adoption remains an explicitly documented seam of the upcoming driver, not an invented completed Entry.

The initial PR revision passed 1,847 tests. Final post-review build/test/typecheck results are recorded below; the historical installed-Codex probe above was not rerun during review fixes.

## Independent-review follow-up (2026-10-26)

Both [Codex](https://github.com/kun-g/wayfinder_map_service/pull/106#issuecomment-6416540253) and [Claude](https://github.com/kun-g/wayfinder_map_service/pull/106#issuecomment-6416618129) reviews were read in full, and the branch was checked against the latest main before edits (already up to date).

| Required fix | Failing regression before the fix | Passing behaviour after the fix |
| --- | --- | --- |
| Protected endpoint collision | Real Seatbelt let A nominate B's relay as HTTPS_PROXY; the fake upstream observed B's synthetic Authorization. Own-relay and service-port nominations also failed their refusal assertions. | All three nominations refuse before client launch; the own relay still works normally with A's identity. A retained proxy grant also prevents a later harness endpoint from taking that port. |
| Codex source selection | Real host launch inherited settings-only proxy values; malformed Claude settings prevented Codex setup. CLI source tests emitted a stack trace, and the Codex reviewer source regression failed. | Runner, interactive Codex and Codex reviewer use terminal-only selection; Claude settings fallback and terminal precedence remain tested. Codex ignores malformed Claude settings. CLI refusals are one safe line. |
| Credential echo forms | Sandboxed fake runner/Claude clients wrote slash-less URLs, CONNECT errors and standalone userinfo/password into raw records; plain and encoded runner variants failed. | One shared secret collector scrubs these forms in both runner and host; raw records contain no supplied username/password in encoded or decoded form. |

Additional review suggestions: retain four independently addressed fake proxies with integer/hex/octal/short IPv4 spellings, URL userinfo and wildcard/port-bearing bypass lists; remove the blanket public IPv4 UDP deny; remove the daily proxy port constant; import the shared implementation directly; correct the activation/loopback/validation documentation. All probes use owned ephemeral listeners, with no real credentials, model calls or everyday endpoint access.

An additional red regression used the short synthetic username/password `user:pass`: sequential replacement rewrote generated `-userinfo` placeholders and the leak check withheld the record. Redaction now replaces overlapping secrets in one longest-first pass, preserves only complete known placeholders on repeated calls, and checks the remaining text for leaks. The regression also checks a password directly following a placeholder so adjacent raw text is still scrubbed.

**Dedicated Entry / #68 acceptance handoff:** its future driver must choose proxy sources by client, exclude configured proxy ports during service/relay allocation, provide every known protected service/relay port across controller-process boundaries, launch with `profile.proxyEnvironment`, and use `proxySecrets` when capturing output. It needs a real-sandbox fake-client integration test through that driver. The existing `shared-api` test proves only the seam; it does not deliver the driver. These criteria are also called out in the PR follow-up for the coordinator to carry into #68.

Post-review checks on Node 26.3.0: `npm run build`, `npm test` (35 files, 1,864 tests), `npm run typecheck` and `git diff --check` all passed. Standards and Spec self-review found no remaining blocker in this change; Dedicated Entry adoption and cross-controller port inventories remain explicit caller responsibilities above. Latest main was checked again before committing and was still already included.
