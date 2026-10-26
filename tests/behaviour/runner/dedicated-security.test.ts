// Exercise the Dedicated entry with shared policy and owned files/listeners/processes/ptys only.
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareSandbox, prepareSession } from './codex.ts';
import { dedicatedServiceDirectory, prepareDedicated, runDedicatedTurn } from './dedicated.ts';
import { freePort, newToken, startService } from './service.ts';

const attack = test.skipIf(!existsSync('/usr/bin/sandbox-exec'));
const nativeAttack = test.skipIf(!existsSync('/usr/bin/sandbox-exec') || spawnSync('/usr/bin/xcode-select', ['-p']).status !== 0);
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function compile(name: string, target: string) {
  const result = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', fileURLToPath(new URL(name, import.meta.url)), '-o', target], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}
async function fixture(program: (dir: string) => string) {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-dedicated-security-'));
  const scratch = join(root, 'attempt'); mkdirSync(scratch);
  const layout = prepareSandbox(scratch);
  const workdir = join(scratch, 'work'); mkdirSync(workdir);
  const driverDir = join(layout.readOnlyDir, 'client'); mkdirSync(driverDir);
  const bin = join(driverDir, 'fake-codex'); writeFileSync(bin, program(driverDir), { mode: 0o700 });
  const options = { model: 'fake', effort: 'low', bin, sandbox: true, timeoutMs: 10_000 };
  const session = prepareSession(scratch, 'A', newToken(), { contents: '{}' });
  const controller = { clientId: 'Fixture.Controller', token: newToken() };
  const serviceDir = dedicatedServiceDirectory();
  const service = await startService(serviceDir, controller, []);
  const setup = prepareDedicated(session, service, controller, options, layout, workdir);
  session.codexHome = setup.codexHome;
  const request = { options, session, port: service.port, workdir, profile: setup.profile, prompt: '' };
  return { root, scratch, driverDir, workdir, options, session, setup, request, service,
    close: async () => { await service.stop(); rmSync(serviceDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}
const nodeFake = (body: string) => `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli fake'); process.exit(0); }
${body}
`;
const nativeFake = (source: string, args = '') => (dir: string) => {
  const probe = join(dir, 'probe'); compile(source, probe);
  return `#!/bin/sh\nif [ "$1" = '--version' ]; then echo 'codex-cli fake'; exit 0; fi\nexec ${q(probe)} ${args}\n`;
};
const input = `let input = ''; for await (const part of process.stdin) input += part;`;

attack('Dedicated allows its own IPv4 service, blocks other local ports and IPv6, and adds no proxy exception', async () => {
  const f = await fixture(() => nodeFake(`${input}
const { connect } = await import('node:net');
const targets = JSON.parse(input);
const probe = ([port, host]) => new Promise(resolve => {
  const socket = connect(port, host); socket.setTimeout(1000, () => { socket.destroy(); resolve('timeout'); });
  socket.once('connect', () => { socket.destroy(); resolve('connected'); }); socket.once('error', e => resolve(e.code));
});
console.log(JSON.stringify(await Promise.all(targets.map(probe))));`));
  const ipv4 = createServer(socket => socket.end()); const ipv6 = createServer(socket => socket.end());
  try {
    const port = await freePort(); const port6 = await freePort();
    await new Promise<void>(resolve => ipv4.listen(port, '127.0.0.1', resolve));
    await new Promise<void>(resolve => ipv6.listen(port6, '::1', resolve));
    const targets = [[f.service.port, '127.0.0.1'], [port, '127.0.0.1'], [port, 'localhost'], [port, '0.0.0.0'],
      [port, '::ffff:127.0.0.1'], [port, '::ffff:0.0.0.0'], [port6, '::1'], [f.service.port, '::ffff:127.0.0.1']] as const;
    for (const [target, host] of targets) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(target, host); socket.once('error', reject);
        socket.once('connect', () => { socket.destroy(); resolve(); });
      });
    }
    // Even a configured synthetic proxy receives no exception from Dedicated setup.
    const result = await runDedicatedTurn({ ...f.request, prompt: JSON.stringify(targets) }, {
      ...f.setup, env: { ...f.setup.env, HTTPS_PROXY: `http://127.0.0.1:${port}` },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['connected', ...Array(targets.length - 1).fill('EPERM')]);
    const policy = f.setup.controlEvidence.profile;
    for (const reserved of [18765, 18766]) expect(policy).toContain(`(deny network-outbound (remote ip "localhost:${reserved}"))`);
  } finally {
    await new Promise<void>(resolve => ipv4.close(() => resolve()));
    await new Promise<void>(resolve => ipv6.close(() => resolve())); await f.close();
  }
}, 30_000);

nativeAttack('Dedicated cannot signal or inspect outside/peer processes; self and children remain available', async () => {
  const f = await fixture(dir => {
    compile('./task-name-probe.c', join(dir, 'probe'));
    return nodeFake(`${input}
const { spawnSync } = await import('node:child_process');
const pid = Number(input);
const result = spawnSync(new URL('./probe', import.meta.url).pathname, [], { input, encoding: 'utf8' });
const signals = [0, 'SIGTERM'].map(signal => { try { process.kill(pid, signal); return 'allowed'; } catch(e) { return e.code; } });
console.log(JSON.stringify({ status: result.status, info: JSON.parse(result.stdout), signals }));`);
  });
  const peer = await fixture(() => '#!/bin/sh\nexit 0\n');
  const holders: ReturnType<typeof spawn>[] = [];
  try {
    for (const profile of [null, f.setup.profile.path, peer.setup.profile.path]) {
      const args = ['/bin/sh', '-c', 'echo ready; exec /bin/sleep 30'];
      const child = spawn(profile ? '/usr/bin/sandbox-exec' : args.shift()!, profile ? ['-f', profile, ...args] : args, { stdio: ['ignore', 'pipe', 'ignore'] });
      holders.push(child); await once(child.stdout!, 'data');
      // Native positive control reads only this owned process's numeric information counts.
      const control = spawnSync(join(f.driverDir, 'probe'), [], { input: String(child.pid), encoding: 'utf8' });
      expect(JSON.parse(control.stdout).external.procBytes).toBeGreaterThan(0);
      const result = await runDedicatedTurn({ ...f.request, prompt: String(child.pid) }, f.setup);
      expect(result.exitCode, result.stderr).toBe(0);
      const probe = JSON.parse(result.stdout);
      expect(probe.signals).toEqual(['EPERM', 'EPERM']); expect(probe.status).toBe(0);
      expect(probe.info.external).toMatchObject({ procBytes: 0, words: [0, 0, 0, 0] });
      expect(probe.info.external.portResult).not.toBe(0);
      for (const target of [probe.info.self, probe.info.child]) {
        expect(target.portResult).toBe(0); expect(target.procBytes).toBeGreaterThan(0);
        expect(target.words.every((n: number) => n > 0)).toBe(true);
      }
      expect(probe.info.childSignal).toBe(15); expect(probe.info.childListed).toBe(0);
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    }
  } finally { for (const child of holders) { child.kill(); await once(child, 'exit'); } await f.close(); await peer.close(); }
}, 30_000);

nativeAttack.each(['stdin', 'tty'])('Dedicated TIOCSTI via %s cannot inject into a disposable outside shell', async mode => {
  const f = await fixture(nativeFake('./terminal-injection-probe.c'));
  try {
    const marker = join(f.root, 'escaped-marker');
    writeFileSync(join(f.workdir, 'injection-input'), `${marker}\n${mode}\n`);
    const launch = ['/usr/bin/python3', '-I', f.setup.launcher, '--harness', 'codex', '--method', 'mcp', '--model', 'fake', '--effort', 'low', '--', 'exec'].map(q).join(' ');
    const command = `${launch}; status=$?; if IFS= read -r -t 1 injected; then eval "$injected"; fi; exit "$status"`;
    f.setup.verify();
    const result = spawnSync(join(f.driverDir, 'probe'), ['--operator', command], {
      cwd: f.workdir, env: f.setup.env, encoding: 'utf8', timeout: 12_000,
    });
    expect(result.status, result.stderr).toBe(0); f.setup.verify();
    expect(JSON.parse(readFileSync(join(f.workdir, 'injection-result.json'), 'utf8'))).toEqual({ directError: 1, accepted: 0, injectionError: 1 });
    expect(existsSync(marker)).toBe(false);
  } finally { await f.close(); }
}, 20_000);

nativeAttack('Dedicated keeps controlling-terminal operations and denies another same-user pty', async () => {
  const f = await fixture(nativeFake('./tty-probe.c'));
  try {
    const result = spawnSync(join(f.driverDir, 'probe'), [f.setup.profile.path], { encoding: 'utf8', timeout: 8000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.match(/\{[^\r\n]+\}/)![0])).toEqual({ ownRead: 1, ownWrite: 1,
      windowSize: 1, attributes: 1, rawMode: 1, ttyAttributes: 1, peerReadError: 1, peerWriteError: 1 });
    f.setup.verify();
  } finally { await f.close(); }
});

nativeAttack('Dedicated can allocate a pty but cannot open outside, same-profile or other-profile peers', async () => {
  const f = await fixture(nativeFake('./pty-scope-probe.c', '$(cat peers)'));
  const peer = await fixture(() => '#!/bin/sh\nexit 0\n');
  const holders: ReturnType<typeof spawn>[] = [];
  try {
    const names: string[] = [];
    // Use a workdir copy in the other profile, without granting either client the other's staging tree.
    const peerProbe = join(peer.workdir, 'probe'); compile('./pty-scope-probe.c', peerProbe);
    for (const profile of [null, f.setup.profile.path, peer.setup.profile.path]) {
      const binary = profile === peer.setup.profile.path ? peerProbe : join(f.driverDir, 'probe');
      const child = spawn(profile ? '/usr/bin/sandbox-exec' : binary, profile ? ['-f', profile, binary, '--hold'] : ['--hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
      holders.push(child);
      const [chunk] = await once(child.stdout!, 'data'); names.push(String(chunk).trim());
      expect(names.at(-1)).toMatch(/^\/dev\/ttys[0-9]+$/);
    }
    writeFileSync(join(f.workdir, 'peers'), names.join(' '));
    const result = await runDedicatedTurn(f.request, f.setup);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ opened: 1, reopened: 1, readable: 1, writable: 1,
      peers: names.map(() => ({ readError: 1, writeError: 1 })) });
  } finally {
    for (const child of holders) { child.stdin!.end(); await once(child, 'exit'); }
    await f.close(); await peer.close();
  }
}, 30_000);

attack.each(['home', 'launcher-home', 'hardlink'])('Dedicated rejects %s identity substitution before launch', async kind => {
  const f = await fixture(() => nodeFake("console.log('unexpected-launch')"));
  try {
    if (kind === 'hardlink') linkSync(f.setup.sourceAuth, join(f.workdir, 'auth-alias'));
    else {
      const path = kind === 'home' ? f.session.home : f.setup.launcherHome;
      renameSync(path, path + '.saved'); symlinkSync(path + '.saved', path);
    }
    await expect(runDedicatedTurn(f.request, f.setup)).rejects.toThrow(/isolation failure/);
    expect(existsSync(f.setup.capturePath)).toBe(false);
  } finally { await f.close(); }
});

attack('Dedicated checks shared immutable hashes after a turn as well as before it', async () => {
  const f = await fixture(() => nodeFake("console.log('synthetic-run')"));
  try {
    const result = await runDedicatedTurn({ ...f.request, onChild: () => {
      // Trusted fault injection: the client itself cannot change the staged launcher.
      appendFileSync(f.setup.launcher, '\n# trusted integrity fault\n'); return () => undefined;
    } }, f.setup);
    expect(result.postIsolationFailure).toMatch(/isolation failure/);
  } finally { await f.close(); }
});
