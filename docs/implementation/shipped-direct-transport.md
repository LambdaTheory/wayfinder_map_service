# Shipped local authenticated transports — Issue #121

Implemented on 2026-10-27, based on main at 8657350. Release Version 3.2.1 is a patch under MCP/SQLite §14.3. No mandatory workflow rule, tool sequence or tool schema changes; this behavior fix waits for the next approved ChatGPT run.

## Transport and ownership

- The ChatGPT runner calls the extracted attachment probe in scripts/local-chatgpt-attach.mjs. A private Node HTTP agent with an empty proxy environment handles initialization and temporary-session DELETE, consumes responses, applies a three-second deadline per request and is destroyed in finally.
- The everyday relay owns the same kind of direct agent, passes it on every authenticated upstream request, and destroys it when the relay closes or fails to listen.
- The Python launcher uses its own opener with ProxyHandler({}), bypassing environment/platform proxy discovery and any installed global opener. It refuses redirects before a local-service credential can leave that endpoint.
- Node HTTP does not follow redirects. No global agent, fetch dispatcher, urllib opener or proxy environment is changed. Native clients retain their existing proxy settings.

## Repository audit

Searched shipped src/, web/ and scripts/ for fetch, HTTP request imports/calls, urllib openers and Authorization/Bearer construction, then traced callers.

| Site | Disposition |
| --- | --- |
| scripts/local-chatgpt-test.mjs attachment | Initialization and DELETE now use the extracted direct probe. |
| scripts/local-chatgpt-relay.mjs | Every forwarded POST/DELETE now uses its private direct agent. |
| scripts/wayfinder-agent/wayfinder post/probe | Direct opener protects all authenticated launcher MCP requests. |
| Launcher get_json | Viewer-list reads carry no credential; outside the authenticated-request change. |
| Launcher Codex/Claude configuration generation | Hands credentials to native clients; it does not perform HTTP requests. Native client transports are outside this fix. |
| src/mcp-http-internal.ts | Inbound authentication and in-process protocol dispatch; no outbound bearer HTTP request. |
| web/viewer/viewer.js | Relative read-only browser requests without attached credentials. |
| Other shipped scripts and source | No other outbound authenticated local HTTP site found at this base commit. |

PR #142 adds keyed desk access in the same launcher, and PR #143 changes the service. Inspected #142 at c9b1186: its get_json call remains unauthenticated, and it hands the desk key to the browser in a URL fragment; no extra authenticated Python HTTP site is introduced. These launcher edits do not overlap the post/opener change. Preserve the private opener and coordinate package versions and CHANGELOG ordering at merge; native browser transports remain outside this script fix.

## Isolated evidence

tests/shipped-proxy-privacy.test.ts launches fresh Node/Python processes against owned fake services and a fake proxy, using only a synthetic token. No real credentials, everyday endpoint, tunnel, client or model is used. Ports are dynamically allocated with the harness allocator, excluding 18765/18766.

The 13 Node cases cover proxy variables without env-proxy activation; NODE_USE_ENV_PROXY; all four hyphen/underscore spellings in argv and NODE_OPTIONS; explicit/default JSON config files; and setGlobalProxyFromEnv. Each enabled case proves ambient fetch and HTTP requests reach the fake proxy without credentials. The environment-only case additionally uses an explicit proxy agent as its positive control, since those variables alone do not activate Node proxy mode. Each case also requires four authenticated requests at the intended service (attach POST/DELETE and relay POST/DELETE), zero at the proxy, and unchanged ambient networking afterward.

The four Python cases cover uppercase/lowercase environment variables, simulated platform proxy discovery and an installed global opener. Platform discovery/bypass functions are simulated only inside the fixture process, without reading or changing real system settings. Each case requires working unauthenticated proxy controls before and after the launcher call, successful authenticated initialization/DELETE at the service and zero authenticated proxy requests.

Before the transport fix, all 12 enabled Node cases exposed three authenticated requests each, and all four Python cases exposed one each. The proxy returned a synthetic non-MCP response, so initialization did not yield a session for a further DELETE. After the fix, all 17 cases pass. Additional regressions cover five redirect statuses for both probes and unauthorized/disconnected/timed-out attach requests with connection cleanup. Existing tests retain real local-service protocol coverage, launcher metadata checks and all three SQLite backup phases of the runner entry point.

The extracted attachment function is the one imported by the runner. Its backup test mocks that boundary to avoid opening the fixed everyday port; the proxy tests exercise the actual extracted transport.

Final checks on Node 26.3.0: npm run build, npm test (54 files, 2,351 tests), npm run typecheck and git diff --check all passed. The focused existing-protocol/backup/launcher run passed 52 tests before the eight additional redirect/failure checks joined the full suite. Two independent reviews and merge/version ordering remain with the coordinator; no live ChatGPT run was started.
