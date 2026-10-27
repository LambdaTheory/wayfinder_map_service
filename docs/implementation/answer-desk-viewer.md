# Answer Desk viewer (#113)

This slice implements [Answer Desk §5, §7 and §9](../spec/answer-desk.md) on the existing Map viewer. It ships as Release Version 3.3.0 **disabled by default**, using the same `answerDeskEnabled` setting introduced by the storage slice. It changes no MCP tool or workflow text. Delivery transport and coordinated real-client/ChatGPT acceptance remain separate work.

## Browser boundary

`POST /api/desk` is the only browser write route. Its JSON body contains `mapId` and one of:

- `action: "answer", submissions: [{questionId, questionVersion, choice: {option} | {text}}]` for a single answer or replacement. Multiple submissions are admitted only for pending `followRecommendation` questions and their displayed recommended option; storage commits them atomically.
- `action: "reopen", submission: {ticketId, settlementIntroducedAtRevision, affectedTickets, affectedSettlementRevisions, requested}` to file or replace a Reopen Request.
- `action: "cancelReopen", requestId` to cancel a pending request.

The host first enforces the exact loopback Host. The route requires exact same-origin `Origin`, rejects foreign `Sec-Fetch-Site`, accepts JSON up to 1 MiB and checks `X-Wayfinder-Key` against a constant-time SHA-256 comparison. It accepts no query, MCP credential, Map command, taking operation or Settlement. It returns fixed errors and no diagnostic text. Responses retain no-store, no-referrer, same-origin resource policy and the viewer CSP. The ChatGPT relay remains unchanged and forwards only `/mcp`.

With the setting absent or false, `/api/desk` returns 404 for every method, `/viewer/desk.js` is unavailable, view responses omit `desk`, the page has no Answer Desk UI (including an already-open page after a disabled restart at the same Revision), and revision polling still returns 204 when unchanged. Every other viewer route remains GET/HEAD. With the setting on, reads remain unkeyed; keyless pages can inspect desk state but have no enabled response controls.

## Key issuance and handoff

`createViewerKey` generates 32 independent random bytes per enabled service process. Nothing derives it from the MCP token or stores it in a Map. `LocalServiceConfiguration.answerDeskKeyPath`, exposed as the operator-only `WAYFINDER_ANSWER_DESK_KEY_FILE`, optionally publishes it after listener startup. The file's parent must already be a current-user private directory; the destination must be absent or a private regular file. Publication uses an exclusive temporary 0600 file and atomic rename, refusing symlinks. Startup failures print only existing fixed operator errors. Normal stop removes the matching file, and every restart creates a different key even after a crash.

The launcher sets that file path to `answer-desk-key` in its private service directory. `wayfinder desk <mapId>` verifies its ownership/type/mode, checks the enabled read projection, then opens `http://127.0.0.1:<port>/maps/<mapId>#key=…` in the default browser. It neither enables the feature nor prints the URL or adds a launch-metadata record. A fake browser/launcher test checks this handoff without starting a real harness or service.

The viewer reads the fragment before its first data request, strips it with `history.replaceState(null, …)` and retains the key only in closures. It is not in DOM attributes, history state, cookies, browser storage, global variables, returned data, scripts or service logs. Refreshing or opening another page requires the launcher again. A service restart rejects an existing page's old key; the UI reports that it must be reopened. Same-user private-file access is an operator capability, not an MCP privilege.

## Projection and interaction

When enabled, the existing `/api/maps/<mapId>/view?known=<revision>` returns a fresh coherent head/desk projection every two seconds, even when the Revision is unchanged. The page avoids repainting unchanged desk content, and preserves a text modal and draft across both desk changes and new Map Revisions. It retains the viewer's unreachable/stale indication. Human writes call the existing guarded storage seam and never advance a Map Revision.

The queue uses the service's order without recomputing it: unlock/research gates, Unlock Count, Downstream Count, triage, time and identity. Each question shows consequences, why Kun is needed, triage reason, full recommendation and two or three options. Selection submits immediately; Enter submits the explicitly labelled recommendation, 1–3 select and `t` opens a text draft, including with a queue button focused. Input controls retain ordinary typing. Empty text, viewing, opening and cancelling submit nothing. Bulk confirmation shows every selected full recommended answer in a modal; it captures the displayed Question Versions and does not silently rebind them after a poll.

Answered and Taken answers remain editable until Settlement. Withdrawal strikes through the question and displays its reason. Old answers and superseded publications appear as history. Requested-option markers remain visually separate from submitted answers and recommendations; text Reopen context is displayed verbatim with no prefilled answer. The browser test checks that a marker for option 2 still makes Enter submit recommendation 1.

Every settled Ticket, including a conversation-only Settlement, offers a Reopen Request. The modal captures the target and dependent Settlement identities and displays the full affected list before filing. The storage transaction verifies the entire binding set. If it changes, filing is refused and the modal requires explicit review of the new list; nothing is filed or replaced. Conversation-only Settlements offer text only. Pending requests can be cancelled; Taken requests can only be replaced after another review. The page never reopens or settles a Ticket itself, retries an unknown receipt or treats a Quiet Window as automatic Settlement.

## Evidence

Only disposable SQLite fixtures and synthetic text were used. No real model/client, real database, everyday service, tunnel, port 18765/18766 or `npm run serv` was used.

- `tests/viewer-desk.test.ts`: absent/false setting, route/method/Host/origin/key boundaries, bounded and malformed bodies, no token substitution or general edits, bulk admission, unchanged Revisions, desk-only polling, answer replacement and stale-publication rejection, Reopen binding changes/cancellation/replacement, restart rotation, private-file refusal and launcher handoff.
- Existing `tests/viewer-http.test.ts` continues to cover the disabled read-only viewer and access behavior.
- `tests/helpers/viewer-desk-browser.mjs` uses headless Chromium and a fresh cache database. It verifies keyboard/text/bulk/edit behavior, empty/cancel/open no-ops, draft preservation, Taken/Settled following, withdrawal history, stale editor refusal, affected-list re-review, cancellation, preselection/text context, fragment/storage/DOM absence, restart invalidation and disabled UI. A controlled clock advances release boundaries without timing races. It produces the screenshots below and checks 375px without horizontal overflow. No browser dependency was added to the project.

To reproduce after `npm run build`, set `WAYFINDER_PLAYWRIGHT_MODULE` to the absolute `playwright/index.mjs` of a local Playwright installation, then run `node tests/helpers/viewer-desk-browser.mjs` under Node 26.3.0. The helper owns and removes only its new `~/Library/Caches/wayfinder-behaviour-tests/answer-desk-browser-*` directory and its free-port service.

| Light | Dark | 375px |
| --- | --- | --- |
| ![Synthetic Answer Desk in light mode](answer-desk-viewer/light.png) | ![Synthetic Answer Desk in dark mode](answer-desk-viewer/dark.png) | ![Synthetic Answer Desk at 375px](answer-desk-viewer/375px.png) |

Final build/test/typecheck results are recorded in the PR. The parallel delivery slice can overlap `src/mcp-http-internal.ts` (configuration, viewer dispatch, startup/stop) and the version/CHANGELOG files; it does not require changing this slice's browser route or tools/workflow. Merge order must assign a fresh minor Release Version and tag after merge.
