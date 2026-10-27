# Answer Desk workflow release

Refs #114. Release 4.0.0 implements the accepted Answer Desk workflow; it does not claim real-client or human acceptance.

## Rules and runtime surface

`docs/agents/exploration-mcp.md` remains the sole authored runtime guidance. The build now extracts five governed descriptions, including `map_wait`; initialization, Resource and Prompt use the same release. Both normal and tools-only definitions carry post-all-askable, unlock-first triage/reasons, short link announcements, delivery and the explicit verdict guard. The dedicated skill and launcher instructions adapt that method without supplying human answers.

There is one runtime surface: Answer Desk enabled and five tools. The old `answerDeskEnabled` / `WAYFINDER_ANSWER_DESK_ENABLED` input remains only as a migration check: omission and true enter the same surface, false refuses before listening, including on unused databases. This is stronger than the earlier used-database shutdown guard; no database can enter an unusable disabled state. Earlier release records describing default-off behavior are historical.

The key never enters the harness argv, environment, instructions or working directory. The launcher opens the selected Map before starting the MCP agent, using AppleScript stdin and a private service-owned key. It strips inherited `WAYFINDER_ANSWER_DESK_*` from the harness environment. New Maps use `wayfinder desk <mapId>` once their ID exists. Current Orca CLI has only argv URL input; the accepted fallback uses the same default browser and prints a keyless URL plus the reason. Safe Orca tab input remains Refs #145; no exchange-code endpoint or HTML capability file is added.

The domain decoder's existing default-on desk syntax is now consistent with the sole runtime surface. Taking still does not settle. A deterministic tools-only MCP test takes option 2 at turn start and settles it with its citation, claims the dependent Ticket and posts its question in one Revision.

## Verification and acceptance limits

On 2026-10-27 with Node 26.3.0, `npm run build`, `npm run typecheck` and `git diff --check` passed. The full `npm test -- --maxWorkers=2` run passed all 57 files / 2,384 tests (343.09 seconds). A final capture-message update also passed its focused 2 files / 67 tests; the launcher/process isolation checks passed 2 files / 56 tests. These tests use isolated storage, ephemeral ports, fixed evidence and fake harnesses.

Build tests pin each mandatory desk passage on its governed tool in both surfaces, rather than relying on instructions that ChatGPT cannot see. W7 v2 checks five questions, triage, short announcements, client delivery choice and a takeover/scope question that must not withdraw or settle anything. W1 v2 removes the chat batch cap. Fixed drivers and wire checks understand both JSON and SSE; current snapshots require five tools, while historical four-tool captures remain readable and are still compared against the observed definitions.

No real model, client session, behavior Batch, ChatGPT, tunnel, everyday service or real database was used. W7's scripted Controller does not submit desk answers; the actual delivery journey belongs to approved interactive acceptance. Older chat-proposal reply cues need desk-aware conversion before they can count as 4.0.0 acceptance. B04 desk-history conversion is explicitly deferred below, never treated as a silent successful capture.

The coordinator owns: review, the approved behavior Batch, the real wide Map, Claude task wake-up/Codex blocking completion, ChatGPT turn-start taking and the decision whether to merge before deferred ChatGPT acceptance. Kun is not using ChatGPT for the next one or two weeks; the acceptance remains required pending his explicit merge-gate decision. The first everyday startup on 3.2.0 or later migrates format 1 one way to format 2 after its retained backup; this work performed no such everyday startup.

## Review follow-ups, item by item

