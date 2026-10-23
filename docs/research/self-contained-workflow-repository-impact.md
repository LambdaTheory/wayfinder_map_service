# Self-contained Wayfinder workflow: repository impact

Date: 2026-09-19
Question: Given the settled self-contained workflow, publication/versioning, and cross-client acceptance decisions, which repository surfaces must change, which should remain unchanged, and do the glossary or ADR set need additions?

## Finding

This is a product-interface and release-contract change, not a Map-domain change. The implementation must make the accepted exploration workflow available from the MCP server itself while retaining exactly four business tools. The authoritative Markdown remains `docs/agents/exploration-mcp.md`; a deterministic build extracts server instructions, per-tool descriptions, the optional Prompt, and a runtime Resource asset from named sections in that file. The built service publishes workflow version `1.0.0`, a stable Resource URI and a versioned Resource URI, and holds one immutable workflow contract for its process lifetime.

The accepted product and local-slice specifications must be amended before implementation. The implementation then needs a workflow extraction/publication module, MCP capability handlers, build gates, protocol/HTTP tests, and one new cross-client acceptance record. Existing M1, persistence, and historical acceptance documents remain intact. A new ADR is warranted; a new `GLOSSARY.md` term is not.

## Required changes

### Accepted specifications

1. **Amend `docs/spec/v1.md`.** Add the client-neutral invariant that a compatible client can safely create, resume, Claim, and advance a Map from server-supplied initialization instructions and tool metadata without a repository file or installed Skill. State that Resources and Prompts are optional affordances, not correctness dependencies, and that the workflow contract has an independent SemVer. This belongs in product behavior/module design and the M5 delivery outcome: v1 already makes the MCP interface the external seam and requires cross-client operation, but currently says nothing about server-carried workflow guidance ([`docs/spec/v1.md`, lines 61–69 and 84–102](../spec/v1.md)).

2. **Amend `docs/spec/mcp-sqlite.md`.** Preserve its exactly-four-tool boundary ([lines 24–32 and 46–80](../spec/mcp-sqlite.md)), then add a new normative workflow-publication section covering:

   - initialization `instructions`, with a standalone safety core no longer than 512 characters and an extended method summary after it;
   - locally sufficient descriptions for `map_create`, `map_list`, `map_read`, and `map_apply`;
   - `wayfinder://workflow/exploration` and `wayfinder://workflow/exploration/1.0.0`, both returning the complete authoritative Markdown for the running build;
   - the side-effect-free `start_wayfinder_exploration` Prompt with `create|resume` and optional stable Map ID;
   - independent `workflowVersion` SemVer, process-lifetime immutability, rebuild/restart semantics, and no hot reload;
   - deterministic extraction/build failures and the no-generated-copy-in-Git rule;
   - the new protocol, failure, build, Codex, ChatGPT Web, and ChatGPT Desktop acceptance gates.

   The current handoff only requires tool schemas/results and live Codex evidence ([lines 84–155 and 199–251](../spec/mcp-sqlite.md)); those clauses are insufficient for the newly settled server instructions, Resource, Prompt, versioning, and cross-client acceptance. Add this as a post-adoption slice rather than rewriting the historical six-slice table as if it had always been part of the original handoff ([lines 253–272](../spec/mcp-sqlite.md)).

3. **Do not change `docs/spec/m1.md`.** The new behavior does not alter Map state, commands, Frontier, Claims, Settlements, or Revision semantics. The local handoff explicitly preserves those domain invariants behind the service ([`docs/spec/mcp-sqlite.md`, lines 26–28](../spec/mcp-sqlite.md)).

### Authoritative workflow and agent-facing docs

4. **Restructure `docs/agents/exploration-mcp.md` as the sole workflow source.** Add `workflowVersion: 1.0.0` and stable named extraction blocks for the 512-character safety core, extended instructions, four local tool descriptions, and Prompt template. Keep the complete human-readable workflow in this file so the Resource is a faithful projection, not a separately maintained summary. The existing document already owns catalog-before-create, stable IDs, Claim-before-work, typed Settlement, Conflict/uncertainty, and outage rules ([lines 3–12 and 29–50](../agents/exploration-mcp.md)); these rules are what the extracted surfaces must preserve.

5. **Update `AGENTS.md` to distinguish source-time and runtime authority.** Repository maintainers should still read the Markdown before changing the workflow, but agents merely operating a connected Wayfinder server must be able to follow its initialization instructions and tool metadata without reading a repository-relative path. The current wording unconditionally requires the local file before creating or advancing a Map ([`AGENTS.md`, lines 3–13](../../AGENTS.md)); without clarification it perpetuates the integration failure this change is intended to remove.

