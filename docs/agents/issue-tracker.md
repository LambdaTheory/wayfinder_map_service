# Issue tracker: GitHub Issues

Implementation uses [GitHub Issues](https://github.com/kun-g/wayfinder_map_service/issues) in the private repository `kun-g/wayfinder_map_service`. The 2026-09-18 migration moved completed M1 planning to `docs/archive/m1-planning/` and the two deferred planning Maps to native GitHub parent/child Issues. The deletion Map remains on GitHub; the rollback Map was closed on 2026-10-25 when the user dropped rollback. New exploration Map state uses the product MCP workflow in [exploration-mcp.md](exploration-mcp.md). Local `.scratch/` paths are compatibility redirects, not live trackers.

## Authority

- Accepted requirements and acceptance definitions: `docs/spec/`. Read `docs/spec/m1.md` for M1 implementation.
- Implementation progress, assignees, blockers and delivery resolutions: GitHub Issues.
- New exploration Destination, Tickets, Dependencies, Claims, Settlements, Fog and Scope: the product MCP Map described in [exploration-mcp.md](exploration-mcp.md).
- Completed planning provenance, human confirmations, withdrawn proposals and prototypes: `docs/archive/`. Earlier statements yield to later accepted scope corrections and the current specification.
- Active planning entry points: `docs/planning/README.md` and [Ticket and Map deletion Map](https://github.com/kun-g/wayfinder_map_service/issues/17). No deletion specification is accepted yet. Ticket 07 preserves unconfirmed deletion recommendations.

PRs as a request surface: **off**. PRs are implementation evidence rather than independent triage requests. These development trackers are separate from product Map state, Claims and StateAdapter operations.

## GitHub implementation workflow

1. Read the accepted M1 contract, issue body, and all native `blocked_by` edges. `ready-for-agent` means specified; start only with all blockers closed and no other assignee/session claim. Read-only inspection does not claim work.
2. Claim explicitly through the assignee plus a concise session-identifying comment when needed. Preserve another session's claim; inspect stale claims before reassignment. Development assignees do not identify product Claimants.
3. Implement the approved vertical slice with its tests and Standards/Spec review. Link actual verification results on the Issue. Close only when its acceptance criteria pass; planning closure is not feature delivery.
4. Maintain blockers natively, with matching body links for readability. Preserve approved slice boundaries unless the user explicitly changes them. Stage only files belonging to the current change and preserve concurrent work and remote history.

Approved M1 order: creation/read → atomic Map revision → Ticket/Dependency/Frontier → two branches (Fog/Scope content; Claim), then Settlement/reopen after Claim. The whole M1 gate requires all six slices plus every branch of all 56 acceptance scenario groups, not only the last Issue's tests.

User instruction (2026-09-18): do not monitor, wait for, or use CodeRabbit as an agent merge/review gate. Acceptance tests, strict type checking, Standards/Spec review, and conflict checks remain the quality gates. This does not authorize disabling the GitHub integration or bypassing repository-required checks.

## Existing GitHub planning Maps

These operations apply only to the existing deletion planning Map. The project-local `wayfinder` skill uses product MCP for new exploration:

- **Map:** an Issue labelled `wayfinder:map` and `planning`, with Destination, Notes, Decisions so far, Not yet specified and Out of scope in its body. Open Tickets are its native sub-issues, queried rather than manually mirrored in a file.
- **Child Ticket:** one native sub-issue per bounded Question, labelled `wayfinder:grilling`, `wayfinder:prototype`, `wayfinder:research` or `wayfinder:task`. Provision a type label when first needed. Apply `planning`; deferred deletion also carries `post-m1`.
- **Blocking:** native `blocked_by` relationships. Create Issues before wiring edges, using database Issue IDs rather than local ticket numbers in REST payloads. Name blockers in the body for readability. Parent/sub-issue membership does not itself imply blocking. Existing Maps preserve their internal blocker routes; cross-Map dependency changes require a settled reason.
- **Frontier:** open, unassigned children whose native blockers are closed. `ready-for-human` interviews/prototype verdicts require the human; `ready-for-agent` specifies agent-executable work. A deferred Map is resumed explicitly, rather than automatically mixed into M1 implementation work.
- **Claim:** assign the developer driving the Map before work and identify the session when needed. Preserve other claims. A parent container is not a claim on all children.
- **Resolve:** post the accepted Answer as a resolution comment, close the child, then add a named summary link to the parent's Decisions so far. A live human verdict is required for interviews/prototypes; the agent does not answer on the human's behalf.
- **Fog and exclusions:** graduate only precise in-scope Questions to children. Close a mis-scoped child with a scope-disposition reason and link it under Out of scope; it is not an accepted decision.
- **Handoff:** synthesize settled decisions into `docs/spec/deletion.md`. Close the synthesis child and parent only after explicit human confirmation. M1 historical planning files remain frozen; accepted contract changes belong in `docs/spec/` with their Issue provenance.

Native relationships use the documented [sub-issue API](https://docs.github.com/en/rest/issues/sub-issues) and [Issue dependency API](https://docs.github.com/en/rest/issues/issue-dependencies).

## M1 Project

The private [Wayfinder Map Service — M1 project](https://github.com/users/kun-g/projects/5) has default repository `kun-g/wayfinder_map_service`. Its enabled auto-add workflow selects repository Issues with `is:issue -label:planning`, keeping post-M1 planning outside this delivery board. Native planning parent/child relationships remain visible in Issues without a second project.

Closing an Issue moves its card to Done. Auto-close from card status is disabled: verify acceptance and close explicitly. Native Issue state, assignees and blockers remain authoritative.

CLI project reads require `read:project`; project mutations require `project`. Repository/Issue operations use the existing `repo` scope. If project scopes are unavailable, use the signed-in GitHub browser; preserve existing authentication scopes.
