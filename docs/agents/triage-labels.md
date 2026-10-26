# Triage labels

GitHub implementation and planning Issues use the canonical triage vocabulary. All five labels are provisioned with the exact canonical names. The historical local `Triage:` vocabulary is retained below only for reading archived planning records.

| Canonical role | Local `Triage:` value | Meaning |
|---|---|---|
| needs-triage | needs-triage | Awaiting assessment |
| needs-info | needs-info | Missing information |
| ready-for-agent | ready-for-agent | Specified and agent-ready |
| ready-for-human | ready-for-human | Requires human execution |
| wontfix | wontfix | Deliberately declined |

Orchestration adds two state labels beside the triage role: `needs-user` while an Issue waits for Kun's decision or approval, and `gate` on an Issue that is itself an acceptance node. See [orchestration.md](orchestration.md).

GitHub uses `bug` or `enhancement` labels independently of open/closed state and native blocking edges. Archived local records may use `Category: bug` or `Category: enhancement` independently from historical execution `Status`. Each triaged ticket has one category and one triage role.

Tickets produced from an approved specification are already specified: apply `ready-for-agent` directly, without an additional triage interview. A blocker still prevents starting work even with that label.

Active planning carries `planning`, `post-m1`, and `wayfinder:map` or `wayfinder:<type>` labels. Human interviews and prototype verdicts use `ready-for-human`; specification synthesis uses `ready-for-agent` to indicate specified work; execution waits for native blockers to close and the final handoff still requires human confirmation. Parent Map Issues are containers rather than executable child Tickets.
