import { syntheticClientState } from './test-state.ts';
// Real Seatbelt attacks against disposable files, processes and services; no model is started.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { prepareClient, prepareSandbox, prepareSession, prepareWorkdir, runTurn, writeProfile } from './codex.ts';
import { newToken, startService } from './service.ts';

const available = spawnSync('which', ['sandbox-exec']).status === 0;
const attack = test.skipIf(!available);
const root = realpathSync(mkdtempSync('/private/tmp/wf-behave-security-'));
const clientState = syntheticClientState(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const shell = (profile: string, command: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', command], { encoding: 'utf8' });
function setup() {
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const a = prepareSession(scratch, 'A', newToken(), clientState.loginSource);
  const b = prepareSession(scratch, 'B', newToken(), clientState.loginSource);
  const work = join(scratch, 'work'); mkdirSync(work);
  const { controlDir: control, readOnlyDir } = prepareSandbox(scratch);
  return { scratch, a, b, work, control, readOnlyDir };
}

attack('a client cannot list or read runner controls, including another session profile and a synthetic token', () => {
  const { a, b, work, control } = setup();
  const profileA = writeProfile(control, a, work, '/bin/sh');
  const profileB = writeProfile(control, b, work, '/bin/sh');
  const secret = join(control, 'controller-token'); writeFileSync(secret, 'synthetic-only');
  expect(shell(profileB.path, `ls -ld '${control}'`).status).toBe(0); // Metadata is intentionally public.
  expect(shell(profileB.path, `ls '${control}'`).status).not.toBe(0);
  expect(shell(profileB.path, `cat '${profileA.path}'`).status).not.toBe(0);
  expect(shell(profileB.path, `cat '${secret}'`).status).not.toBe(0);
  expect(shell(profileB.path, `echo forged > '${secret}'`).status).not.toBe(0);
});

attack('ancestor and sibling read grants are rejected before a sandbox can expose another HOME', () => {
  const { scratch, a, b, work, control } = setup();
  const secret = join(a.home, 'marker'); writeFileSync(secret, 'synthetic-only');
  const link = join(work, 'alias'); symlinkSync(scratch, link);
  for (const candidate of [scratch, root, link, a.home, homedir(), '/private/tmp', '/']) {
    for (const mode of ['control', 'read-only']) {
      let rejected = false;
      let unsafe: ReturnType<typeof writeProfile> | undefined;
      try { unsafe = mode === 'control' ? writeProfile(candidate, b, work, '/bin/sh')
        : writeProfile(control, b, work, '/bin/sh', { readOnlyRoots: [candidate] }); }
      catch { rejected = true; }
      // If the guard misses, this executes the attacker using the overbroad profile.
      const safeControl = prepareSandbox(scratch).controlDir;
      const profile = unsafe ?? writeProfile(safeControl, b, work, '/bin/sh');
      expect(shell(profile.path, `cat '${secret}'`).status, `${mode}: ${candidate}`).not.toBe(0);
      expect(rejected, `${mode}: ${candidate}`).toBe(true);
    }
  }
});

attack('sandboxed ps cannot recover session or Controller credentials and cannot publish as Controller', async () => {
  const { a, work, control, readOnlyDir } = setup();
  const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests'); mkdirSync(cache, { recursive: true });
  const serviceDir = mkdtempSync(join(cache, 'security-'));
  const controller = { clientId: 'Security.Controller', token: newToken() };
  const service = await startService(serviceDir, controller, [{ clientId: 'Security.A', token: a.token }]);
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { PROBE_API_KEY: 'synthetic-unrelated-api-key', PROBE_OTHER: 'synthetic-unrelated-value' }, stdio: 'ignore' });
  const driverDir = mkdtempSync(join(readOnlyDir, 'driver-'));
  const driver = join(driverDir, 'attack.mjs');
  // Strip the platform/setuid signature so Seatbelt tests process inspection rather than exec policy.
  const ps = join(driverDir, 'ps'); copyFileSync('/bin/ps', ps); chmodSync(ps, 0o755);
  expect(spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', ps]).status).toBe(0);
  const visible = spawnSync(ps, ['eww', '-p', String(victim.pid), '-o', 'command='], { encoding: 'utf8' });
  expect(visible.stdout.includes('synthetic-unrelated-api-key')).toBe(true);
  writeFileSync(driver, `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const { victimPid, port, credentials } = JSON.parse(prompt);
const inspections = [['eww', '-p', String(victimPid), '-o', 'command='], ['-E', '-p', String(victimPid), '-o', 'command=']].map(args => {
  const listing = spawnSync(new URL('./ps', import.meta.url).pathname, args, { encoding: 'utf8' });
  return { executed: typeof listing.status === 'number', bytes: (listing.stdout ?? '').length };
});
const response = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: {
  'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + 'unavailable' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'map_create', arguments: {} } }) });
let fileReadable = false; try { readFileSync(credentials); fileReadable = true; } catch {}
console.log(JSON.stringify({ inspections, envToken: !!process.env.WAYFINDER_TOKEN, status: response.status, fileReadable }));
`); chmodSync(driver, 0o755);
  try {
    const profile = writeProfile(control, a, work, driver, { localPorts: [service.port] });
    const prompt = JSON.stringify({ victimPid: victim.pid, port: service.port, credentials: join(serviceDir, 'credentials.json') });
    const result = await runTurn({ options: { model: 'fake', effort: 'low', bin: driver, sandbox: true, timeoutMs: 5000 },
      session: a, port: 1, workdir: work, profile,
      prompt });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ inspections: [{ executed: true, bytes: 0 }, { executed: true, bytes: 0 }], envToken: false, status: 401, fileReadable: false });
    // A future launcher must not depend on runTurn's detached session for process privacy.
    // spawnSync stays in the caller's session/process group.
    const attached = spawnSync('sandbox-exec', ['-f', profile.path, driver], { cwd: work, input: prompt,
      env: { PATH: process.env.PATH, HOME: a.home, CODEX_HOME: a.codexHome, TMPDIR: join(a.home, 'tmp') },
      encoding: 'utf8', timeout: 5000 });
    expect(attached.status, attached.stderr).toBe(0);
    expect(JSON.parse(attached.stdout)).toEqual({ inspections: [{ executed: true, bytes: 0 }, { executed: true, bytes: 0 }], envToken: false, status: 401, fileReadable: false });
    expect(readFileSync(join(serviceDir, 'credentials.json'), 'utf8')).not.toContain(controller.token);
  } finally { victim.kill(); await service.stop(); rmSync(serviceDir, { recursive: true, force: true }); }
}, 20_000);

