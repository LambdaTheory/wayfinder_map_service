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