6. **Reduce `.agents/skills/wayfinder/SKILL.md` to an optional invocation/method adapter.** Remove the repository-relative workflow dependency. It should tell the client to connect to and follow Wayfinder MCP, pause if it is unavailable, and retain the planning/Ticket-method guidance that is useful to a human, but it must not carry unique safety rules or a second workflow body. The current Skill requires reading `../../../docs/agents/exploration-mcp.md` and maps the workflow into tool calls ([`.agents/skills/wayfinder/SKILL.md`, lines 7–12 and 60–81](../../.agents/skills/wayfinder/SKILL.md)); that is precisely the non-self-contained dependency being retired.

7. **Update skill provenance records when the Skill changes.** Recompute the entry in `docs/agents/installed-skill-hashes.json`, describe the new repository-owned overlay in `docs/agents/skills-provenance.md`, and update the `wayfinder` method/line-count note in `docs/agents/skill-sources.json`. Those files explicitly claim to record the overlay and installed hash ([`docs/agents/skills-provenance.md`, lines 16–27](../agents/skills-provenance.md); [`docs/agents/installed-skill-hashes.json`, line 27](../agents/installed-skill-hashes.json); [`docs/agents/skill-sources.json`, lines 17–22](../agents/skill-sources.json)).

### Build and MCP implementation

8. **Add a deterministic workflow extractor/validator under `scripts/` and a small runtime contract loader under `src/`.** The build step must reject missing/duplicate/out-of-order blocks, invalid SemVer, a safety core over 512 characters, anything other than the four established tools, a Prompt with side effects or unique safety rules, a Resource differing from the full source Markdown, and runtime dependence on the repository source path. It should emit the uncommitted immutable runtime asset into `dist/`; `dist/` is already ignored ([`.gitignore`, lines 1–4](../../.gitignore)). A CI comparison against the merge base must also reject workflow-content changes without a SemVer increase, a version decrease, or reuse of a released version. Internal comparison hashes may be transient, but no digest becomes a public version or URI.

9. **Update `package.json` build/check commands.** The current build only invokes TypeScript ([`package.json`, lines 8–15](../../package.json)). It must run extraction/validation and place the asset in `dist` before the service starts; add a dedicated check suitable for CI. No new dependency is required if the extractor uses Node built-ins, so `package-lock.json` need not change unless implementation actually changes dependencies. `tsconfig.build.json` need not change merely to copy a non-TypeScript asset ([`tsconfig.build.json`, lines 1–4](../../tsconfig.build.json)).

10. **Extend the MCP server construction in `src/mcp-tools.ts`.** It currently advertises only `{ tools: {} }` and no initialization instructions ([lines 19–26](../../src/mcp-tools.ts)). Load the immutable built contract, pass its safety/summary text as server instructions, advertise `resources` and `prompts` capabilities, and register list/read/get handlers while keeping `map_create`, `map_list`, `map_read`, and `map_apply` as the only tools. Resource and Prompt handlers must not touch storage.

11. **Replace literal tool descriptions in `src/mcp-schemas.ts` with the extracted descriptions.** The present descriptions are short hand-written strings ([lines 84–99](../../src/mcp-schemas.ts)) and omit catalog pagination, create-once/uncertain-result handling, authoritative reread, Claim/HITL, and expectedRevision/no-replay rules. Input/output schemas and business result shapes remain unchanged.

12. **Expose the workflow version in safe service readiness output.** `src/mcp-start.ts` currently logs only a fixed ready message ([lines 9–20](../../src/mcp-start.ts)). The readiness record must include `workflowVersion` but no workflow body, private path, token, or Map content. Keep the existing prefix or update the harnesses that wait for it. `src/mcp-http-internal.ts` may need constructor plumbing because it creates one MCP `Server` per session ([lines 133–150](../../src/mcp-http-internal.ts)); it does not need a new transport or endpoint.

13. **Do not add a fifth `workflow_get` tool or alter tool result schemas.** The current four-tool schema and once-only structured result boundary is accepted ([`docs/spec/mcp-sqlite.md`, lines 46–86](../spec/mcp-sqlite.md)) and implemented as four definitions ([`src/mcp-schemas.ts`, lines 84–99](../../src/mcp-schemas.ts)). Workflow version visibility belongs in initialization, Resource metadata/body, Prompt output, readiness evidence, and acceptance records—not Map tool payloads.

### Automated and real-client acceptance

14. **Add focused workflow-publication tests** (prefer a new `tests/mcp-workflow.test.ts`) for extraction, `1.0.0`, 512-character enforcement, exact source/Resource equality, stable and versioned URIs, current-build alias behavior, immutable process content, Prompt argument branches/zero storage effects, and build rejection cases. Preserve an assertion that `tools/list` returns exactly the existing four tools.

