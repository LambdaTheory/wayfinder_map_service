---
status: accepted
---

# One release version for the service and its workflow

Until 2026-10-25 the workflow carried its own SemVer, `workflowVersion`, while the server reported a fixed `0.1.0` in MCP `serverInfo` that never changed. Kun saw two numbers, and the one that looked like the program's version said nothing about the code that was running. Now one SemVer, the Release Version in `package.json`, names a build of the service together with the workflow it carries. Kun chose to start it at `1.0.1`. `serverInfo.version` moves up from `0.1.0`, and the instruction line changes name as well as number (`workflowVersion: 3.0.0` becomes `version: 1.0.1`), so a client meets a new series rather than a lower workflow version.

## Considered options

- Keep the independent `workflowVersion` and make the server version real as well: two numbers to maintain, and every report has to say which one it means.
- One version continuing the workflow's numbers from `3.0.1`, which avoids overlapping the old series.
- One version starting at `1.0.1` (chosen).

## Consequences

The number alone no longer says whether the workflow text changed, because a release that changes only code also moves it. The rules for raising it, in `docs/spec/mcp-sqlite.md` §14.3, still mark changes in client behavior, and each `CHANGELOG.md` section names the workflow changes it contains. The old `workflowVersion` numbers `1.0.0` to `3.0.0` overlap the new series: evidence that records `workflowVersion` `2.0.0` is not Release Version `2.0.0`, and a later release may reuse a versioned Resource URI such as `wayfinder://workflow/exploration/2.0.0` for different text. The workflow build and `tests/release.test.ts` enforce a higher version for each shipped change against the last `v<version>` tag. PR #55 first numbered this release `3.0.1`; it never ran, and its tag was withdrawn. This amends only the versioning in [ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md).
