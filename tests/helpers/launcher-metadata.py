"""Exercise the real launcher with synthetic state and harness/service stubs. Never run a model."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy

loaded = runpy.run_path("scripts/wayfinder-agent/wayfinder")
launcher = loaded["launch"].__globals__
launcher["check_harness"] = lambda *_: None
launcher["prepare_codex"] = lambda *_: None
launcher["prepare_claude"] = lambda *_: None
launcher["claude_env"] = lambda *_: dict(os.environ)
launcher["ensure_service"] = lambda **_: launcher["primary_token"]()
launcher["probe"] = lambda _: (200, "2.1.0")
launcher["say"] = lambda *_: None
executed = []
os.execvpe = lambda command, argv, env: executed.append(env)
options = {"harness": "codex", "method": "mcp", "model": "synthetic", "effort": "high"}
cwd = Path(os.environ["HOME"])

for usage in ("normal", "test"):
    os.environ["WAYFINDER_AGENT_USAGE"] = usage
    launcher["launch"](options, prompt="PRIVATE PROMPT", passthrough=("/private/path",), cwd=cwd)
records = [json.loads(line) for line in (launcher["SVC"] / "launches.jsonl").read_text().splitlines()]
assert [r["clientId"] for r in records] == ["Codex:synthetic:high"] * 2
assert [r["usage"] for r in records] == ["normal", "test"]
assert records[0]["credentialFingerprint"] != records[1]["credentialFingerprint"]
owners = launcher["load_owners"]()
for record, env in zip(records, executed):
    verifier = hashlib.sha256(env["WAYFINDER_TOKEN"].encode()).hexdigest()
    fingerprint = hashlib.sha256(("wayfinder-call-credential/1\0" + verifier).encode()).hexdigest()
    assert record["credentialFingerprint"] == fingerprint
    assert owners[verifier]["clientId"] == record["clientId"]
    assert "WAYFINDER_CLIENT_ID" not in env
    assert record["startedAt"].endswith("Z")
    assert fingerprint != verifier
    assert record["nativeSessionId"] is None and record["missing"] == ["nativeSessionId"]
    assert env["WAYFINDER_TOKEN"] not in json.dumps(records)
assert "PRIVATE PROMPT" not in json.dumps(records) and "/private/path" not in json.dumps(records)
assert (launcher["SVC"] / "launches.jsonl").stat().st_mode & 0o777 == 0o600

# Unstated use is unknown even when test path overrides are present; overrides alone do not prove intent.
del os.environ["WAYFINDER_AGENT_USAGE"]
launcher["launch"](options, cwd=cwd)
assert json.loads((launcher["SVC"] / "launches.jsonl").read_text().splitlines()[-1])["usage"] == "unknown"
os.chmod(launcher["SVC"], 0o755)
launcher["record_entry"]("Codex:synthetic:high", "codex", "mcp", "synthetic", "high")
assert launcher["SVC"].stat().st_mode & 0o777 == 0o700

os.environ["WAYFINDER_AGENT_DRY_RUN"] = "1"
with contextlib.redirect_stdout(io.StringIO()):
    launcher["launch"](dict(options, harness="claude"), resume_id="native-session-synthetic", cwd=cwd)
record = json.loads((launcher["SVC"] / "launches.jsonl").read_text().splitlines()[-1])
assert record["nativeSessionId"] == "native-session-synthetic" and record["missing"] == []
assert record["usage"] == "test" and record["harness"] == "claude"

# A log failure must not prevent the harness invocation, and has an independent visible diagnostic.
del os.environ["WAYFINDER_AGENT_DRY_RUN"]
log = launcher["SVC"] / "launches.jsonl"
log.unlink()
log.mkdir()
diagnostics = []
launcher["say"] = diagnostics.append
launcher["launch"](options, cwd=cwd)
assert len(executed) == 4
assert "Wayfinder launch metadata missing: 1 observation" in diagnostics
print("launcher metadata verified")
