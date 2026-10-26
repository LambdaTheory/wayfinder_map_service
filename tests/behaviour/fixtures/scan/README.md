# Synthetic usage evidence

Every word, ID, fingerprint, request, launch and outcome here is invented. These are format fixtures, not historical runs or proof of a product failure. `input.json` selects only this directory; `deliberately-absent.jsonl` must remain absent. `attempt.json` is a minimal B01 evidence projection for request correlation, not a runnable complete Attempt.

| Sample | Expected observation |
| --- | --- |
| `codex/skill-only.jsonl` | Explicit Skill invocation with no observed MCP call; completeness remains unknown |
| `codex/read-a.jsonl`, `codex/read-b.jsonl` | Same Combination, distinct sessions/fingerprints; only A has an exact B01 request bridge |
| `codex/question-write.jsonl` | A question followed by a write; pending until original context is reviewed |
| `codex/refusal.jsonl` | Version refusal, distinct from service failure |
| `codex/conflict.jsonl` | Conflict; no automatic verdict about subsequent client behaviour |
| `claude/normal.jsonl` | Explicit normal HITL approval followed by a write, never automatically failed |
| `claude/research.jsonl` | Skill invocation with an explicit operator research label |
| `claude/sidechain.jsonl` | Child shares the parent's native ID but cannot inherit its launch/calls; purpose stays unknown |
| `missing-log` launch | Metadata without native words; pending |
| `chatgpt` launch | Metadata without words; no automatic request for human words |
| `service.calls.gaps.jsonl` | A missing-observation counter from a previous service process |

Unit tests add malformed records, ambiguous joins, duplicate/hashed request IDs, explicit reviews and repeated scans without reading any real logs.
