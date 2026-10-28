# Release train

Kun changed the release policy on 2026-10-28 after multiple mandatory-rule changes each consumed a major version in one day. [Specification §14.3](../spec/mcp-sqlite.md#143-versioning-build-and-release) owns the version rules and shipped scope; this file gives the coordinator's procedure. Published numbers and tags stay unchanged. The next rule change after 5.0.0 is 5.1.0 unless an incompatible change also rides that train.

## Ordinary PRs

The developer keeps the versions in `package.json` and `package-lock.json`, adds a bullet under `CHANGELOG.md` → `## Unreleased` for each shipped change, and identifies its major/minor/patch impact. It creates no release tag. Documentation- and test-only changes need no entry. The coordinator checks the entry and resolves changelog conflicts when merging. ChatGPT verification still follows the unchanged behavior-impact rule in `AGENTS.md`; batching releases does not waive any merge gate.

## Publish a release

The coordinator releases at most once per Asia/Singapore calendar day, or when Kun requests one. There is no automatic daily publication or service restart. Use a release worktree, leaving the everyday service's checkout and process alone.

1. Fetch `origin/main` and release tags, verify the latest published tag reachable from `main`, and check the previous release date. Review all shipped changes since that tag against Unreleased. Choose the highest required bump: incompatible interfaces, Map state or storage formats → major; rules, new capabilities or other compatible behavior → minor; behavior-preserving fixes → patch. A one-way storage migration is incompatible. Keep unresolved acceptance requirements explicit.
2. Create a release PR from the latest `main`. Update the one version in `package.json` and both root versions in `package-lock.json` together. Move all Unreleased entries into `## <version> (<Asia/Singapore date>)`, leaving one empty `## Unreleased`. Do not rewrite historical release sections or renumber old tags.
3. On Node 26.3.0, run `npm run build`, `npm test -- --maxWorkers=4` and `npm run typecheck` on the release PR merged with the latest `main`. The release gate sees the higher package version, requires the new section and requires empty Unreleased. Complete the usual review and behavior-impact gates, then merge with a merge commit.
4. In the release worktree, check out that exact merged commit from `origin/main` with a clean tree. Confirm no other shipped change entered it after the reviewed release closeout; confirm `v<version>` does not already exist. Tag that commit (`git tag -a v<version> -m 'Release <version>'`). Never move or reuse an existing release tag.
5. Rebuild **after tagging** with `npm run build`; pre-tag artifacts intentionally carry a dev version. Read the built identity without starting a service: `node --input-type=module -e 'import { workflowContract } from "./dist/workflow.generated.js"; console.log(workflowContract.version)'`. It must equal `<version>` exactly, and `git status --short` must be empty. Push the tag (`git push origin v<version>`) only after this succeeds. A failed check stops publication for investigation; it never justifies publishing a dev artifact as a release.
6. Report the published version and the included changes to Kun. An everyday service upgrade is separate and requires his direct approval for that version and restart; follow [Orchestration → Releases and everyday service upgrades](../agents/orchestration.md#releases-and-everyday-service-upgrades).

## Build identity and verification

`scripts/release-version.mjs` resolves the build identity once. Only a clean HEAD carrying the matching package-version tag gets the bare release number. A clean non-tag build uses a commit prefix, and a dirty build hashes HEAD, status, the tracked diff and non-ignored untracked content. Both carry `+dev.` metadata within the existing 32-character tool field. Git/provenance failures stop the build. Ignored build outputs do not dirty a release. The generated contract is copied into `dist`; runtime does not need Git or repository sources.

This dev suffix was chosen so development and isolated behavior checks keep running. The alternative, refusing to run non-tag services, would prevent those checks. ADR 0005's exact string comparison rejects a published version against a dev build even though SemVer precedence ignores build metadata. MCP serverInfo, initialization instructions, Resources, Prompt, readiness output and launcher status all use the captured contract version. Test controllers seed with the version observed from their service; fixed tests use the generated contract instead of the package base.

`tests/release.test.ts` checks changelog and version closeout against the last reachable release tag, including untracked shipped files. `tests/release-build.test.ts` uses disposable Git repositories for clean tags, non-tag commits, staged/unstaged/untracked edits and missing provenance. Protocol tests verify the same build version on every MCP surface and reject published-version writes on dev builds; synthetic launcher checks retain the full version without a real client or everyday service.
