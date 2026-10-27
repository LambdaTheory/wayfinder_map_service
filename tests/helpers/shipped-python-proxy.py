"""Only synthetic environment, proxy, token and service supplied by the test."""
import os
import runpy
import sys
import urllib.request

mode, proxy, launcher_path, token = sys.argv[1:]
if mode in ("system-settings", "installed-opener"):
    # Model an enabled proxy with no platform bypass; never consult macOS settings.
    urllib.request.proxy_bypass = lambda _: False
if mode == "system-settings":
    # Simulate platform discovery without inspecting or changing real OS settings.
    urllib.request.getproxies = lambda: {"http": proxy}
if mode == "installed-opener":
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy})))
control = "http://127.0.0.1:" + os.environ["WAYFINDER_AGENT_PORT"] + "/positive-control"
with urllib.request.urlopen(control) as response:
    assert response.read() == b"proxy"
opener_before = urllib.request._opener
env_before = dict(os.environ)
launcher = runpy.run_path(launcher_path)
assert launcher["probe"](token) == (200, "synthetic")
assert urllib.request._opener is opener_before
assert dict(os.environ) == env_before
with urllib.request.urlopen(control) as response:
    assert response.read() == b"proxy"
