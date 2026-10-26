# B07 service call metadata and launcher correlation

Scope: [Issue 78](https://github.com/kun-g/wayfinder_map_service/issues/78), [behaviour testing R7 and B07](../spec/behaviour-testing.md), and the B01 correlation contract in `tests/behaviour/evidence.ts`. Release Version **2.1.0**, based on `78299fc2aeac6d324c574f2d0b5bd43642c65d45`; verification date **2026-10-26**, macOS arm64, Node **26.3.0**. The PR identifies the final implementation commit. This record is implementation evidence, not product Map state.

## Delivered contract

The local HTTP host always records MCP calls in `<databasePath>.calls.jsonl`, independently of launch mode and the Map transaction. The four tool handlers, schemas and workflow source are unchanged. Observation wraps admission and tool completion, so a no-op read, refusal, Conflict, storage failure, busy refusal and a committed call whose response was lost all leave a record. Protocol requests and failures that do not reach a tool handler also leave records, with null fields where authentication or bounded parsing did not establish them.

The [operator guide](local-mcp-service.md#default-call-metadata-release-version-210) defines `wayfinder-service-call/1`, privacy filtering, result classes and gap counters. In particular:

- `mcpSessionId` matches B01 `SessionRecord.mcpSessionIds`; string `requestId` matches the tool event's JSON-RPC request identifier. Use both keys, since request IDs repeat between sessions.
- `clientId` is the credential's operator-configured Client ID captured at session initialization, just as Revision authorship is. Later credential-file edits cannot relabel an existing session's tool observations.
- `credentialFingerprint` is the existing token's SHA-256 fingerprint. The launcher writes the same fingerprint to its private `wayfinder-launch/1` record. The Client ID format and Revision authorship stay unchanged; two launches of one Combination still differ by credential and MCP session.
- Launch records distinguish normal/test/research usage through an operator label, and preserve a known resumed native session ID. Fresh native IDs remain explicitly missing until native client evidence supplies them. Metadata does not prove human authorization; analysis and unmatched-log handling remain B08 work.
- Metadata append failures leave the business result unchanged. Safe stderr diagnostics, `metadataStatus()` and cumulative counters on recovered writes expose missing observations. All sinks failing and a subsequent process crash can still lose in-memory counters; this is not a durable audit subsystem.

Logs contain no arguments, tool result bodies, prompts, workflow text, raw tokens, exception diagnostics or private file paths. Files are private 0600 regular files; unsafe files, hard links and symlinks are refused. Existing logs append across restarts; no rotation or deletion is introduced.

## Verification

Commands, all with Node 26.3.0 first on PATH:

```sh
npm ci
npm run build
npm test
npm run typecheck
node tests/helpers/mcp-metadata-smoke.mjs
git diff --check
```

`npm test`: **19 files, 1309 tests passed**. Type checking, build and whitespace validation passed. On the first fresh-checkout run, the existing behaviour runner tests raced ahead of the HTTP suite's build and could not import `dist/sqlite-storage.js`; building first and rerunning the complete suite passed. No runner contract or scenario was changed to hide that failure.

| Acceptance | Executable evidence |
| --- | --- |
| Reads, successes, refusals, Conflicts and failures | `tests/call-metadata.test.ts` checks persisted records against B01 classification for reads, writes, duplicate Map, `version_mismatch`, invalid input, rejected command, absent Map, Conflict, storage failure and SDK rejection. Numeric request IDs normalize to strings. |
| No content, token or private-path disclosure | Tests plant synthetic content, tokens and paths in arguments, errors, IDs and unknown tool names; assert they are absent from records. Unsafe file permissions and symlinks are refused without modifying targets. |
| Failed log write preserves result and exposes gap | A real directory at the log path causes appends to fail. Exact read-response bytes remain equal, a create still commits, the API counter increases, and the next successful record retains the missing count and sequence gap. The separate process smoke checks the stderr gap diagnostic too. |
| Everyday/test entry and two sessions of one Combination | Real launcher functions run with synthetic state and stubbed service/harness operations for normal, test, dry-run and resumed entries. Stored fingerprints equal the existing credential-registration hashes; Client IDs remain identical. Two HTTP sessions use separate credentials for the same Client ID and retain distinct join keys. Restart preserves the prior log. |
| Disconnect, admission and shutdown | Existing `tests/mcp-service.test.ts` scenarios now assert that four admitted calls still record their committed outcomes after disconnect/drain, the busy refusal is recorded, and a lost post-COMMIT response creates exactly one committed observation. |
| Client response compatibility | For both instruction and `toolsOnly` modes, `tests/call-metadata.test.ts` compares serialized initialization results, tool metadata and create/list/read/Conflict/version-refusal results byte for byte against the uninstrumented tool server at the same Release Version. Fixed fixture time and viewer origin remove unrelated response variability. The required version bump is the only change to published workflow text. |

The operator smoke starts the real built `dist/mcp-start.js`, using a new database under the cache root mandated for behaviour tests, an OS-selected free port excluding 18765/18766, and generated credentials. It checks read/create/refusal/Conflict metadata, real SQLite write-lock failure, two same-Combination sessions, an actual filesystem log failure during a successful write, recovery counters, private file mode, and clean SIGTERM. It then removes only its own fixture.

Observed smoke summary:

```json
{"version":"2.1.0","toolCalls":10,"persistedToolCalls":9,"missingObservations":1,"distinctSessions":2,"privateMode":"0600","stopped":true,"result":"passed"}
```

## Self-review and remaining gates

**Standards:** no remaining findings. Metadata stays at the HTTP/operator boundary, outside the pure domain and SQLite mutation transaction; projection uses bounded identifiers and allowlists rather than serializing input/output. File and diagnostic failures cannot alter a tool receipt. Changes are confined to B07 implementation, launcher, tests, operator documentation and release records.

**Spec:** no remaining findings against Issue 78. Default recording requires no entry-specific flag; calls that write nothing and missing records are covered. Existing Client IDs and B01 keys are reused, with no new identity or MCP tool. Source authorization and human-verdict semantics are unchanged.

No real-model scenario, ChatGPT app/tunnel operation, everyday-service restart or existing private database was used. The observation capability is additive; no mandatory workflow rule or tool-use sequence changed. Per `AGENTS.md`, any behaviour-impact sampling is grouped into the next approved ChatGPT run. Independent review, merge and the `v2.1.0` tag remain the coordinator's work. The everyday service takes up the code only on its next authorized restart.
