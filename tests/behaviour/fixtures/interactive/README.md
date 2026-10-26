# Synthetic interactive records

Every dialogue, identity, version and review here is invented. These files are not captures of Codex or Claude Code, and do not prove that either actual CLI exposes asynchronous questions.

- `*-supported.jsonl`: native-shaped messages, tool arguments/results and turn boundaries with useful preparation and a changed recommendation.
- `*-probe.jsonl`: a distinct earlier synthetic diagnostic for the confirmation/hash checks.
- `*-faster-only.jsonl`: the question ended its turn; a short later turn cannot prove asynchronous asking or preparation. It can still contain adjustment/continuation evidence, which needs its own semantic review.
- `*-delegation-only.jsonl`: a spawn/background launch with no completed useful research.
- `*-capture.json` and `*-probe-capture.json`: B01 Controller envelopes with requested-effort capture metadata, explicitly missing maps, rule exposure and usage because no service or model ran for the sample.
- `*-assessment.json`: unreviewed selection/confirmation shape (`reviews: []`), never a ready-made approval. Independent review inputs and outputs are generated only inside the unit tests.

The adapters deliberately accept only a conservative JSONL subset. See the [interactive runbook](../../interactive/README.md) for official source pointers, native-format limits, support confirmation and the approved-run checklist. File names and line numbers are preserved as evidence locations. `fake-host.mjs` injects an observer without personal configuration or everyday-service access for the service-only integration test; it never launches a model.
