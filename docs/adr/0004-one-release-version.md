---
status: accepted
---

# One release version for the service and its workflow

Until 2026-10-25 the workflow carried its own SemVer, `workflowVersion`, while the server reported a fixed `0.1.0` in MCP `serverInfo` that never changed. Kun saw two numbers, and the one that looked like the program's version said nothing about the code that was running. Now one SemVer, the Release Version in `package.json`, names a build of the service together with the workflow it carries. It continues the workflow's sequence from `3.0.1`, so no client sees a version go backwards.

## Considered options

- Keep the independent `workflowVersion` and make the server version real as well: two numbers to maintain, and every report has to say which one it means.
- One version for both (chosen).

## Consequences

The number alone no longer says whether the workflow text changed, because a release that changes only code also moves it. The major, minor and patch rules still mark changes in client behavior, and each `CHANGELOG.md` section names the workflow changes it contains. Every change to shipped code or the workflow raises the version, and each release is tagged `v<version>` on `main`; a test compares shipped files with the last tag. This amends only the versioning in [ADR 0003](0003-mcp-service-carries-the-versioned-exploration-workflow.md).
