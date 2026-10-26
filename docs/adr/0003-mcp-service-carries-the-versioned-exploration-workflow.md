---
status: accepted
---

# MCP service carries the versioned exploration workflow

The MCP service carries the cross-tool exploration workflow in initialization instructions and locally sufficient descriptions for its four business tools. The complete workflow is authored once in repository Markdown, versioned with SemVer (since 2026-10-25 the service's single Release Version, see [ADR 0004](0004-one-release-version.md)), and deterministically built into optional Resource and Prompt projections plus the mandatory runtime guidance. A connected compatible client therefore does not depend on a copied Skill, repository-relative file or conversation prompt for correct Map operation.

## Considered options

- A copied Skill or repository file keeps workflow delivery client-specific and can leave a client aware of a path it cannot read.
- A separately maintained code/YAML authority or committed generated copy creates a second workflow body that can drift.
- A fifth workflow tool, or mandatory Resource/Prompt use, weakens the four-tool business seam and relies on client capabilities that are not portable.
- Hot reload can mix workflow contracts within one running process and session.

## Consequences

The first 512 characters of server instructions must be independently safe, tool descriptions must remain locally actionable, and Resources/Prompts remain optional. Workflow changes require a SemVer increase, deterministic rebuild, process restart and cross-client acceptance appropriate to their compatibility impact. This decision reinforces [ADR 0001](0001-remote-map-is-authoritative.md) and [ADR 0002](0002-mcp-tools-are-the-primary-interface.md); it changes neither Map authority nor the four business tools.

[ADR 0007](0007-map-wait-for-answer-delivery.md), accepted on 2026-10-26, adds a fifth business tool for Answer Desk delivery; it does not add a workflow-retrieval tool or change the single authored workflow source.