attack('Mach task-name inspection denies an outside process but permits the client and its child in either launch mode', async () => {
  const { a, work, control, readOnlyDir } = setup();
  const driverDir = mkdtempSync(join(readOnlyDir, 'task-name-'));
  const driver = join(driverDir, 'probe');
  const source = fileURLToPath(new URL('./task-name-probe.c', import.meta.url));
  const compiled = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', source, '-o', driver], { encoding: 'utf8' });
  expect(compiled.status, compiled.stderr).toBe(0);
  const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  type Observation = { portResult: number; words: number[] };
  type Probe = { external: Observation; self: Observation; child: Observation; childSignal: number };
  const readable = (result: Observation) => {
    expect(result.portResult).toBe(0);
    expect(result.words).toHaveLength(4);
    expect(result.words.every(count => count > 0)).toBe(true);
  };
  const isolated = (text: string) => {
    const result = JSON.parse(text) as Probe;
    expect(result.external.portResult).not.toBe(0);
    expect(result.external.words).toEqual([0, 0, 0, 0]);
    readable(result.self); readable(result.child);
    expect(result.childSignal).toBe(15);
  };
  try {
    await new Promise<void>(resolve => victim.once('spawn', resolve));
    const prompt = String(victim.pid);
    const env = { PATH: process.env.PATH, HOME: a.home, CODEX_HOME: a.codexHome, TMPDIR: join(a.home, 'tmp') };
    const outside = spawnSync(driver, [], { input: prompt, env, encoding: 'utf8', timeout: 5000 });
    expect(outside.status, outside.stderr).toBe(0);
    readable((JSON.parse(outside.stdout) as Probe).external);
    const profile = writeProfile(control, a, work, driver);
    const attached = spawnSync('sandbox-exec', ['-f', profile.path, driver], { cwd: work, input: prompt, env, encoding: 'utf8', timeout: 5000 });
    expect(attached.status, attached.stderr).toBe(0);
    const detached = await runTurn({ options: { model: 'fake', effort: 'low', bin: driver, sandbox: true, timeoutMs: 5000 },
      session: a, port: 1, workdir: work, profile, prompt });
    expect(detached.exitCode, detached.stderr).toBe(0);
    isolated(attached.stdout); isolated(detached.stdout);
    expect(victim.exitCode).toBeNull(); expect(victim.signalCode).toBeNull();
  } finally { victim.kill(); }
}, 20_000);