15. **Extend `tests/mcp-tools.test.ts` and `tests/mcp-service.test.ts`.** The in-process test already captures initialize negotiation and asserts the exact four tools ([`tests/mcp-tools.test.ts`, lines 38–49 and 78–85](../../tests/mcp-tools.test.ts)); it should additionally assert exact initialization instructions/capabilities and exercise Resource/Prompt protocol handlers. HTTP tests should prove the same contract travels over the real Streamable HTTP service and remains fixed across sessions/restart. Existing business, limit, auth, shutdown, response-loss, and SQLite tests remain regression gates rather than being duplicated.

16. **Extend test observation helpers.** `tests/helpers/mcp-http-client.mjs` currently records only `protocolVersion` from initialize ([lines 7–22](../../tests/helpers/mcp-http-client.mjs)); it must expose instructions, capabilities, and workflow version evidence. `tests/helpers/codex-acceptance-observer.mjs` likewise records only protocol negotiation, and `tests/helpers/codex-mcp-harness.mjs` currently validates only tool calls/results and waits on the old readiness text ([`tests/helpers/codex-mcp-harness.mjs`, lines 25–36 and 39–92](../../tests/helpers/codex-mcp-harness.mjs)). Update them to capture the new native evidence without inserting workflow rules into prompts.

17. **Replace or supersede `tests/helpers/codex-wayfinder-adoption.mjs` for the new acceptance.** The current runner explicitly injects `$wayfinder`, the project-local workflow, four-tool restriction, and no-replay rules into every prompt ([lines 26–40](../../tests/helpers/codex-wayfinder-adoption.mjs)); that cannot prove server self-containment. The new isolated journey must not provide the Skill, `AGENTS.md`, `docs/agents/exploration-mcp.md`, or copied tool-order/safety text. It must record the actual client/version, negotiated protocol, `workflowVersion`, initialize instructions/capabilities, native calls/results, database Revisions/Frontier/Claims/Settlements/history, failures, and redaction checks.

18. **Add a cross-client acceptance runbook/harness and evidence.** Use one fresh private database and one shared Map for a single journey: ChatGPT Web creates and atomically charts it; an independent Codex CLI session discovers, reads, Claims, and advances it; the original ChatGPT session gets a stale Conflict, rereads, and abandons the stale intent; after restart new sessions confirm the same state. Include one HITL Ticket that is not settled before the live human verdict and is settled only afterward, plus one type-correct AFK result. Real-client coverage must include service unavailable/recovery; controlled unknown-result, lost-receipt, busy, stopping, and restart boundaries stay in automated HTTP tests. Resources/Prompts are reported per client as `available`, `unavailable`, or `undocumented`; only initialization instructions/tool metadata are core compatibility gates.

19. **Update `docs/implementation/local-chatgpt-test-runbook.md`.** Retain its warning that the tunnel is unauthenticated and test-only ([lines 1–15](../implementation/local-chatgpt-test-runbook.md)), but add the exact fresh-database, reconnect/Scan Tools, version-observation, no-external-workflow, evidence-capture, and teardown procedure needed by the ChatGPT portions of the acceptance.

### Implementation and release records

20. **Add a new implementation report and machine-readable evidence**, rather than editing historical reports. A suitable pair is `docs/implementation/mcp-self-contained-workflow.md` and `docs/implementation/mcp-self-contained-workflow-evidence.json`. The report must distinguish automated, Codex CLI, ChatGPT Web developer-mode/plugin, and ChatGPT Desktop Codex-host results; disclose all failed attempts; record Resource/Prompt three-state results; and end with the explicit human acceptance gate. Agent prose is a summary, not evidence.

21. **Create root `CHANGELOG.md`.** This is the single project changelog settled for the project. Its release entry should contain a `Workflow` subsection naming workflow `1.0.0`, behavior/compatibility changes, and the project release that contains it. Do not add a separate changelog to `docs/agents/exploration-mcp.md`; detailed diffs remain in Git history.

22. **Update `README.md` only after implementation and live acceptance.** Add the self-contained capability/current `workflowVersion`, link the new specification/ADR/implementation evidence/Changelog, and replace stale test counts with actually observed results. The README currently describes only four tools and the earlier injected-Skill adoption evidence ([lines 18–32 and 34–46](../../README.md)); it must not claim completion before the new gate passes.

## ADR and glossary thresholds

### Add ADR 0003

Create `docs/adr/0003-mcp-service-carries-the-versioned-exploration-workflow.md`. The decision meets all three repository thresholds for an ADR ([`docs/agents/domain.md`, lines 3–9](../agents/domain.md); [ADR format, lines 27–42](../../.agents/skills/domain-modeling/ADR-FORMAT.md)):

