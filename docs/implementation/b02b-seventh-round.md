# B02b seventh-round verification

2026-10-26 · Issue #66 · PR #94 · Node 26.3.0 · macOS Seatbelt.

This round addresses Independent re-review 6 (Claude), alongside the passing Codex review, from base `3dfb1e2`. Changes remain in behaviour-test infrastructure and documentation. No product rule or Scenario contract changed; the Release Version stays 2.1.0 under `docs/spec/mcp-sqlite.md` §14.3.

## Terminal regressions

Every probe uses generated profiles and real `sandbox-exec`. Only disposable ptys, shells, marker files and processes created by the tests are involved.

| Probe | Before the fix | After the fix |
| --- | --- | --- |
| TIOCSTI through inherited stdin and `/dev/tty` | In both cases a fake client launched through `launch.ts` injected a marker command. A disposable unsandboxed Bash, created with `forkpty`, consumed that input after the launcher exited and created a file that the client itself could not write (direct open returned EPERM). | `(deny file-ioctl (ioctl-command TIOCSTI))` rejects every injected byte with EPERM; no marker appears. |
| Normal controlling-terminal operations | Existing own-terminal read/write worked. | Window-size ioctl, `tcgetattr` on stdin and `/dev/tty`, raw-mode switching and own-terminal read/write all succeed with the injection deny enabled. An outside same-user pty still rejects read and write. |
| Descriptor aliases | All six sandboxed commands failed with EPERM, while unsandboxed controls worked. | Redirects to `/dev/stderr`, `/dev/stdout`, `/dev/fd/1`, `tee /dev/stderr`, `cat /dev/stdin` and `cat <(echo hi)` succeed with exact expected output. Grants cover only the standard aliases and numeric `/dev/fd/N`. |
| New pty allocation | `openpty` failed, and `script` under a real controlling tty reported `openpty: Operation not permitted`. | Explicit `pseudo-tty`, literal `/dev/ptmx` and the `com.apple.sandbox.pty` extension permit allocation, reopening and bidirectional I/O. Outside-created and peer-sandbox ptys, including peers loading the identical profile, still reject read and write with EPERM. `script` can execute a synthetic tool. |

The new terminal suite initially had ten failing cases. After fixing the script test's controlling-terminal setup, its remaining failure was confirmed as Seatbelt denying `openpty`, with an unsandboxed positive control. All terminal cases and prior process/network isolation checks now pass.

## Launch and outcome regressions

`launch.ts` reserves `launch.once` using an exclusive, mode-0600 write before reading login bytes or spawning a client. Refusal also consumes the Attempt. A repeated command, whether concurrent, after exit, or after an authentication refusal, records a duplicate refusal and starts no second client. Duplicate refusals remain evidence without changing the first valid launch's outcome. The client cannot read or alter the marker.

Host capture requires a start record for `complete`, `precondition-not-met`, `rate-limited`, `timeout` and `cancelled` after exposing the command. Missing start becomes `launch-failed`; multiple starts become `driver-failed`. Outcomes backed by a valid start retain their declared classification. Existing exit-code/signal evidence, missing-exit checks, control-integrity failures and recovery retention remain intact.

Nine focused launch/host cases failed before these changes: three repeated-launch cases, four no-start non-complete outcomes, a repeated host command and a duplicate-start log. All now pass with real fake-client launches through Seatbelt. Additional controls preserve the four non-complete outcomes when a start is present.

## Documentation and limits

- Global PID enumeration and `proc_listchildpids` remain denied. The approved interactive probe checklist now explicitly requires cancelling a turn and observing that its known tool processes exit; missing child enumeration is not cleanup evidence.
- Native tests use `xcode-select -p` to detect developer tools without invoking the clang/xcrun installation shim at discovery time.
- Device documentation describes TIOCSTI denial, descriptor aliases and pty extensions. The sixth-round record now accurately calls its network checks Node TCP socket probes.
- No actual Codex or Claude binary was run this round. No model, real credential contents, daily service, real database, or connections to 18765/18766 were used. All signalled processes belonged to these fixtures.

## Final validation

`npm run build`, `npm test` (**33 files / 1,792 tests passed, none skipped**), `npm run typecheck` and `git diff --check` passed on Node 26.3.0. The PR remains unmerged; separately approved real-client probes remain coordinator-owned.
