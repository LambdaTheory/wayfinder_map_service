# Orchestration

How a coordinator runs implementation Issues in parallel with Orca workers, following the `orca-issue-orchestration` skill. This file holds this repository's parameters; the skill holds the method.

## Roles

- **Coordinator**: claims Issues, dispatches workers, merges the two reviews into one fix list, verifies, merges, tags, runs approved Batches and notifies Kun. It writes no product or test code.
- **Developer**: Codex in a new top-level Orca worktree per Issue, branched from the latest `main`. Dependent work starts from `main` after its prerequisite merges; branches are never stacked.
- **Reviewers**: Claude `/code-review` (Standards and Spec axes) as a background sub-agent of the coordinator, and Grok in the developer's worktree. Orca 1.4.237 offers no Grok worker agent, so the coordinator runs `grok --cwd <worktree> --prompt-file <review brief> --output-format json` in the background, treats the process exit as completion and posts the review as the PR comment. PR code reviews need no approval from Kun.

## Parameters

- At most three developers at once. When more Issues are ready, Kun's stated priority order decides; the run state records it as a rule.
- Two reviews for `src/`, `web/`, `scripts/`, `package.json`, `package-lock.json`, `docs/agents/exploration-mcp.md`, and the behaviour code where a false green is the main risk: `tests/behaviour/runner/`, `verdict.ts`, `report.ts`, `checks.ts`, `common.ts`, `evidence.ts`. One `/code-review` for other documentation, scenario data and test-only tightening; a must-fix finding there adds the second review.
- Kun authorized the coordinator to merge on 2026-10-25, with a merge commit as this repository does. Before merging: the full `npm test` and `npm run typecheck` on the branch merged with the latest `main`; each must-fix item reproduced as fixed; the Release Version, `CHANGELOG.md` section and tag per `AGENTS.md`; and, for a change to a mandatory rule or to how clients use the tools, the ChatGPT run with Kun (gate 2).
- An Issue that still waits on a gate is referenced with `Refs #n`, not closed by the PR; it closes once its verification is linked on it.

## Kun's gates

A gate is the moment work needs Kun's decision. The coordinator labels the Issue `needs-user`, assigns `kun-g`, comments starting with 「需要你处理」 (the options and what happens after each reply), and sends a Feishu message through Ash that names the Issue and carries nothing private. Gates:

1. Every Batch that spends model quota: Scenario runs, and the model reviews and arbitration that judge their Attempts. It is listed as Combinations, Scenarios, counts, extra reviews and run ceiling; the approval is recorded on the Issue, and the coordinator runs the approved Batch.
2. Any ChatGPT app or tunnel operation, and any stop of the everyday service that the current ChatGPT runbook needs.
3. Wording of a mandatory rule, and any change to a settled decision, scope, gate or human-verdict boundary.
4. Human verdicts inside a journey (B09c) and final acceptance (B10).

## Boundaries for workers and reviewers

Every developer brief and review brief carries these:

- Start and stop only services you create: a fresh database under `~/Library/Caches/wayfinder-behaviour-tests/` (the service refuses `/tmp` and repository paths) on a free port. The everyday service on ports 18765 and 18766, its credentials and the real database stay untouched; `npm run serv`, `wayfinder restart` and `wayfinder chatgpt` are the coordinator's, behind a gate.
- Behaviour tests use the fake drivers and fixed evidence. Real-model runs belong to the coordinator after gate 1; raw run records stay outside the repository.
- Private material stays unread: `~/.wayfinder-service/`, `~/.codex-wayfinder*/`, `~/.claude-wayfinder*/` (service credentials and dedicated-agent conversations), and the workspace's `contexts/`, `raw/` and agent memories.
- Node 26.3.0 is required. Put it first on `PATH` with `export PATH="$(dirname "$(npm exec --yes --package=node@26.3.0 -- node -p process.execPath)"):$PATH"`, then run `npm ci` in a new worktree.

## Labels and state

`needs-user` marks an Issue waiting on a gate; `gate` marks an Issue that is itself an acceptance node. Both sit beside the triage roles in [triage-labels.md](triage-labels.md).

Run state lives in `.orchestration/<run_id>/` (git-ignored) and is changed only through the skill's `orch_state.py`, so another coordinator can take over from the files alone.
