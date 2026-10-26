# B02d shared-sandbox alignment

2026-10-26 · PR #95 / Issue #68 · integrated main `472df50` (PR #94 plus #103/#105). Tests and documentation only; Release Version remains 2.1.0 under MCP/SQLite specification §14.3. This is model-free runner verification, not Dedicated onboarding or product acceptance.

## Shared implementation

Dedicated now calls `prepareSandbox`, `prepareClient`, `writeProfile` and `verifyProfile` from #94's sandbox module. Its appended Seatbelt text, separate directory-tree manifest and generic pin closures are removed. The shared profile protects these inputs:

| Input | Shared protection |
| --- | --- |
| Sandbox policy | Exclusive file in the registered control directory outside scratch; hash checked before/after turns |
| Actual launcher, templates, shim, projected Skill checkout | Separate immutable staging children under `readOnlyRoots`; original bytes, content hashes, entry/ancestor identity checks and write denial |
| Copied login | `mutableReadOnlyFiles`: literal read only, one regular-file link, fixed inode/device and parent identities; trusted in-place refresh remains valid |
| Launcher state and directory entries | `denyWriteRoots` / `denyWritePaths`, including installed context files before they exist |

Only Dedicated-specific checks remain in its module: expected installed context, actual Skill-link installation, native auth-link/regular-refresh semantics, and evidence collection. An integrity failure stops the Attempt; if refreshed credentials cannot be collected safely, that turn's streamed/native evidence is withheld and the missing fields are recorded. Profile/manifest evidence survives cleanup.

The real launcher's unchanged bytes are staged with its templates and invoked with absolute isolated Python. The projected checkout has no service build. The shared service stores Controller/history credentials in its reloadable file, so Dedicated registers their runner-owned lifetimes with the real launcher's pruning mechanism; this keeps resume and final catalog export working without reverting #94's credential isolation.

MCP-only retains its relay, streamed events, concurrent/fresh-session handling, Controller fault actions, conservative receipt correlation, synthetic login injection and cleanup. Dedicated still supports one sequential native session and explicitly refuses unsupported Controller/multiple-session cases; it connects to its own service using the real launcher's credential and Client ID. No local proxy exception was introduced; #101 owns the restricted channel.

## Reproductions and checks

- `sandbox-denials.test.ts`: both an absent deny-only subtree and an absent literal file reached through an existing symlink failed before the change with `ENOENT` during policy creation. After the shared canonicalizer resolves existing links and retains missing targets/ancestors as denials, both pass under real `sandbox-exec`: trusted creation succeeds, writes via canonical and alias paths fail with EPERM, an unrelated writable sibling still works, and integrity checks accept trusted creation.
- `dedicated.test.ts`: 19 model-free checks retain S0b resume, real Map receipts, installed-context evidence, separate Entry metadata, failed installation, cross-turn shim/PATH/service-build/profile planting, source-login and native-link attacks, refresh redaction, timeout/refusal cleanup and safe binary artifact capture. All login/configuration inputs are now explicit synthetic fixtures; reserved-port socket probes were removed.
- `dedicated-security.test.ts`: 10 checks exercise the real launcher/shared policy. TIOCSTI through stdin or `/dev/tty` returns EPERM and never makes the disposable outer shell create its marker. Own-terminal read/write, window/attributes/raw mode and new-pty allocation work; outside/same-profile/other-profile peer ptys stay denied. Native Mach/process information and signal 0/SIGTERM are denied for owned outside and peer processes, while self/children remain available and global child enumeration remains denied. Owned listeners have successful unsandboxed controls; Dedicated permits only its own IPv4 service and refuses other local ports, mapped IPv4/IPv6 and a synthetic local proxy. HOME, launcher HOME and mutable-login hard-link substitutions fail before launch; a trusted immutable-file fault is caught after the turn.
- Existing shared security tests also pass. All native probes reuse #94's C fixtures; there is no Dedicated policy copy. Developer-tool discovery uses `xcode-select -p`.

Validation on Node **26.3.0** after `npm ci`: `npm run build`, full `npm test` (**37 files / 1,863 tests, none skipped**), `npm run typecheck` and `git diff --check` pass. No temporary private-file protection/interception was used.

No real model or real Codex/Claude client ran. Tests used synthetic logins and personal configuration, disposable cache databases, and fixture-owned processes/listeners/ptys. No credential contents from personal stores or real database were read, no socket connection to 18765/18766 was made, and only fixture-owned processes were signalled. The existing untracked `.review-response-95.md` handoff draft was preserved. The separate, approved real-session onboarding Batch and independent review/merge remain with the coordinator; this branch is not merged.