The source comments were read from PRs [140](https://github.com/kun-g/wayfinder_map_service/pull/140), [141](https://github.com/kun-g/wayfinder_map_service/pull/141), [142](https://github.com/kun-g/wayfinder_map_service/pull/142) and [143](https://github.com/kun-g/wayfinder_map_service/pull/143), including review bodies and inline comments. Items already corrected in those PRs remain covered by their existing tests; this table records the remaining dispositions without reopening settled implementation choices.

| Source / item | Disposition |
| --- | --- |
| #140 modern headers, relay parity, factory propagation, rejected-version no publication, deprecated task-marker difference, SSE/progress, named task headers | Already implemented in #140/#143. Preserved the shared factory/relay and per-era tests; updated fixed parsers for default SSE. |
| #140 ChatGPT modern connectivity, `-32020` fallback and everyday deploy timing | Still unverified; retained explicit CHANGELOG caveat and coordinator's deferred ChatGPT/upgrade gate. |
| #140 optional Cookie/custom-header/Set-Cookie filter regression | Deferred to relay regression maintenance; current allowlist unchanged. |
| #141 direct-embed/used-database disable guard and decoder default | False is now refused even for unused storage and direct embedders. Default-on decoding matches the sole surface. |
| #141 lost taking receipt, stale request release, active-question update guard, request coverage and publication index | Already documented/tested in storage and delivery; no changes to those guards. |
| #141 request-level citation errors reported at command index 0 | Deferred to a focused diagnostic-contract change; do not silently alter published rejection shapes in workflow text. |
| #141 repeated desk command-kind lists, transaction/item duplication, Question Version numeric-validator naming and storage error-shape differences | Deferred to domain/storage cleanup. They do not change the mandatory client sequence; Question Version remains distinct from Revision. |
| #141 `mock.module` deprecated `namedExports` | Replaced with `exports` in the attach helper under Node 26.3.0. |
| #141 B04 capture of selected history with desk commands, citations or request-close Revisions | Deferred to a dedicated capture conversion slice. The current seed model does not preserve mutable response provenance or citation bindings; keep explicit refusal and update its obsolete “until #114” message. No revisions are skipped or renumbered. |
| #142 launcher platform/failure guidance and fragment lifetime wording | Platform guard and private stdin handoff already fixed; current documentation records keyless output and Orca fallback. More granular timeout/refusal wording remains optional launcher maintenance. |
| #142 optional browser matrices: withdrawal rows, valid 3/t controls, native focus, POST-versus-displayed-ID/version across every matrix | Deferred to viewer regression maintenance; preserve existing Chromium matrices and independent review evidence. Native focus belongs to real-browser acceptance. |
| #142 intermediate click-before-every-answer suggestion | Superseded by the later accepted continuous-keyboard implementation. Do not restore the abandoned behavior. Initial cards stay paused; the real gate includes window switching and refocus. |
| #142 final Claude suggestion 1: failed text submission lifts pause | Deferred to viewer follow-up; current target stays visible, but an uncertain committed text answer could be replaced by a later Enter. Include in the wide-Map acceptance notes. |
| #142 final Claude suggestion 2: answering during refocus leaves the next question paused | Deferred to viewer follow-up; fails safe and may need a manual selection. |
| #142 final Claude suggestion 3: pending-refocus selection versus “arms at once” wording | Deferred to the same viewer follow-up for a reviewed specification clarification. Existing implementation record explains the freshness read and delay; no new semantic decision is claimed here. |
| #142 600 ms shortcut guard | Unchanged. Kun evaluates the delay on the real wide Map; no synthetic timing result substitutes for that judgement. |
| #143 taking-read effects, governed descriptions and stale four-tool spec rows | Implemented in this release, with build assertions and updated P01/L01/§14.2. |
| #143 original already-Answered disconnect ordering and dual-clock test trap | Existing disconnect regression retained; extra ordering coverage deferred to delivery test maintenance. Tests added here use one controlled clock for take/settle/post. |
| #143 explain disconnect cancellation | Added the no-resumable-response rationale to the delivery implementation record. |
| #143 1,000 retained-task cap, finished-task cancellation semantics, shutdown `tasks/get` 503 | Deferred to a task-lifecycle slice with protocol tests; no eviction that would silently change result-recovery lifetime here. HTTP during shutdown can return 503 rather than expose the in-memory failed task. |
| #143 taking before inspection / unknown receipt | Retained the specified durable Taken recovery through current read; optimization deferred. |
| #143 every legacy call uses SSE | Fixed drivers and wire tests now decode it; actual Codex handling remains a live-client gate. |
| #143 task owner credential representation/direct embedding, duplicated cancellation/error paths, readiness clocks, timeout constants, admission naming | Deferred to delivery internals maintenance; the production HTTP service still owns one shared coordinator and authenticated task ownership. |
| All four PRs: overlapping release numbers and integration | 4.0.0 is the single package/lockfile/workflow Release Version; coordinator tags main only after merge. |

Rule placement follows agent-workflow-principles mode C: project-authored workflow → generated tool/instruction surfaces; deterministic guards remain in the service; human judgement stays with Kun. Build assertions measure surface coverage, W7 measures all-askable/non-verdict behavior, and real-client gates measure delivery/pace. Those behavioral measures are unmeasured until the approved runs.
