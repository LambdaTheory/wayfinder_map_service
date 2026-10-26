# B04 review follow-up

2026-10-26, PR #96. Both independent reviews were read in full: [Codex](https://github.com/kun-g/wayfinder_map_service/pull/96#issuecomment-6406776116) and [Claude](https://github.com/kun-g/wayfinder_map_service/pull/96#issuecomment-6406782441). All required findings were accepted. Latest `main` was fetched and merged before changes (`78299fc`, already incorporated); PR #94's branch was not merged.

## Required fixes and regression evidence

Each row was exercised against the previous implementation and failed, then passed after the fix. Tests are in [`capture/capture.test.ts`](../../tests/behaviour/capture/capture.test.ts); they use only synthetic records and disposable databases/services.

| Finding | Before | Fix and final assertion |
| --- | --- | --- |
| Read-only WAL open creates sidecars | A cleanly closed WAL database was accepted; sidecar-bearing sources were also opened | Inspect SQLite header bytes and sidecar names before opening SQLite; refuse all WAL and sidecar-bearing inputs with a private-copy requirement. Closed-WAL test confirms the source directory and database bytes are unchanged. Active WAL and all three sidecar suffixes are refused too. |
| Committed seed write loses its reply | Server reached Revision 2, saved seed boundary stayed 1 | Drop the HTTP reply after the real disposable service commits. Controller rereads the head, updates the boundary to 2 and still rejects setup. `agentRevisions` returns no agent writes. If that reread also fails, `runAttempt` uses the final exported head while seeding is incomplete; no agent turn has started. |
| Redaction audit reintroduces a declared secret | Both token chaining and a filename-preserving path replacement were accepted | Reject replacement strings containing any declared private literal; verify the entire bundle for declared literals before return. Both chained-rule regressions now refuse output. |
| Transient Claimant inferred from final Claimant | `acquire(A), release(A), acquire(B)` was accepted without evidence | A later Claim lifecycle command makes an acquire's Claimant ambiguous. Capture refuses it; an override with the documented original commands reproduces the Revision state and retains A and B. |
| Historical author collides with Controller role or active identities | Literal `controller` was accepted; active Controller/session ID collisions were not checked | Capture refuses source apply Revisions authored by the reserved `controller` label. Credential allocation checks the actual Controller/session client IDs before service launch. Regression cases cover the reserved source label and both collision classes. |
| README refuses supported history seeds | README still said history seeds were unsupported | README describes historical credentials and the recovered seed boundary; a regression rejects the obsolete refusal wording. |

The chained-redaction regressions were rerun against the pre-fix `capture.ts` after correcting their parameterized test wrapper, confirming actual acceptance of the unsafe rules rather than a fixture failure. The lost-response regression confirms the original setup exception remains observable; recovering attribution does not turn failed setup into success.

## Suggestions

- Shared [`seeds/steps.ts`](../../tests/behaviour/seeds/steps.ts) now supplies one pure visible-seed write plan to both capture verification and Controller seeding, including the Claimant and default Reference arrays.
- Built domain loading is lazy. The capture fixture builder uses that same build, and an isolated import test succeeds with no `dist/` present. Unused `digest`/`sampleHistory` exports were removed; seed operation names are explicit; redacted input and redaction variables no longer have misleading/shadowed names.
- Combination/Entry/effort use a shared conditions type; reproduction Entries use the existing `Entry` union, with explicit unknown allowed for the source Entry. Documentation uses “Revision state” rather than “snapshot” for a Revision.
- The capture inventory used by both CLI listing and validation discovers paused draft records, so they remain counted without fabricated executable Scenarios. F11's inherited flat trace and separate historical schema are documented as a deliberate exception.
- The generated Scenario includes its reproduction status in `source.refs`; added replay context is recorded as a conversion. F11's verification-only note was removed from its conversion steps.
- The history-head check now verifies title, Destination and Notes as well as Tickets and content. A forged head-response test proves a wrong title is rejected.
- F11 regeneration is described as a **public-fixture consistency check**. It cannot prove completeness of the original private-source redaction. That verification remains with the coordinator after integration, as explicitly required by this dispatch; no private-source read or new acceptance claim was made.
- Two independent reviews are present. No Release Version change is needed: only tests and documentation change.

## Validation and remaining integration

Node 26.3.0: `npm run build`, `npm test` (**19 files, 1,328 tests**), `npm run typecheck`, and `node tests/behaviour/cli.ts validate` (**26 Scenarios; 1 admitted capture, 0 paused drafts**) passed. The focused capture suite has **27 passing tests**. No real model ran; the everyday service was untouched.

PR #94 integration remains coordinator-ordered. Once it lands, combine its Controller observer with historical-author routing, log those calls as Controller events with their author label, retain lost-response boundary recovery, remove any remaining B04 history refusal, reconcile the README sentence and run its `sessions.test.ts` along with the full checks. This review-fix dispatch deliberately does not merge that branch or the PR.

