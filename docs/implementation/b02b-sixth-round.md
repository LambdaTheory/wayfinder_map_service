# B02b sixth-round verification

2026-10-26 · Issue #66 · PR #94 · Node 26.3.0 · macOS Seatbelt.

Merged requested main `7b1a04b` in `d31dfd1`, implemented this round in `a7505e7`, then merged the newly available main `c89262b` (#103) in `4f775a4`. Only behaviour-test infrastructure and documentation changed; the Release Version stays 2.1.0 under `docs/spec/mcp-sqlite.md` §14.3. No product rule or Scenario contract changed.

## Reproductions and fixes

| Boundary | Before the fix | After the fix |
| --- | --- | --- |
| Controlling terminal | Native `forkpty` probe could not read or write its `/dev/tty` (`ownRead=0`, `ownWrite=0`). | Literal read grant permits both operations (`1`, `1`). |
| Other same-user terminal | The same probe could open and write its second synthetic pty (`peerWriteError=0`). | Device writes are limited to `/dev/null`, `/dev/tty`, `/dev/dtracehelper`; the other pty returns EPERM for read and write. |
| Mapped IPv4 sockets | `::ffff:0.0.0.0` reached the owned direct HTTP listener; a mapped address also reached the relay. | Shared reviewer/runner denial rules block all outbound IPv6 TCP. The relay exception is `tcp4` only. Native socket probes return EPERM for `::ffff:127.0.0.1`, `::ffff:0.0.0.0`, `::1`, and `0.0.0.0` against owned listeners. IPv4 relay requests still succeed and replace forged Authorization. Every target has an unsandboxed positive control. |
| Own child process information | `proc_pidinfo` returned zero bytes for the client's child. | `process-info*` permits self and same-sandbox targets; child information is available. Outside processes and independent sandbox instances, using either the same or a different profile, return zero information. Mach statistics and signalling boundaries still pass. |
| Launch evidence | Host cleanup removed `launch.jsonl`. | It is copied to `raw/launch.jsonl`, listed in the capture, and retained even when a manifest integrity check fails. |
| Exit classification | Exit 7 or SIGTERM replaced operator `complete` with `driver-failed`; no launch could still become `complete`. | Exit code/signal remain evidence. Missing start or pre-spawn launch refusal becomes `launch-failed`; missing exit evidence or control-integrity failure remains `driver-failed`. |
| Codex staging freshness | A source update after host setup was invisible to the client. | Setup creates an empty 0600 file; the trusted launcher copies current opaque bytes immediately before starting the client, preserving the pinned inode. Tests assert 0600 before and after launch. |

All three mandatory isolation regressions failed under the previous policy before fixes. Separate failing tests also reproduced missing launch evidence, wrong exit classification, stale login content, and denied own-child information. Final tests pass under real `sandbox-exec`; the host integration fixture now executes `launch.ts` with a fake client instead of only synthesizing host state.

## Deliberate limit

The same-sandbox `process-info*` grant does **not** make `proc_listchildpids` work: this uses a global PID-list operation that remains denied. The unsandboxed control finds its own child, while the sandboxed probe does not. The test records this limit rather than enabling global process enumeration and weakening the existing isolation. Clients can inspect children whose PIDs they already own. Full client compatibility remains part of the approved interactive probe.

## Other review suggestions

- Native Mach/pty regressions skip when Apple Clang is absent or unavailable.
- The README distinguishes B02b's in-memory immutable hashes from B09b's protected, digest-pinned `launch.json`; it names B09b as an existing user of the shared API and mutable read-only login grants.
- Recovery instructions identify the retained mode-0600 staged login and any refreshed copy, and require deleting them with scratch after recovery.
- The excluded-key assertion scans the entire manifest. Launch hashing reuses `interactive/reviews.ts`'s `digest`.
- Fresh isolated-HOME, no-login `--version` checks returned `codex-cli 0.164.0` and `2.1.310 (Claude Code)`, both exit 0. These checks establish only startup, not authentication, model access or interactive behaviour.

## Final checks

On the branch including main `c89262b`:

- `npm ci` completed at the start of the round.
- `npm run build` passed.
- `npm test`: **32 files, 1,769 tests passed**.
- `npm run typecheck` passed.
- `git diff --check` passed.

No model calls, real credential contents, protected private paths, daily service operations, real database access, or socket probes to 18765/18766 were used. Existing pending real-model Batches and interactive probes remain coordinator-owned and require their existing approvals. PR #94 remains unmerged.
