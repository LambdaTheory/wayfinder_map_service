# Orchestration

How a coordinator runs implementation Issues in parallel with Orca workers, following the `orca-issue-orchestration` skill. This file holds this repository's parameters; the skill holds the method.

## Roles

- **Coordinator**: claims Issues, dispatches workers, merges the two reviews into one fix list, verifies, merges, tags, runs approved Batches and notifies Kun. It writes no product or test code.
- **Developer**: Codex in a new top-level Orca worktree per Issue, branched from the latest `main`. Dependent work starts from `main` after its prerequisite merges; branches are never stacked.
- **Reviewers**: Claude `/code-review` (Standards and Spec axes) as a background sub-agent of the coordinator, and Grok through its headless CLI in the developer's worktree, started by the coordinator: `grok --cwd <worktree> --prompt-file <review spec> --output-format json`. Orca has no Grok worker agent, so the coordinator posts Grok's review as the PR comment.

## Parameters

- At most three developers at once. When more Issues are ready, Kun's stated priority order decides; the run state records it as a rule.
- Two reviews for anything under `src/`, `web/`, `scripts/`, `docs/agents/exploration-mcp.md`, and the behaviour runner, verdict and report code, where a false green is the main risk. One `/code-review` for documentation, scenario data and test-only tightening; a must-fix finding there adds the second review.
- Kun authorized the coordinator to merge on 2026-10-25. Before merging: the full `npm test` and `npm run typecheck` on the branch merged with the latest `main`, each must-fix item reproduced as fixed, and the Release Version, `CHANGELOG.md` section and tag handled per `AGENTS.md`.

## Kun's gates

A gate is the moment work needs Kun's decision. The coordinator labels the Issue `needs-user`, assigns `kun-g`, comments starting with 「需要你处理」 (the options and what happens after each reply), and sends a Feishu message through Ash. Gates:

1. Every Batch that spends model quota (Scenarios, model reviews, arbitration), listed as Combinations, Scenarios, counts, extra reviews and run ceiling. The approval is recorded on the Issue, and the coordinator runs the approved Batch.
2. Any ChatGPT app or tunnel operation, and any stop of the everyday service that the current ChatGPT runbook needs.
3. Wording of a mandatory rule, and any change to a settled decision, scope, gate or human-verdict boundary.
4. Human verdicts inside a journey (B09c) and final acceptance (B10).

## Worker boundaries

- Workers start and stop only services they create: a fresh database under `~/Library/Caches/wayfinder-behaviour-tests/` (the service refuses `/tmp` and repository paths) on a free port. The everyday service on ports 18765 and 18766, its credentials and the real database stay untouched; `npm run serv`, `wayfinder restart` and `wayfinder chatgpt` are the coordinator's, behind a gate.
- Behaviour tests in worker worktrees use the fake drivers and fixed evidence. Real-model runs belong to the coordinator after gate 1.
- Node 26.3.0 is required: `export PATH="$(dirname "$(cat ~/.codex-wayfinder/node-path)"):$PATH"`, then `npm ci` in a new worktree.

## State

Run state lives in `.orchestration/<run_id>/` (git-ignored) and is changed only through the skill's `orch_state.py`, so another coordinator can take over from the files alone.
