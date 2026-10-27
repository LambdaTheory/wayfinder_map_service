"""Synthetic launcher/browser stubs; no service, browser, harness or private state is opened."""
import contextlib
import io
import os
from pathlib import Path
import runpy

loaded = runpy.run_path('scripts/wayfinder-agent/wayfinder')
launcher = loaded['cmd_desk'].__globals__
launcher['ensure_service'] = lambda **_: None
launcher['get_json'] = lambda _: {'desk': {}}
opened = []
launcher['webbrowser'].open = lambda url, **_: opened.append(url) or True
key = 'k' * 43
svc = launcher['SVC']
svc.mkdir(mode=0o700, parents=True)
path = svc / 'answer-desk-key'
path.write_text(key)
path.chmod(0o600)
output = io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    launcher['cmd_desk'](['Synthetic.Map'])
assert opened == ['http://127.0.0.1:18766/maps/Synthetic.Map#key=' + key]
assert key not in output.getvalue()
assert not (svc / 'launches.jsonl').exists()
for change in ['disabled', 'shared', 'symlink']:
    launcher['get_json'] = lambda _: {} if change == 'disabled' else {'desk': {}}
    if change == 'shared':
        path.chmod(0o644)
    if change == 'symlink':
        path.unlink()
        target = svc / 'target'
        target.write_text(key)
        target.chmod(0o600)
        path.symlink_to(target)
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            launcher['cmd_desk'](['Synthetic.Map'])
            raise AssertionError('unsafe desk was opened')
        except SystemExit:
            pass
assert len(opened) == 1
assert key not in output.getvalue()
path.unlink()
path.write_text(key)
path.chmod(0o600)
launcher['webbrowser'].open = lambda *args, **kwargs: (_ for _ in ()).throw(OSError(key))
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    try:
        launcher['cmd_desk'](['Synthetic.Map'])
        raise AssertionError('browser error ignored')
    except SystemExit:
        pass
assert key not in output.getvalue()
print('launcher desk verified')
