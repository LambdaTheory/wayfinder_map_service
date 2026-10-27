"""Synthetic launcher/browser stubs; no service, browser, harness or private state is opened."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import webbrowser

loaded = runpy.run_path('scripts/wayfinder-agent/wayfinder')
launcher = loaded['cmd_desk'].__globals__
launcher['ensure_service'] = lambda **_: None
launcher['get_json'] = lambda _: {'desk': {}}
opened = []
key = 'k' * 43
svc = launcher['SVC']
svc.mkdir(mode=0o700, parents=True)
path = svc / 'answer-desk-key'
path.write_text(key)
path.chmod(0o600)
# This executable really records argv and env, unlike the old webbrowser.open stub.
# Prove the logger runs via Python's BROWSER controller with an unkeyed URL first.
browser_log = svc / 'browser-argv'
fake_browser = svc / 'fake-browser'
fake_browser.write_text('#!' + sys.executable + '\nimport json, os, sys\nfrom pathlib import Path\n'
                        'Path(__file__).with_name("browser-argv").write_text(json.dumps([sys.argv, dict(os.environ)]))\n')
fake_browser.chmod(0o700)
os.environ['BROWSER'] = str(fake_browser)
assert webbrowser.get().open('http://127.0.0.1/unkeyed-probe')
probe = browser_log.read_text()
assert 'unkeyed-probe' in probe and key not in probe

# Replace only the OS Apple-event endpoint, still spawning a real recorder process.
# No real service or browser is opened. The production executable, argv, environment,
# diagnostics redirection and stdin are asserted at their actual subprocess boundary.
fake_osascript = svc / 'fake-osascript.py'
fake_osascript.write_text('import json, os, sys\nfrom pathlib import Path\n'
                         'root = Path(__file__).parent\n'
                         '(root / "osascript-argv").write_text(json.dumps([sys.argv, dict(os.environ)]))\n'
                         'script = sys.stdin.read()\n(root / "osascript-stdin").write_text(script)\n'
                         'print(script)\nprint(script, file=sys.stderr)\n'
                         'sys.exit(1 if (root / "fail").exists() else 0)\n')
real_run = subprocess.run
launcher['sys'].platform = 'darwin'
def run_browser(argv, **kwargs):
    assert argv == ['/usr/bin/osascript', '-']
    assert key not in repr(argv) + repr(kwargs['env'])
    assert kwargs['env'] == {'PATH': '/usr/bin:/bin'}
    assert kwargs['stdout'] == kwargs['stderr'] == subprocess.DEVNULL
    assert kwargs['timeout'] == 30
    opened.append(kwargs['input'])
    return real_run([sys.executable, str(fake_osascript)], **kwargs)
launcher['subprocess'].run = run_browser
output = io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    launcher['cmd_desk'](['Synthetic.Map'])
script = 'open location "http://127.0.0.1:18766/maps/Synthetic.Map#key=' + key + '"\n'
assert opened == [script]
assert (svc / 'osascript-stdin').read_text() == script
assert key not in (svc / 'osascript-argv').read_text()
# BROWSER was ignored, rather than being called with a credential-bearing URL.
assert browser_log.read_text() == probe
assert key not in output.getvalue()
assert not (svc / 'launches.jsonl').exists()
assert 'http://127.0.0.1:18766/maps/Synthetic.Map' in output.getvalue()
# Orca currently has no secure URL input; it must use the same stdin path, never --url.
os.environ['ORCA_WORKTREE_ID'] = 'synthetic-worktree'
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    launcher['cmd_desk'](['Synthetic.Map'])
assert opened == [script, script]
assert '因 Orca 暂时无法安全接收地址，已在默认浏览器打开' in output.getvalue()
assert key not in output.getvalue()

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
assert len(opened) == 2
assert key not in output.getvalue()
path.unlink()
path.write_text(key)
path.chmod(0o600)
(svc / 'fail').touch()
for failure in ['exit', 'exception', 'unsupported']:
    if failure == 'exception':
        launcher['subprocess'].run = lambda *args, **kwargs: (_ for _ in ()).throw(OSError(key))
    if failure == 'unsupported':
        launcher['sys'].platform = 'linux'
        launcher['ensure_service'] = lambda **kwargs: (_ for _ in ()).throw(AssertionError('unsupported platform started service'))
        path.unlink()  # Platform guidance must precede even looking for a key.
        launcher['subprocess'].run = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('unsafe fallback'))
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            launcher['cmd_desk'](['Synthetic.Map'])
            raise AssertionError('browser error ignored')
        except SystemExit:
            pass
assert browser_log.read_text() == probe
assert key not in output.getvalue()
assert '答题入口目前只支持 macOS' in output.getvalue()
print('launcher desk verified')