- **Hard to reverse:** clients, builds, stable/versioned URIs, release records, and acceptance evidence will depend on server-carried instructions and an independently versioned generated asset.
- **Surprising without context:** Markdown is the source compiled into runtime guidance, while the mandatory correctness path is initialization instructions plus local tool descriptions; Resource and Prompt exist but remain optional.
- **Real trade-off:** the decisions rejected a copied/repository-relative Skill as the runtime dependency, a separate code/YAML authority, a fifth workflow tool, Prompt/Resource as mandatory safety carriers, committed generated copies, and hot reload.

One focused ADR is enough. It should record the stable architectural principle and principal rejected alternatives, not the detailed test matrix. It reinforces rather than supersedes ADR 0001: authoritative Map state still lives in the service, not files/skills/conversation ([`docs/adr/0001-remote-map-is-authoritative.md`, lines 5–17](../adr/0001-remote-map-is-authoritative.md)). It also reinforces ADR 0002: the four headless tools remain the primary business seam while skills and richer MCP surfaces are adapters/optional projections ([`docs/adr/0002-mcp-tools-are-the-primary-interface.md`, lines 5–17](../adr/0002-mcp-tools-are-the-primary-interface.md)). Neither existing ADR needs editing or supersession metadata.

### Do not add a `GLOSSARY.md` term

`workflowVersion`, self-contained workflow, compatible client, initialization instructions, Resource, and Prompt are protocol, packaging, release, or acceptance concepts—not concepts unique to the persistent decision-map domain. The glossary is explicitly limited to domain-specific language ([`docs/agents/domain.md`, lines 3–9](../agents/domain.md); [glossary format, lines 27–30](../../.agents/skills/domain-modeling/GLOSSARY-FORMAT.md)). The current context already defines the Map model completely enough for this change ([`GLOSSARY.md`, lines 1–85](../../GLOSSARY.md)).

Keep the name `workflowVersion` explicit everywhere. A Map **Revision** already means one immutable accepted Map change ([`GLOSSARY.md`, lines 71–73](../../GLOSSARY.md)); calling the workflow SemVer a Revision or version without qualification would blur two different concepts. No glossary edit is required.

## Optional changes and explicit non-changes

- A dedicated `src/workflow-contract.ts` and `scripts/build-workflow.mjs` are sensible names, but file/module boundaries are reversible implementation choices. The required boundary is deterministic extraction, validation, immutable runtime loading, and testability.
- A static Skill packaged through a future ChatGPT skill-extension path is optional. It cannot be the core acceptance path and remains outside this local change unless separately authorized; current research identifies it as a separate distribution-time mechanism ([`docs/research/mcp-client-capability-verification.md`, lines 43–45](mcp-client-capability-verification.md)).
- Do not promise generic Resources/Prompts on clients that do not expose them. Current primary-source research establishes them as optional and client-dependent ([`docs/research/mcp-client-capability-verification.md`, lines 18–31 and 53–63](mcp-client-capability-verification.md)).
- Do not alter the M1 domain modules, SQLite schema/Adapter, Map command schemas, HTTP authentication, request limits, storage path rules, backup behavior, OAuth/deployment/PostgreSQL/rendering scope, or rollback/deletion planning Maps. This change is workflow delivery and acceptance, not Map state or persistence semantics.
- Do not rewrite `docs/implementation/mcp-tools.md`, `local-mcp-service.md`, `mcp-sqlite-acceptance.md`, `mcp-exploration-adoption.md`, or their JSON evidence. They are dated records of what those earlier Issues actually delivered. The adoption report explicitly states that its evidence relied on a project-local Skill and did not change the MCP service contract ([`docs/implementation/mcp-exploration-adoption.md`, lines 7–18 and 65–67](../implementation/mcp-exploration-adoption.md)); a new report should supersede that operating method prospectively without falsifying history.
- `package-lock.json` changes only if dependencies change. The accepted design does not itself require a new package.

## Minimal implementation order

1. Amend the two accepted specs and add ADR 0003.
2. Mark and version the authoritative workflow Markdown; add deterministic extraction/build checks.
3. Publish instructions, four derived descriptions, Resources, Prompt, and readiness version without changing tool schemas.
4. Update automated protocol/HTTP/build tests and evidence helpers.
5. Update the optional Skill/provenance and the ChatGPT acceptance runbook.
6. Run the single isolated cross-client journey, publish native evidence, and obtain the live human verdict.
7. Only then update README and the project Changelog as delivered release records.

This ordering preserves the repository rule that accepted specifications define the product contract, implementation records describe observed delivery, and product Map state remains separate from both ([`AGENTS.md`, lines 23–31](../../AGENTS.md)).
