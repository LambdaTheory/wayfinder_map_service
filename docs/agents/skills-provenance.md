# Matt Pocock skill provenance

This repository vendors eight project-local skills derived from [`mattpocock/skills`](https://github.com/mattpocock/skills) at commit `5beb35b040e3de97e54fa9e386d7e42d15c295c2` (2026-10-19), upgraded on 2026-10-23 from `3cca18b368ae95cdbdebbff572ccafa662551015`.

Installed skills:

- `setup-matt-pocock-skills`
- `wayfinder`
- `grill-with-docs`
- `grilling`
- `domain-modeling`
- `prototype`
- `research`
- `triage`

The files were cloned from the fixed upstream commit and copied byte-for-byte; only the overlays below differ from upstream. `docs/agents/skill-sources.json` records each upstream source and whether it is byte-identical; `docs/agents/installed-skill-hashes.json` records the expected SHA-256 hashes. The upstream MIT license is preserved at `THIRD_PARTY_LICENSES/Matt-Pocock-MIT.txt`.

Each skill's `agents/openai.yaml` host metadata comes from upstream and controls display names and invocation policy. The `grill-with-docs`, `setup-matt-pocock-skills` and `triage` frontmatter drops the legacy `disable-model-invocation` key; the equivalent explicit-only policy lives in each skill's `agents/openai.yaml`. Issue 46 reduces the repository-owned `wayfinder` overlay to an invocation/method adapter: the connected MCP service supplies its versioned operational workflow, while GitHub remains the implementation tracker and the two inherited planning Maps retain their documented authority. These overlays are recorded in `skill-sources.json` and reflected in the installed hashes.

Upstream renamed the domain glossary convention from `CONTEXT.md` to `GLOSSARY.md` before `5beb35b`; this repository's glossary moved with it, so archived records that cite `CONTEXT.md` refer to today's `GLOSSARY.md`.

The repository-local copies are the runtime dependency. Global skills under a user's home directory are irrelevant to reproducibility and may differ.

When upgrading:

1. Select and record an explicit upstream commit.
2. Fetch into a temporary location and compare semantics before replacing files. Copy upstream files byte-for-byte and reapply only the recorded overlays.
3. Preserve this repository's product decisions in `docs/spec/v1.md` and `AGENTS.md` rather than patching upstream skill instructions silently.
4. Update `skill-sources.json`, installed hashes, and the license when applicable.
5. Validate every installed skill and run a real Wayfinder/Grilling workflow before accepting the upgrade.
