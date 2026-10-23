# Wayfinder Map Service agent instructions

Start by reading `README.md`, `GLOSSARY.md`, and `docs/spec/v1.md`. Read relevant files under `docs/adr/` before changing architecture or product semantics.

M1 and the local MCP/SQLite service are accepted. `docs/agents/exploration-mcp.md` is the authored source for maintainers changing the product workflow; a compatible connected client operates from the MCP server's versioned initialization instructions and tool metadata without reading that repository file. Rollback and deletion remain separate post-M1 iterations on their existing GitHub planning Maps; read `docs/planning/README.md` before resuming either effort. The [local read-only Map viewer](docs/spec/map-viewer.md) is implemented in the local MCP service; read its [implementation record](docs/implementation/map-viewer.md) before changing it. Keep deployment, OAuth, PostgreSQL, MCP Apps, editing in the renderer, and plugin packaging outside the accepted local slices unless the user changes the scope.

Use the domain language in `GLOSSARY.md`. Record a newly settled domain term there. Add an ADR only for a hard-to-reverse, surprising trade-off with meaningful alternatives.

## Agent skills

### Issue tracker

Implementation uses GitHub Issues in `kun-g/wayfinder_map_service`; the existing rollback/deletion planning Maps also remain there. Read `docs/agents/issue-tracker.md` before querying or mutating GitHub. New exploration Map state uses Wayfinder MCP. Repository maintainers read `docs/agents/exploration-mcp.md` before changing its workflow; ordinary compatible clients follow the connected server contract when creating, finding, resuming or advancing a Map. The private M1 Project board and synchronization rules are documented in `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use GitHub labels; see `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/`; see `docs/agents/domain.md`.

### Matt Pocock workflows

Project-local skills live in `.agents/skills/`: `setup-matt-pocock-skills`, `wayfinder`, `grill-with-docs`, `grilling`, `domain-modeling`, `prototype`, `research`, and `triage`.

Invoke `wayfinder` for work that spans more than one agent session, `prototype` for a disposable artifact that answers a design question, `domain-modeling` when changing the glossary or recording an ADR, and `grilling` when a human decision genuinely blocks progress. The project-local `wayfinder` skill routes new exploration state through MCP. Use skills as methods, while `docs/spec/v1.md` remains the product contract.

GitHub Issues coordinate implementation and preserve the existing rollback/deletion planning Maps. New exploration Maps use the product MCP as sole authority. Completed historical planning decisions and prototypes are frozen under `docs/archive/`; accepted specifications live in `docs/spec/`. These development records remain separate from product Map state.

Skill provenance, upstream commit, license, and installed hashes live in `docs/agents/skills-provenance.md`, `docs/agents/skill-sources.json`, `docs/agents/installed-skill-hashes.json`, and `THIRD_PARTY_LICENSES/`.
