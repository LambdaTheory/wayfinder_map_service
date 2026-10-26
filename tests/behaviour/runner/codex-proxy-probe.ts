// Optional local capability probe: `node tests/behaviour/runner/codex-proxy-probe.ts`.
// Calls only `codex mcp login` against a fake endpoint in an empty HOME. Never starts a model,
// reads a real login/settings file, completes OAuth, or permits outbound traffic beyond its fake proxy.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSandbox, writeProfile } from './sandbox.ts';

if (process.platform !== 'darwin') throw new Error('This probe requires macOS sandbox-exec');
const cases: [string | null, string, string?][] = [
  ['HTTP_PROXY', 'http'], ['http_proxy', 'http'], ['HTTPS_PROXY', 'https'], ['https_proxy', 'https'],
  ['ALL_PROXY', 'https'], ['all_proxy', 'https'], ['HTTPS_PROXY', 'https', 'NO_PROXY'], ['HTTPS_PROXY', 'https', 'no_proxy'], [null, 'https'],
];
for (const [key, protocol, bypass] of cases) {
  let reached = false;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    socket.once('data', () => { reached = true; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  });
  const scratch = mkdtempSync('/private/tmp/wf-codex-proxy-probe-');
  const home = join(scratch, 'home'); const work = join(scratch, 'work');
  mkdirSync(home); mkdirSync(work); mkdirSync(join(home, '.codex'));
  const layout = prepareSandbox(scratch);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    if ([17897, 18765, 18766].includes(port)) throw new Error('Unexpected fixture port');
    const proxyUrl = `http://127.0.0.1:${port}`;
    const profile = writeProfile(layout.controlDir, { home }, work, 'codex', { proxyEnv: { HTTPS_PROXY: proxyUrl } });
    // Narrow further than the shared sandbox: even non-loopback public egress is impossible here.
    const policy = readFileSync(profile.path, 'utf8') + `\n(deny network*)(allow network-outbound (remote tcp4 "localhost:${port}"))`;
    // ALL_PROXY is deliberately tested here as a native capability; it is never forwarded by the shared API.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: home,
      ...(key ? { [key]: proxyUrl } : {}), ...(bypass ? { [bypass]: 'probe.invalid' } : {}) };
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, 'codex', '--no-daemon', '-c',
      `mcp_servers.fixture.url="${protocol}://probe.invalid/mcp"`, 'mcp', 'login', 'fixture'],
    { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.resume(); let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timer = setTimeout(kill, 5000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => { clearTimeout(timer); kill(); });
    // Report classifications only, never raw CLI/configuration output or endpoint values.
    console.log(JSON.stringify({ key: key ?? 'none', protocol, bypass: bypass ?? 'none', fakeProxyReached: reached,
      exit: code, usageError: stderr.includes('unexpected argument'), oauthAttempt: /OAuth|oauth|authorization|discovery/i.test(stderr) }));
  } finally {
    sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(layout.controlDir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  }
}
