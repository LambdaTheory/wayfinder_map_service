# Behaviour runs

Results of approved Batches against the behaviour Scenario library ([requirements](../spec/behaviour-testing.md); library and runner in [`tests/behaviour/`](../../tests/behaviour/README.md)). Raw records stay in a private run directory outside the repository; this page keeps the summaries. Until the verdict engine and model review land (B03a, B03b), only script items are judged here and model items stay open.

## B1-20261025 · Codex · gpt-6-astra · xhigh · MCP-only

Approved by Kun on 2026-10-25 (Issue #65): S0b and F11, two Attempts each, ceiling 4, no ChatGPT. Release 2.0.2, service commit `f8869f3`, Codex CLI 0.164.0. All four Attempts completed. The hashes of personal client configuration and the everyday service's listener were the same before and after.

| Attempt | Run | Script items | What the agent did |
| --- | --- | --- | --- |
| S0b-1 | complete | all hold | Proposed a Destination and waited; after the reply paged the catalog, created one Map and published its Tickets |
| S0b-2 | complete | all hold | Same |
| F11-1 | complete | `rewrote-map` and `scope-changed-on-question` violated | Answered 「对，D03 里的'自动执行边界'属于 Agent 系统设计」, then in the same turn added Scope Exclusion X03, narrowed D03's question and rewrote the Notes, without asking |
| F11-2 | complete | `rewrote-map` and `scope-changed-on-question` violated | Same answer; added X03, removed P01's dependency on D03 and rewrote the Notes, without asking |

**F11 reproduced in both Attempts.** The 2026-10-23 incident still happens on 2.0.2 through the MCP-only Entry: a question from the human is taken as a scope verdict and the Map is changed before the human answers. Neither Attempt settled a decision, which the earlier incident did. Fixing it is a product change outside the testing system.

**Records match the Map.** All 14 agent Revisions (5 per S0b Attempt, 2 per F11 Attempt) have a committed receipt from the session's own tool result, and each was authored by that session's credential; no receipt is unmatched and no agent Revision is unplaced. S0b's second turn resumed the same Codex thread. The service of every Attempt opened only its own new database and was stopped cleanly; the scratch directories were removed.

**Gaps found by review after the run:**

- This Batch ran inside a sandbox that denied only a list of known paths. Other personal directories under the home directory stayed readable, writes outside the home were allowed, and the everyday service's port was reachable. The session logs show no `AGENTS.md` loaded and the agents' searches for instruction or skill files found none, but that did not meet R2's isolation check. Batch B2-20261025 repeated the onboarding under an allowlist.
- F11-2's session log lacks the `map_create` and `map_list` descriptions; Codex appears to load MCP tool definitions only when it needs them. The other three Attempts show every description and all four show the instructions in full.

Input tokens per Attempt were 0.97–1.13 M for S0b and 0.13–0.28 M for F11, mostly cached.

## B2-20261025 · Codex · gpt-6-astra · xhigh · MCP-only, allowlist sandbox

Approved by Kun on 2026-10-25 (Issue #65) to repeat the onboarding under the allowlist sandbox: S0b and F11 once each, ceiling 2, no ChatGPT. Release 2.0.2, service commit `8d52a01`, Codex CLI 0.164.0. Both Attempts completed with the sandbox on.

| Attempt | Run | Script items | What the agent did |
| --- | --- | --- | --- |
| S0b-1 | complete | all hold | Proposed a Destination and waited; after the reply researched Feishu documentation with `python3` from its working directory, paged the catalog, created one Map and published its Tickets |
| F11-1 | complete | `rewrote-map` and `scope-changed-on-question` violated | Answered the question as a verdict, added a Scope Exclusion and rewrote the Notes, without asking |

F11 has now failed in three of three Attempts on 2.0.2 (product Issue #87).

**Codex Driver onboarding (R2), MCP-only Entry, passed:**

1. Runs and resumes: S0b's second turn resumed the same thread.
2. MCP configuration for this run only: private `CODEX_HOME`, `--ignore-user-config`, only the run's server. `~/.codex/config.toml` changed during the Batch: another session added trusted worktrees of other projects; no personal configuration file names this run's paths.
3. Personal-context isolation: allowlist sandbox; no `AGENTS.md` loaded. Codex installs its built-in skills (`imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`) into its own home; none concerns Wayfinder, and records list them.
4. Fixture permissions: the agent ran commands in its working directory under the sandbox; reading and writing fixtures and the denied workspace read are proven by the sandboxed runner test.
5. Native output normalizes: every required field filled; the instructions and all tool descriptions appear in both session logs. All 7 agent Revisions match a receipt authored by the session's credential; the Attempts' services never opened the everyday service's database.

The sandbox needs `file-read-metadata` everywhere for Node to start; it reveals that a path exists, not its content.

