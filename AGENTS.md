# Wayfinder Map Service agent instructions

Start by reading `README.md`, `GLOSSARY.md`, and `docs/spec/v1.md`. Read relevant files under `docs/adr/` before changing architecture or product semantics.

M1 and the local MCP/SQLite service are accepted. `docs/agents/exploration-mcp.md` is the authored source for maintainers changing the product workflow; a compatible connected client operates from the MCP server's versioned initialization instructions and tool metadata without reading that repository file. Deletion remains a separate post-M1 iteration on its existing GitHub planning Map; read `docs/planning/README.md` before resuming it. Rollback was dropped on 2026-10-25. The [local Map viewer](docs/spec/map-viewer.md) is implemented as read-only; read its [implementation record](docs/implementation/map-viewer.md) before changing it. Answer Desk work must read [its specification](docs/spec/answer-desk.md): the keyed answer-only scope was confirmed by Kun on 2026-10-26 (#109), and #110–#114 wait for #109 closeout. Keep deployment, OAuth, PostgreSQL, MCP Apps, general Map editing in the renderer, and plugin packaging outside the local slices unless the user changes the scope.

The dedicated-agent launcher (`wayfinder` command) lives in `scripts/wayfinder-agent/`; read its `README.md` before changing it. Its instruction files are named `agent-instructions*.md` so they are not read as directory instructions here.

Use the domain language in `GLOSSARY.md`. Record a newly settled domain term there. Add an ADR only for a hard-to-reverse, surprising trade-off with meaningful alternatives.

## Versioning

Ordinary PRs keep `package.json` and `package-lock.json` versions unchanged and create no tag. Each change touching shipped code or the workflow adds an entry under `CHANGELOG.md` → `## Unreleased`. Release at most once per day, or when Kun requests it, using the largest change since the last tag: major for incompatible tools, schemas, Map state, HTTP interfaces or storage formats; minor for rule changes (including mandatory rules) and new capabilities; patch for fixes that preserve behavior. Exact Release Version attestation already blocks stale callers on every release (ADR 0005), regardless of which part rises. Follow `docs/spec/mcp-sqlite.md` §14.3 for shipped scope and `docs/implementation/releases.md` for the release procedure; `tests/release.test.ts` enforces pending entries and release closeout. Daily service upgrades require Kun's direct approval each time under `docs/agents/orchestration.md`.

Decide the ChatGPT run by behavior impact, not by which version part rises. A change to a mandatory rule or to how clients use the tools is tested in ChatGPT with the user before merging; any other behavior change, including a behavior fix released as a patch, waits and is tested together at the next ChatGPT run; only changes that leave behavior unchanged need none. The run is semi-manual and follows `docs/implementation/local-chatgpt-test-runbook.md`; ask the user before starting it, and record the evidence under `docs/implementation/`.

## Agent skills

### Issue tracker

Implementation uses GitHub Issues in `kun-g/wayfinder_map_service`; the existing deletion planning Map also remains there. Read `docs/agents/issue-tracker.md` before querying or mutating GitHub. New exploration Map state uses Wayfinder MCP. Repository maintainers read `docs/agents/exploration-mcp.md` before changing its workflow; ordinary compatible clients follow the connected server contract when creating, finding, resuming or advancing a Map. The private M1 Project board and synchronization rules are documented in `docs/agents/issue-tracker.md`.

Coordinating Issues in parallel with Orca workers follows `docs/agents/orchestration.md`: roles, review depth, merge checks, Kun's gates and worker boundaries.

### Triage labels

The five canonical triage roles use GitHub labels; see `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/`; see `docs/agents/domain.md`.

### Matt Pocock workflows

Project-local skills live in `.agents/skills/`: `setup-matt-pocock-skills`, `wayfinder`, `grill-with-docs`, `grilling`, `domain-modeling`, `prototype`, `research`, and `triage`.

Invoke `wayfinder` for work that spans more than one agent session, `prototype` for a disposable artifact that answers a design question, `domain-modeling` when changing the glossary or recording an ADR, and `grilling` when a human decision genuinely blocks progress. The project-local `wayfinder` skill carries the Wayfinder method for Maps held by the MCP service; the server contract alone remains sufficient. Use skills as methods, while `docs/spec/v1.md` remains the product contract.

GitHub Issues coordinate implementation and preserve the existing deletion planning Map. New exploration Maps use the product MCP as sole authority. Completed historical planning decisions and prototypes are frozen under `docs/archive/`; accepted specifications live in `docs/spec/`. These development records remain separate from product Map state.

Skill provenance, upstream commit, license, and installed hashes live in `docs/agents/skills-provenance.md`, `docs/agents/skill-sources.json`, `docs/agents/installed-skill-hashes.json`, and `THIRD_PARTY_LICENSES/`.