## Second review round

2026-10-26: read [Claude's re-review](https://github.com/kun-g/wayfinder_map_service/pull/96#issuecomment-6407126744) and [Grok's re-review](https://github.com/kun-g/wayfinder_map_service/pull/96#issuecomment-6407473011). Both accepted the previous six corrections and identified the remaining final-output privacy gap. Merged latest `origin/main` (`480e0c4`, including PR #92, Release Version 2.1.0) before building or testing. PR #94 remains separate.

The privacy guard now walks actual strings and object keys recursively. It checks declared private literals and the path/credential patterns on the final bundle, after assembling the opening turn, conversion descriptions, references and redaction record. JSON escaping cannot hide a quote, backslash or control character from that check. Unsafe results are refused, with no secret copied into the error.

| Regression | Before | After |
| --- | --- | --- |
| `a"aa"a`, private literal `a"a`, replacement `a"` | Capture returned the surviving overlap; new test failed because no exception was thrown | Final string traversal rejects it |
| `line1` plus `line2`, private literal `line1\n\nline2` | Joining the opening formed the literal after redaction; new test failed | The completed opening is rejected |
| `Bearer` plus `tokentoken`, no declared rule | Joining the opening formed a credential after the original guard; new test failed | The completed opening matches the raw-string credential guard and is rejected |
| Committed historical write loses its reply, immediate reread also fails | Temporarily removing the final-export fallback made the new test fail: seed boundary 1, actual head 2 | With the existing fallback restored, boundary 2 is retained, setup still fails with the original exception, no agent turn starts and both attribution checks report zero agent writes |

The three requested privacy cases were added and run before the fix: **3 failed**, each because unsafe output was accepted. Additional passing cases cover a backslash overlap, a Windows private path and a tab-separated bearer credential. The fallback test exercises `runAttempt` through a disposable service and faults only HTTP transport; it substitutes a synthetic OS home for client-login discovery and uses the fake client executable. No real model or incident data is involved.

### Re-review suggestions

- **Unknown original conditions:** capture now records why Entry/effort unknowns keep non-reproduction comparison pending, in both `reproduction.reasons` and Scenario references. Two new tests failed before this addition and pass now; even matching `unknown` effort strings cannot establish an unchanged baseline.
- **Documentation and names:** replaced “audit log” with “redaction record”, called the synthetic source a database, removed stale totals from the maintainer guide, documented the shared seed plan and CLI capture inventory in the README, removed the `review:` test-name prefix and unified both capture references to a repository-relative path.
- **Backup entry point:** the guide now names the existing consistent backup command and links §10. No backup was performed on a real source.
- **Historical intermediate wording:** narrowed the guide's ambiguity claim. Multiple text updates within one Revision reconstruct its stored state, not every intermediate word; an evidenced override is needed when those words matter. The stronger Claimant ambiguity refusal remains intact.
- **Failure labels:** documented the current `service-failed` label for prelaunch identity collisions. A new Attempt completeness class would affect evidence consumers and is unnecessary for this capture correction.
- **Conditions shape:** simplified `originalConditions` to `{ entry; effort }`; retained the existing `originalCombination` field and capture schema rather than migrating input manifests only to regroup fields.
- **Command types (deferred):** B01 history commands are wire data (`unknown[]`), while domain `Command` uses branded IDs and domain-only shapes. The shared plan and replay boundary keep that distinction and validate through the domain/MCP; relabelling wire values as `Command[]` would require unchecked casts. A dedicated validated wire-command type is separate work.
- **Small duplicated checks (retained):** `expectedHead` projects the three Map text fields from wire history without widening the product API; the real-service mismatch test remains. The inventory validates untrusted JSON, including the historical `admitted` status that `CaptureRecord.library.status` cannot contain. Its short ID/status guards remain local; extracting runtime validators would broaden this review fix without changing its result.
- **Closeout and #94:** the PR references #71 without closing it. F11/private-source verification and any human acceptance remain with the coordinator after integration. Preserve both historical-author routing and #94's observation hooks, plus the reread and final-export boundaries, when that branch is integrated.

### Second-round validation

Node 26.3.0 on the branch merged with `main` at `480e0c4`: `npm run build`, `npm test` (**20 files, 1,357 tests**), `npm run typecheck` and `node tests/behaviour/cli.ts validate` (**26 Scenarios; 1 admitted capture, 0 paused drafts**) all passed. The focused capture suite has **36 passing tests**. `git diff --check` passed. This round changes only `tests/behaviour/` and documentation, so it keeps Release Version 2.1.0; no ChatGPT run is required for these test-tool changes. No real database or conversation log was read, no real model ran, and the everyday service was untouched.