attack('a client can use only its own relay, whose credential overrides client-supplied Authorization', async () => {
  const { a, work, control, readOnlyDir } = setup();
  const { createServer } = await import('node:http');
  const { startRoute } = await import('./relay.ts');
  const { freePort } = await import('./service.ts');
  const seen: string[] = [];
  const target = createServer((req, res) => { seen.push(req.headers.authorization ?? ''); res.end('ok'); });
  const port = await freePort();
  await new Promise<void>(resolve => target.listen(port, '127.0.0.1', resolve));
  const own = await startRoute(port, 'synthetic-A', () => undefined);
  const other = await startRoute(port, 'synthetic-B', () => undefined);
  const driverDir = mkdtempSync(join(readOnlyDir, 'relay-driver-'));
  const driver = join(driverDir, 'attack.mjs');
  writeFileSync(driver, `#!/usr/bin/env node
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const { own, other, direct } = JSON.parse(prompt);
const probe = async port => { try { return (await fetch('http://127.0.0.1:' + port + '/mcp', { headers: { Authorization: 'Bearer forged-controller' } })).status; } catch { return 'denied'; } };
console.log(JSON.stringify([await probe(own), await probe(other), await probe(direct)]));
`); chmodSync(driver, 0o755);
  try {
    const profile = writeProfile(control, a, work, driver, { localPorts: [own.port] });
    const result = await runTurn({ options: { model: 'fake', effort: 'low', bin: driver, sandbox: true, timeoutMs: 5000 },
      session: a, port: own.port, workdir: work, profile, prompt: JSON.stringify({ own: own.port, other: other.port, direct: port }) });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([200, 'denied', 'denied']);
    expect(seen).toEqual(['Bearer synthetic-A']);
  } finally { await own.close(); await other.close(); await new Promise<void>(resolve => target.close(() => resolve())); }
});

