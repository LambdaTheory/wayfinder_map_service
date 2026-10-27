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

Each skill's `agents/openai.yaml` host metadata comes from upstream and controls display names and invocation policy. The `grill-with-docs`, `setup-matt-pocock-skills` and `triage` frontmatter drops the legacy `disable-model-invocation` key; the equivalent explicit-only policy lives in each skill's `agents/openai.yaml`. The repository-owned `wayfinder` overlay carries the Wayfinder method for Maps held by the MCP service, adapted from the upstream body after the 2026-10-23 method experiment (`docs/implementation/wayfinder-method-experiment.md`); its `agents/openai.yaml` allows implicit invocation. The connected service still supplies the versioned operational workflow and stays sufficient without the skill (ADR 0003); GitHub remains the implementation tracker, and the two inherited planning Maps keep their documented authority outside this skill. These overlays are recorded in `skill-sources.json` and reflected in the installed hashes.

On 2026-10-26 the `wayfinder` overlay was aligned with Release Version 3.0.0. Its Out of scope section uses all three complete rule passages from [#87's proposed wording](https://github.com/kun-g/wayfinder_map_service/issues/87#issuecomment-6405351705), [approved by Kun](https://github.com/kun-g/wayfinder_map_service/issues/87#issuecomment-6405899011), verbatim. The Ticket naming, reason and open-until-removal descriptions are retained from the prior skill and attached to the proposed Scope Exclusion; the existing settled-decision and reopening guidance remains. Its installed hash and source metadata record this local change.

Upstream renamed the domain glossary convention from `CONTEXT.md` to `GLOSSARY.md` before `5beb35b`; this repository's glossary moved with it, so archived records that cite `CONTEXT.md` refer to today's `GLOSSARY.md`.

Release Version 5.0.0 aligns the `wayfinder` overlay with the workflow corrections for #129–#135: one-turn questions, explicit takeover authorization, unsupported operations, the extent of change requests and route completion. The Answer Desk passages remain intact. Exact wording approved by Kun on 2026-10-27, source-to-copy coverage and verification limits are recorded in [workflow-fixes-129-135.md](../implementation/workflow-fixes-129-135.md); hashes and line counts include this local adaptation.

The repository-local copies are the runtime dependency. Global skills under a user's home directory are irrelevant to reproducibility and may differ.

When upgrading:

1. Select and record an explicit upstream commit.
2. Fetch into a temporary location and compare semantics before replacing files. Copy upstream files byte-for-byte and reapply only the recorded overlays.
3. Preserve this repository's product decisions in `docs/spec/v1.md` and `AGENTS.md` rather than patching upstream skill instructions silently.
4. Update `skill-sources.json`, installed hashes, and the license when applicable.
5. Validate every installed skill and run a real Wayfinder/Grilling workflow before accepting the upgrade.
