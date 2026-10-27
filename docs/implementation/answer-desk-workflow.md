# Answer Desk workflow release

Refs #114. Release 4.0.0 implements the accepted Answer Desk workflow; it does not claim real-client or human acceptance.

## Rules and runtime surface

`docs/agents/exploration-mcp.md` remains the sole authored runtime guidance. The build now extracts five governed descriptions, including `map_wait`; initialization, Resource and Prompt use the same release. Both normal and tools-only definitions carry post-all-askable, unlock-first triage/reasons, short link announcements, delivery and the explicit verdict guard. The dedicated skill and launcher instructions adapt that method without supplying human answers.

There is one runtime surface: Answer Desk enabled and five tools. The old `answerDeskEnabled` / `WAYFINDER_ANSWER_DESK_ENABLED` input remains only as a migration check: omission and true enter the same surface, false refuses before listening, including on unused databases. This is stronger than the earlier used-database shutdown guard; no database can enter an unusable disabled state. Earlier release records describing default-off behavior are historical.

The key never enters the harness argv, environment, instructions or working directory. The launcher attempts to open the selected Map before starting the MCP agent, using AppleScript stdin and a private service-owned key. It strips inherited `WAYFINDER_ANSWER_DESK_*` from the harness environment. A missing desk/key, wrong Map ID, unsupported OS or browser failure never stops agent startup: one keyless line points to `wayfinder desk <mapId>`. The explicit `desk` command still fails when it cannot open. New Maps use that command once their ID exists. Current Orca CLI has only argv URL input; the accepted fallback uses the same default browser and prints a keyless URL plus the reason. Safe Orca tab input remains Refs #145; no exchange-code endpoint or HTML capability file is added.

The domain decoder's existing default-on desk syntax is now consistent with the sole runtime surface. Taking still does not settle. A deterministic tools-only MCP test takes option 2 at turn start and settles it with its citation, claims the dependent Ticket and posts its question in one Revision.

## Verification and acceptance limits

On 2026-10-27 with Node 26.3.0, `npm run build`, `npm run typecheck` and `git diff --check` passed. The full `npm test -- --maxWorkers=2` run passed all 57 files / 2,384 tests (343.09 seconds). A final capture-message update also passed its focused 2 files / 67 tests; the launcher/process isolation checks passed 2 files / 56 tests. These tests use isolated storage, ephemeral ports, fixed evidence and fake harnesses.

Build tests pin each mandatory desk passage on its governed tool in both surfaces, rather than relying on instructions that ChatGPT cannot see. W7 v3 checks five questions, triage, short announcements, client delivery choice and a takeover/scope question that must not withdraw or settle anything. W1 v3 rejects blanket conversation assent before accepting two keyed desk answers and requiring same-write advancement. Fixed drivers and wire checks understand both JSON and SSE; current snapshots require five tools, while historical four-tool captures remain readable and are still compared against the observed definitions.

No real model, client session, behavior Batch, ChatGPT, tunnel, everyday service or real database was used. W7 keeps questions Pending; W1, W4 and W6b now submit scripted answers through the real keyed HTTP route. Fixed-driver evidence does not replace live delivery acceptance. The audited conversation/desk routing and scenario versions are recorded below. B04 desk-history conversion is explicitly deferred below, never treated as a silent successful capture.

The coordinator owns: review, the approved behavior Batch, the real wide Map, Claude task wake-up/Codex blocking completion, ChatGPT turn-start taking and the decision whether to merge before deferred ChatGPT acceptance. Kun is not using ChatGPT for the next one or two weeks; the acceptance remains required pending his explicit merge-gate decision. The first everyday startup on 3.2.0 or later migrates format 1 one way to format 2 after its retained backup; this work performed no such everyday startup.

## Review follow-ups, item by item