attack('the per-user system temp cannot carry data between sessions', () => {
  const { a, work, control, readOnlyDir } = setup();
  const systemTemp = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
  const temporary = mkdtempSync(join(systemTemp, 'wf-behave-security-'));
  const marker = join(temporary, 'marker'); writeFileSync(marker, 'synthetic');
  try {
    const profile = writeProfile(control, a, work, '/bin/sh');
    expect(shell(profile.path, `cat '${marker}'`).status).not.toBe(0);
    expect(shell(profile.path, `echo forged > '${marker}'`).status).not.toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

attack('read grants cannot expose another Attempt or a private subtree through a root or file', () => {
  const { a, work, control, readOnlyDir } = setup();
  const foreign = setup();
  const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests'); mkdirSync(cache, { recursive: true });
  const cached = mkdtempSync(join(cache, 'read-grant-'));
  const userTemp = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
  const temporary = mkdtempSync(join(userTemp, 'wf-behave-grant-'));
  try {
    for (const dir of [foreign.a.home, cached, temporary, foreign.control]) {
      const marker = join(dir, 'private-marker'); writeFileSync(marker, 'synthetic-private');
      for (const access of [{ readOnlyRoots: [dir] }, { mutableReadOnlyFiles: [marker] }]) {
        let unsafe: ReturnType<typeof writeProfile> | undefined;
        try { unsafe = writeProfile(control, a, work, '/bin/sh', access); } catch { /* refused before launch */ }
        if (unsafe) expect(shell(unsafe.path, `cat '${marker}'`).status).not.toBe(0);
        expect(unsafe).toBeUndefined();
      }
    }
  } finally { rmSync(cached, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true }); }
});

attack('placing a client executable in the scratch cannot grant its parent and expose a peer HOME', () => {
  const { scratch, a, b, work, control } = setup();
  const marker = join(b.home, 'private-marker'); writeFileSync(marker, 'synthetic-private');
  const bin = join(scratch, 'client'); copyFileSync('/bin/echo', bin);
  let unsafe: ReturnType<typeof writeProfile> | undefined;
  try { unsafe = writeProfile(control, a, work, bin); } catch { /* refused before launch */ }
  if (unsafe) expect(shell(unsafe.path, `cat '${marker}'`).status).not.toBe(0);
  expect(unsafe).toBeUndefined();
});

attack('a mutable read-only grant refuses a hard link even when its alias is inside the workdir', () => {
  const { a, b, work, control } = setup();
  const marker = join(b.home, 'private-marker'); writeFileSync(marker, 'synthetic-private');
  const alias = join(work, 'linked-auth'); linkSync(marker, alias);
  let unsafe: ReturnType<typeof writeProfile> | undefined;
  try { unsafe = writeProfile(control, a, work, '/bin/sh', { mutableReadOnlyFiles: [alias] }); } catch { /* refused before launch */ }
  if (unsafe) expect(shell(unsafe.path, `cat '${alias}'`).status).not.toBe(0);
  expect(unsafe).toBeUndefined();
});

attack('a Node executable placed above an Attempt cannot grant that enclosing directory', () => {
  const base = mkdtempSync(join(root, 'node-install-'));
  const executable = join(base, 'node'); copyFileSync(process.execPath, executable); chmodSync(executable, 0o700);
  expect(spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', executable]).status).toBe(0);
  const module = new URL('./sandbox.ts', import.meta.url).href;
  const probe = spawnSync(executable, ['--input-type=module', '-e', `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { prepareSandbox, writeProfile } from ${JSON.stringify(module)};
    const scratch = join(process.argv[1], 'attempt'); mkdirSync(scratch);
    const home = join(scratch, 'session'); mkdirSync(home);
    const work = join(scratch, 'work'); mkdirSync(work);
    const marker = join(scratch, 'private-marker'); writeFileSync(marker, 'synthetic');
    const { controlDir } = prepareSandbox(scratch);
    try {
      const profile = writeProfile(controlDir, { home }, work, '/bin/sh');
      const attack = spawnSync('sandbox-exec', ['-f', profile.path, '/bin/cat', marker], { stdio: 'ignore' });
      console.log(JSON.stringify({ refused: false, readable: attack.status === 0 }));
    } catch { console.log(JSON.stringify({ refused: true })); }
  `, base], { encoding: 'utf8', timeout: 10_000 });
  expect(probe.status, probe.stderr).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual({ refused: true });
});

attack('a symlinked workdir cannot grant read or write access to caches, system temp or another HOME', () => {
  const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests'); mkdirSync(cache, { recursive: true });
  const cached = mkdtempSync(join(cache, 'work-link-'));
  const userTemp = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
  const temporary = mkdtempSync(join(userTemp, 'wf-behave-work-'));
  const foreign = setup();
  try {
    for (const target of [cached, temporary, foreign.b.home]) {
      const { scratch, a, work, control } = setup();
      const marker = join(target, 'private-marker'); writeFileSync(marker, 'synthetic-private');
      rmSync(work, { recursive: true }); symlinkSync(target, work);
      let preparationRefused = false;
      try { prepareWorkdir(scratch, [], root); } catch { preparationRefused = true; }
      let unsafe: ReturnType<typeof writeProfile> | undefined;
      try { unsafe = writeProfile(control, a, work, '/bin/sh'); } catch { /* refused before launch */ }
      if (!unsafe) { rmSync(work); mkdirSync(work); }
      const profile = unsafe ?? writeProfile(control, a, work, '/bin/sh');
      expect(shell(profile.path, `cat '${marker}'`).status).not.toBe(0);
      expect(shell(profile.path, `echo forged > '${marker}'`).status).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('synthetic-private');
      expect(preparationRefused).toBe(true);
      expect(unsafe).toBeUndefined();
    }
  } finally { rmSync(cached, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true }); }
});

attack('a HOME replaced with a peer HOME symlink is refused before granting access', () => {
  const { scratch, a, b, work, control } = setup();
  const marker = join(b.home, 'private-marker'); writeFileSync(marker, 'synthetic-private');
  rmSync(a.home, { recursive: true }); symlinkSync(b.home, a.home);
  let unsafe: ReturnType<typeof writeProfile> | undefined;
  try { unsafe = writeProfile(control, a, work, '/bin/sh'); } catch { /* refused before launch */ }
  if (!unsafe) { rmSync(a.home); prepareSession(scratch, 'A', 'synthetic', clientState.loginSource); }
  const profile = unsafe ?? writeProfile(control, a, work, '/bin/sh');
  expect(shell(profile.path, `cat '${marker}'`).status).not.toBe(0);
  expect(shell(profile.path, `echo forged > '${marker}'`).status).not.toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe('synthetic-private');
  expect(unsafe).toBeUndefined();
});

attack('a client at the staging root cannot expose sibling content or grant the whole staging tree', () => {
  const { a, b, work, control, readOnlyDir } = setup();
  const marker = join(readOnlyDir, 'peer-login'); writeFileSync(marker, 'synthetic-private');
  const source = join(readOnlyDir, 'client.sh'); copyFileSync('/bin/echo', source);
  const client = prepareClient(control, source);
  const profile = writeProfile(control, a, work, client);
  expect(shell(profile.path, `cat '${marker}'`).status).not.toBe(0);
  expect(client).not.toBe(source);
  // Direct writeProfile callers cannot recreate the broad grant that prepareClient avoids.
  for (const access of [{ bin: source }, { bin: client, readOnlyRoots: [readOnlyDir] }]) {
    let unsafe: ReturnType<typeof writeProfile> | undefined;
    try { unsafe = writeProfile(control, b, work, access.bin, access); } catch { /* refused before launch */ }
    if (unsafe) expect(shell(unsafe.path, `cat '${marker}'`).status).not.toBe(0);
    expect(unsafe).toBeUndefined();
  }
});

attack('a client cannot probe or terminate an unrelated process but can terminate its own child', async () => {
  const { a, work, control, readOnlyDir } = setup();
  const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const driverDir = mkdtempSync(join(readOnlyDir, 'signal-'));
  const driver = join(driverDir, 'attack.mjs');
  writeFileSync(driver, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const pid = Number(prompt);
const probe = signal => { try { process.kill(pid, signal); return 'allowed'; } catch (e) { return e.code; } };
const external = [probe(0), probe('SIGTERM')];
const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
await new Promise(resolve => child.once('spawn', resolve));
child.kill('SIGTERM');
const childSignal = await new Promise(resolve => child.once('exit', (_, signal) => resolve(signal)));
console.log(JSON.stringify({ external, childSignal }));
`); chmodSync(driver, 0o755);
  try {
    const profile = writeProfile(control, a, work, driver);
    const result = await runTurn({ options: { model: 'fake', effort: 'low', bin: driver, sandbox: true, timeoutMs: 5000 },
      session: a, port: 1, workdir: work, profile, prompt: String(victim.pid) });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ external: ['EPERM', 'EPERM'], childSignal: 'SIGTERM' });
    // spawnSync stays in the caller's session/process group.
    const attached = spawnSync('sandbox-exec', ['-f', profile.path, driver], { cwd: work, input: String(victim.pid),
      env: { PATH: process.env.PATH, HOME: a.home, CODEX_HOME: a.codexHome, TMPDIR: join(a.home, 'tmp') },
      encoding: 'utf8', timeout: 5000 });
    expect(attached.status, attached.stderr).toBe(0);
    expect(JSON.parse(attached.stdout)).toEqual({ external: ['EPERM', 'EPERM'], childSignal: 'SIGTERM' });
    expect(victim.exitCode).toBeNull();
    expect(victim.signalCode).toBeNull();
    expect(() => process.kill(victim.pid!, 0)).not.toThrow();
  } finally { victim.kill(); }
});
