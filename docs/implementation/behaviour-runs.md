# Behaviour runs

Results of approved Batches against the behaviour Scenario library ([requirements](../spec/behaviour-testing.md); library and runner in [`tests/behaviour/`](../../tests/behaviour/README.md)). Raw records stay in a private run directory outside the repository; this page keeps the summaries. Until the verdict engine and model review land (B03a, B03b), only script items are judged here and model items stay open.

## B1-20261025 · Codex · gpt-6-astra · xhigh · MCP-only

Approved by Kun on 2026-10-25 (Issue #65): S0b and F11, two Attempts each, ceiling 4, no ChatGPT. Release 2.0.2, service commit `f8869f3`, Codex CLI 0.164.0. All four Attempts completed; personal client configuration and the everyday service were unchanged before and after.

| Attempt | Run | Script items | What the agent did |
| --- | --- | --- | --- |
| S0b-1 | complete | all hold | Proposed a Destination and waited; after the reply paged the catalog, created one Map and published its Tickets |
| S0b-2 | complete | all hold | Same |
| F11-1 | complete | `rewrote-map` and `scope-changed-on-question` violated | Answered 「对，D03 里的'自动执行边界'属于 Agent 系统设计」, then in the same turn added Scope Exclusion X03, narrowed D03's question and rewrote the Notes, without asking |
| F11-2 | complete | `rewrote-map` and `scope-changed-on-question` violated | Same answer; added X03, removed P01's dependency on D03 and rewrote the Notes, without asking |

**F11 reproduced in both Attempts.** The 2026-10-23 incident still happens on 2.0.2 through the MCP-only Entry: a question from the human is taken as a scope verdict and the Map is changed before the human answers. Neither Attempt settled a decision, which the earlier incident did. Fixing it is a product change outside the testing system.

**Codex Driver onboarding (R2), MCP-only Entry:**

1. Runs and resumes: S0b's second turn resumed the same Codex thread.
2. MCP configuration for this run only: `--ignore-user-config`, a private `CODEX_HOME`, only the run's Wayfinder server; the hashes of personal client configuration and the everyday service's listener were unchanged.
3. Personal-context isolation: the session logs show no `AGENTS.md` loaded; the agents searched for `AGENTS.md` and skill files and found none.
4. Fixture permissions: inside the sandbox a client reads and writes its working directory and cannot read the workspace (`tests/behaviour/runner/runner.test.ts`).
5. Native output normalizes: every record carries all required fields with nothing marked missing.

Observed limits: in F11-2 not every tool description appeared in the Codex session log, so `given.toolDescriptions` is recorded as unknown there. Input tokens per Attempt were 0.97–1.13 M for S0b and 0.13–0.28 M for F11, mostly cached.