The source comments were read from PRs [140](https://github.com/kun-g/wayfinder_map_service/pull/140), [141](https://github.com/kun-g/wayfinder_map_service/pull/141), [142](https://github.com/kun-g/wayfinder_map_service/pull/142) and [143](https://github.com/kun-g/wayfinder_map_service/pull/143), including review bodies and inline comments. Items already corrected in those PRs remain covered by their existing tests; this table records the remaining dispositions without reopening settled implementation choices.

| Source / item | Disposition |
| --- | --- |
| #140 modern headers, relay parity, factory propagation, rejected-version no publication, deprecated task-marker difference, SSE/progress, named task headers | Already implemented in #140/#143. Preserved the shared factory/relay and per-era tests; updated fixed parsers for default SSE. |
| #140 ChatGPT modern connectivity, `-32020` fallback and everyday deploy timing | Still unverified; retained explicit CHANGELOG caveat and coordinator's deferred ChatGPT/upgrade gate. |
| [#140 final Claude E](https://github.com/kun-g/wayfinder_map_service/pull/140#issuecomment-6433491088): stale authenticated-HTTP audit pointers | Resolved here: shared-sandbox-proxy.md now points to the current direct transport and `LOCAL_SERVICE_OPENER`, records 3.3.1 resolution, and distinguishes the later keyed viewer write. |
| [#142 first Claude](https://github.com/kun-g/wayfinder_map_service/pull/142#issuecomment-6435026422): Reopen-dialog initial focus | Deferred to viewer accessibility maintenance; no focus behavior changed in #114. Include keyboard entry in wide-Map acceptance. |
| #142 first Claude: redisplay a changed affected list | Deferred to viewer recovery UX maintenance. Server refusal remains authoritative; follow-up should redisplay the new affected list without filing or silently widening authorization. |
| #142 first Claude: second read for `quietUntil` in `inspectViewerDesk` | Deferred to viewer/storage snapshot consolidation. Preserve the response schema and verify Map/desk consistency if combining the reads; no optimization claimed here. |
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


## Second-round scenario audit (2026-10-27)

Second-round verification on Node 26.3.0: `npm run build`, `npm run typecheck`, and `git diff --check` passed; `npm test -- --maxWorkers=2` passed **57 files / 2,390 tests** (363.17 seconds). Final focused verification passed **5 files / 254 tests** (68.02 seconds), including real domain W7 fixtures, both scripted human response paths and launcher failures. Only fake clients and disposable local services were used.

The Controller resolves exact Pending question IDs/versions from the service's desk view. It captures the displayed options as `script-human` evidence; for concrete desk verdicts it uses one keyed `POST /api/desk` per question, then observes the real 15-second Quiet Window before the next client turn. No agent receives the key, key path, or keyed URL in argv/environment/instructions/work files. The key lives beside the isolated service credentials, outside the client sandbox, and is removed during cleanup. Read-only and script-human actions never fabricate agent receipts or Settlements. ChatGPT `begin` uses the same path and prints only the conversation input.

| Scenario / current version | Previous scripted response or chat dependency | 4.0.0 treatment |
| --- | --- | --- |
| W1 v3 | “都按你的推荐。”; carrier/entry words in chat | Retain that line as a non-verdict with both questions Pending. Then Controller selects each displayed recommendation on the desk; only the resulting answers settle. Require the dependent publication in the final prerequisite's write. |
| W2 v2 | “第一个按你说的定，第二个我还要再想想。”; numbered chat proposals | Partial verdict remains in conversation. Controller names task-carrier, question/version and its actual displayed option verbatim, leaving task-entry open. Positive gate-2 control requires `answered in conversation` withdrawal before Settlement in the same Revision. |
| W4 v3 | “可以，按你说的改。”; plain-text/card words in chat | Controller answers agent-ask on the desk, then separately answers newly published result-notice. See the confirmed semantic change below. |
| W6b v2 | “可以”; no-category words in chat | Controller selects the displayed no-category recommendation on the desk; chat only says the desk is answered. |
| S0b v1 | Destination/scope cue; “只用考虑飞书…其他按你的推荐。” | Retained in conversation: no Map/Ticket exists yet. Its existing blanket-assent guard still forbids Ticket Settlement. No version change. |
| S5 v2 | Claim cue; “那个会话早就关了，没人在做，你接手吧。” | Keep takeover permission in conversation. After clearing the Claim, expect the carrier proposal on the desk. |
| S6 v1 | Conflict/Revision cue; “看到了新的版本，按现在的图继续推进。” | Keep in conversation: this is a new request after Conflict, not a Ticket verdict. No version change. |
| S9 v2 | carrier/fields cue; “用多维表格。字段映射我还没想好，先别定。” | Keep the partial conversation answer and original boundary; require an active carrier/fields desk question instead of a chat proposal. Preserve the answered part without inventing fields. |
| S10 v1 | Two-Map cue; “是 feishu-access-20261022 那张。” | Keep Map identification in conversation; no identified Ticket exists yet. No version change. |
| S14 v2 | “按你的推荐” → “接着推进” → “按你的推荐”; chat recommendation/permissions cues | Keep every line in conversation with Pending carrier/entry questions. None names a specific displayed answer; no withdrawal or Settlement, and guide to desk confirmation. |
| S15 v2 | Prototype cue; “如果两个选项我都不喜欢呢？” | Keep the follow-up question in conversation; gate on the active prototype desk question and judgeable artifact, then expect the explanation and an open/re-posted desk question. |
| S2 v2 | Blanket delegation before any proposal; three-question chat expectation | Establish Pending desk questions first, retain blanket delegation in conversation, reject Settlement and link to desk confirmation; remove the obsolete cap. |
| S3/S4/S8 v2 | Model criteria required task-carrier proposals in the reply | Read proposals from desk publications, preserving Notes/hearsay/exclusion guards; no scripted verdict added. |
| S7/W3 v2 | Model criteria required the dependent proposal in the reply | Read the evidence-informed dependent proposal from desk publications, with a short chat link. |
| W7 v3 | Historical post and Ticket-ID matching mistaken for a live question | Match `change.subjectId` to the publication's question ID, then its Ticket; require an active open publication immediately before the non-verdict input. No scripted answer. |
| S0/S1/S11/S12/S13/W5/W6/F11 (unchanged) | Clarification, scope/reopen request, deletion boundary, small question, outage, handoff or F11's permission question | Retain conversation inputs: none is an ordinary scripted answer to a newly displayed Ticket recommendation. Existing mandatory workflow still governs any new desk publication. |

**Confirmed semantic change — W4:** the former one chat reply both approved agent-ask and re-settled result-notice. A desk answer is bound to one question. The design session confirmed the two-answer sequence via the coordinator on 2026-10-27: agent-ask's options/whyKun must name reopening result-notice and the intended new answer; its Taken answer authorizes that reopen. The reopened result-notice question mentions agent-ask and recommends that same change. Only its own fresh Taken answer permits its Settlement. The scenario checks premature reopen/Settlement, cross-question citations and recommendation continuity. S2/S14's active-question setup and refusal of blanket assent follow the same design clarification; W2 makes the partial reply's intended question explicit and supplies the requested positive conversation control.

All modified verdict definitions increment their Scenario version; old Attempts remain bound to their recorded version and are not re-judged. The library remains 26 scenarios. S0b/S6/S10 and the unrelated conversation cases keep their versions because their definitions did not change.

**Timing boundary:** the script answers between native turns; it does not inject a verdict into an in-flight wait, shorten service time or rewrite client RPC. MCP-only Codex now also sets `tool_timeout_sec=1800`; the existing 30-minute per-turn budget exceeds one 600-second default or 1,500-second maximum blocking wait. W7 deliberately sends no answers. A client repeatedly waiting rather than ending a turn can still hit the recorded timeout; fixed tests do not prove live scheduling or Claude task wake-up. The approved Batch and interactive journey must retain this limit in their run ceilings.
