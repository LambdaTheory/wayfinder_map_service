# B02c upgrade evidence capture repair

Issue [#125](https://github.com/kun-g/wayfinder_map_service/issues/125), following
[B02c / #67](https://github.com/kun-g/wayfinder_map_service/issues/67). This changes
test tooling only: no Scenario, verdict rule, service code or Release Version changes.

## Native shapes and regression evidence

Codex 0.164 code mode exposes Wayfinder metadata in
`response_item.payload.type = custom_tool_call_output`. Its `output` is an array
of `input_text` blocks; one block's `text` is a JSON array of `{name, description}`
entries whose names start with `mcp__wayfinder__`. A description contains the
service instructions, version line and tool description. The extractor now also
accepts a direct JSON string in `output`. Only this tool-list shape contributes
instructions and tool descriptions. Resource `contents` objects, unrelated
servers and malformed output do not establish tool visibility.

Code-mode discovery is located using ordered `event_msg/item_completed`
`AgentMessage` and `McpToolCall` records, matched to this turn's normalized Events.
The output takes effect at the next Event boundary. It is not moved before an
earlier reply or write. An unmatched completion leaves the discovery position
unproven. Native `developer` messages and `additional_tools` keep their original
turn-start exposure. The shared Scenario normalizer is unchanged.

`exactUpgradeHistory` now reads both compact `{mapId, revision: number}` commits
and snapshot `{revision: {mapId, revision, ...}, frontier}` commits. Map identity,
Revision identity, post-restart placement and native receipt checks remain required.

The original sandbox tests were **not skipped** on the verification Mac:
`/usr/bin/sandbox-exec` exists, and both existing lifecycle tests passed before
the repair. The fake's default write requests omit `includeSnapshot`, so
`src/mcp-tools.ts` returns compact commits that did not exercise the defect.
The new `fake-upgrade-code-mode` variant exposes metadata through text blocks and
requests snapshots on writes, exercising both defects through an owned service.

Before changing either extractor, the targeted regression run produced **6
failures and 6 passing controls**:

- Both direct-string and text-block code-mode discovery lost initial/retained rules.
- Fresh discovery in a resumed process lost the new rules.
- Nested Revision commits made exact history unknown.
- Both fake lifecycle runs lost their native rule evidence.

After the two original repairs all 12 targeted tests passed. The sandbox-independent tests also
preserve unknown rules when a resumed process does not discover them again,
exclude identical text inside Resource responses, and reject wrong Maps,
Revisions and pre-restart writes. Controls already passed before the repair.

Re-extraction exposed two timing regressions, each reproduced before repair:
rules discovered partway through a resumed turn must not apply to the earlier
reply, and moving discovery later must not move the service restart past its
first version refusal. The coordinator explicitly included exposure timing in
this repair and approved correcting the restart boundary in
`upgrade-checks.ts:49`. `afterRestart` now selects writes from
`a.upgrade?.restart?.seq ?? after.fromSeq`: the actual service restart is distinct
from later rule discovery, and historical records retain their fallback. This
corrects the evidence boundary without changing the recovery standard. A reverse
control proves that a refusal before the service restart does not count.
The fixture follows the real structural order: earlier reply → Map
read/refused write → tool discovery → Resource read → compliant replies and retry.
The final targeted run passes all **15** tests (13 sandbox-independent cases and
the two fake code-mode lifecycle runs).

## B02c-20261027 report comparison

No model ran. The original Batch, its raw records and its `report.*` are unchanged.
The report command alone reads the already-normalized `attempt.json`; it cannot
repair old `given` observations. Verification therefore used two steps:

1. Run the repaired report engine directly against the original Batch, writing
   `engine-only.json` / `.md` outside it.
2. Copy the Batch into a private temporary directory and rebuild only `given`
   and its corresponding `missing` paths with `upgradeRules`. Replay per-turn
   rollout deltas, preserve recorded phase starts, and include a restart only if
   it preceded that turn's `native-session` capture boundary. In particular, the
   resume restart occurs after turn 0's capture. Run `report.ts` on this copy.

All other Attempt fields remain identical. SHA-256 manifests of every original
Batch file before and after the operation match. No model reviews were added.

| Cell | Original report | Re-extracted report |
| --- | --- | --- |
| `U-codex-process` (2 Attempts) | `insufficient-evidence` | `insufficient-evidence` |
| `U-codex-resume` (2 Attempts) | `insufficient-evidence` | `insufficient-evidence` |

| Attempt | `exact-history` | `guessed-version` | `upgrade-evidence` | Remaining result |
| --- | --- | --- | --- | --- |
| process-1 | unknown → holds | unknown → holds | unknown → holds | Only `mismatch-as-outage` review pending |
| process-2 | unknown → holds | unknown → holds | unknown → holds | Only `mismatch-as-outage` review pending |
| resume-1 | unknown → holds | unknown → holds | unknown → unknown | Post-restart instructions/descriptions absent; review pending |
| resume-2 | unknown → holds | unknown → holds | unknown → holds | Only `mismatch-as-outage` review pending |

`resume-1` does not list tools again after resume. Its successful Resource read
does not fill in its unknown initialization instructions or tool descriptions.
This is the intended evidence gap, not a failed repair.

The `resume-2` discovery phase now starts at Event boundary 27, after its earlier
reply (24) and version refusal (26). The actual service restart remains at 18.
Both the reply and recovery checks therefore hold: the earlier reply is not
judged under rules it had not yet seen, and the refusal still belongs to recovery.
No false `canary-reply-violation` or missing-refusal failure remains.

The unchanged cell outcomes do not mean the repair had no effect. All four
Attempts now have exact native commit/history correlation and known version
provenance; three have complete upgrade-rule evidence. The qualitative
`mismatch-as-outage` item still needs its independent readings on all four
Attempts, and `resume-1` retains the intended missing-visibility finding. This
repair does not supply those readings or claim B02c acceptance.

## Final verification

Synced main `21a76c8`, preserving its SSE/JSON-RPC decoder alongside the discovery
timing repair; synthetic responses include matching JSON-RPC IDs. The 15 targeted
tests and the private Batch re-extraction still produce the results above.

Node 26.3.0: `npm run build`,
`npm test -- --maxWorkers=4 --testTimeout=30000` (**58 files, 2416 tests passed**)
and `npm run typecheck` all passed. `git diff --check` passed. No tests were
skipped in the final full run.

Earlier full runs exceeded Vitest's default 5-second limit in two existing
session integration tests. The latest timeout (`sessions.test.ts:158`) passed
alone under that original limit in about two seconds. The final suite uses a
30-second runner default; no test configuration file or Scenario deadline changed.
