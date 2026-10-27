# B02d credential and evidence boundary

2026-10-26 · PR #95 / Issue #68 · follow-up to the [shared-sandbox alignment](b02d-shared-sandbox-alignment.md). The regression baseline was `e2d0c9b`, already containing main `472df50`. These changes affect the test runner and documentation only; Release Version remains 2.1.0 under MCP/SQLite specification §14.3. This record covers model-free verification, not real-session onboarding.

## Credential handling

The real launcher's degraded-authentication fallback could return its primary token, which the runner had set to the Controller credential. The credential-owner check alone accepted that token because the Controller is a registered owner. The private shim rejects the Controller's hash explicitly before recording or executing a client launch. Issue #101 additionally replaced the launcher's primary file with a separate probe credential, rejected that credential's hash as client fallback too, and separated trusted direct service probes from the sandboxed client's proxy environment; the Controller token now stays in runner memory. Healthy per-launch credentials remain accepted; no shipped launcher change is needed.

Both Entries now use `runner/artifacts.ts` to copy retained files. The shared redactor applies to directory and file basenames as well as file contents, including binary bytes. Collisions receive deterministic `.redacted-N` suffixes instead of overwriting files or merging directories. Symlinks and `node_modules` are omitted, and the shared sandbox helper checks regular files and their single-link requirement before reads.

Dedicated no longer retains raw SQLite databases, journals or failed-export database directories. Map text and historical/free SQLite pages can contain client credentials, so patching database bytes would not provide a safe, valid export. The runner retains only the structured, redacted `maps` history and always records `raw.database` as missing. Export failure additionally marks `maps` missing and makes the Attempt `driver-failed`; cleanup still removes the disposable database.

## Integrity and evidence

The duplicate Dedicated directory list, identity/hash implementation, error alias and artifact-copy implementation are removed. Shared sandbox helpers own file type/link checks, identity including mode, hashing and pinned-parent evidence reads. Dedicated keeps only checks of launcher-installed text and native authentication semantics; output leaf directories are its explicit path denials beyond shared ancestor protection.

A post-turn integrity failure preserves the runner-owned launch record when its pinned parents and regular file can still be verified. The record reports the actual launch count and safe process result. Unsafe streamed/native evidence, work/output files and Map export are withheld because refreshed credentials may no longer be discoverable safely. Missing markers identify these gaps; an unreadable or absent launch record has its own missing marker. Stream finalization happens before discarding the affected turn, so pending tool arguments cannot reintroduce withheld bytes.

The personal-configuration snapshot now includes `.codex-wayfinder/AGENTS.md`, `.wayfinder-service/credential-owners.json` and `.wayfinder-service/wayfinder-token`. Model-free tests supply a synthetic configuration root. The runbook describes acceptance requirements without coordinator handoff notes.

## Regression evidence

All six new cases in `dedicated-privacy.test.ts` failed against the baseline before implementation:

| Regression | Before | After |
| --- | --- | --- |
| Healthy service followed by degraded per-launch authentication | Fake client launched with the Controller token | Healthy launch succeeds; degraded fallback is refused before client execution |
| Credential-bearing artifact filenames and directories, including placeholder collisions | Literal credentials survived in retained paths | Paths and bodies are redacted; every colliding payload survives separately |
| Credential-bearing Map text, successful catalog export | Raw SQLite copy retained credentials | Redacted Map history retained; raw database absent and removed |
| Credential-bearing Map text, failed catalog export | Raw SQLite copy retained credentials | Database removed; export and database gaps explicit |
| Post-turn auth-link substitution | Safe launch record silently lost | Safe launch count retained; unsafe evidence marked missing |
| Additional launcher-written snapshot paths | Changes were invisible | Every synthetic path changes its fingerprint |

Strengthening the post-turn case with an undiscoverable synthetic refresh value in work files, Map text and pending tool arguments exposed another failure before the withholding fix. The final test verifies that none of those bytes survive in retained files. The tests use the unchanged real launcher and actual `sandbox-exec` for client behavior, with synthetic logins, a fake client and an isolated service. Only the snapshot check is an ordinary runner-side unit test. The catalog-failure branch injects an export failure while leaving launcher, sandbox and Map persistence real.

The two existing deny-only canonicalization tests additionally exercise case aliases on case-insensitive filesystems, literal `..`, symlink-then-`..`, and hard-link creation. Under real Seatbelt, protected targets remain unwritable before and after trusted creation while an unrelated sibling stays writable.

Validation with Node **26.3.0**, after `npm ci`: `npm run build`, `npm test` (**38 files / 1,869 tests, none skipped**), `npm run typecheck` and `git diff --check` pass. The existing Dedicated terminal, process, network, HOME and control-file attack tests remain green. Local proxies remain fail-closed; #101 owns the restricted channel.

No real model or real Codex/Claude client ran. Tests used synthetic configuration and credentials, disposable databases, and fixture-owned processes/listeners/ptys; no real credential or database contents were read, no connection to ports 18765/18766 was made, and only fixture-owned processes were signalled. Real-session onboarding still requires a separately approved Batch.
