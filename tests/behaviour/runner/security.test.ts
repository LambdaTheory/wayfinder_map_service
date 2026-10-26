// Real Seatbelt attacks against disposable files, processes and services; no model is started.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { prepareSession, runTurn, writeProfile } from './codex.ts';
import { newToken, startService } from './service.ts';

const available = spawnSync('which', ['sandbox-exec']).status === 0;
const attack = test.skipIf(!available);
const root = realpathSync(mkdtempSync('/private/tmp/wf-behave-security-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const shell = (profile: string, command: string) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', command], { encoding: 'utf8' });
function setup() {
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const a = prepareSession(scratch, 'A', newToken());
  const b = prepareSession(scratch, 'B', newToken());
  const work = join(scratch, 'work'); mkdirSync(work);
  const control = mkdtempSync(join(root, 'control-'));
  return { scratch, a, b, work, control };
}

attack('a client cannot list or read runner controls, including another session profile and a synthetic token', () => {
  const { a, b, work, control } = setup();
  const profileA = writeProfile(control, a, work, '/bin/sh');
  const profileB = writeProfile(control, b, work, '/bin/sh');
  const secret = join(control, 'controller-token'); writeFileSync(secret, 'synthetic-only');
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
      const safeControl = mkdtempSync(join(root, 'fallback-'));
      const profile = unsafe ?? writeProfile(safeControl, b, work, '/bin/sh');
      expect(shell(profile.path, `cat '${secret}'`).status, `${mode}: ${candidate}`).not.toBe(0);
      expect(rejected, `${mode}: ${candidate}`).toBe(true);
    }
  }
});

attack('sandboxed ps cannot recover session or Controller credentials and cannot publish as Controller', async () => {
  const { a, work, control } = setup();
  const cache = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests'); mkdirSync(cache, { recursive: true });
  const serviceDir = mkdtempSync(join(cache, 'security-'));
  const controller = { clientId: 'Security.Controller', token: newToken() };
  const service = await startService(serviceDir, controller, [{ clientId: 'Security.A', token: a.token }]);
  const driverDir = mkdtempSync(join(root, 'driver-'));
  const driver = join(driverDir, 'attack.mjs');
  // Strip the platform/setuid signature so Seatbelt tests process inspection rather than exec policy.
  const ps = join(driverDir, 'ps'); copyFileSync('/bin/ps', ps); chmodSync(ps, 0o755);
  expect(spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', ps]).status).toBe(0);
  writeFileSync(driver, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const { servicePid, runnerPid, port, credentials } = JSON.parse(prompt);
const listing = spawnSync(new URL('./ps', import.meta.url).pathname, ['eww', '-p', [servicePid, runnerPid, process.pid].join(','), '-o', 'command='], { encoding: 'utf8' });
if (listing.error) throw new Error('ps spawn: ' + listing.error.code);
if (listing.status !== 0) throw new Error('ps status: ' + listing.status + ' ' + listing.signal);
const tokens = [...listing.stdout.matchAll(/WAYFINDER_TOKEN=([^\\s]+)/g)].map(m => m[1]);
const response = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: {
  'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + (tokens[0] ?? 'unavailable') },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'map_create', arguments: {} } }) });
let fileReadable = false; try { readFileSync(credentials); fileReadable = true; } catch {}
console.log(JSON.stringify({ psWorked: listing.status === 0, leaked: tokens.length, envToken: !!process.env.WAYFINDER_TOKEN, status: response.status, fileReadable }));
`); chmodSync(driver, 0o755);
  try {
    const profile = writeProfile(control, a, work, driver, { localPorts: [service.port] });
    const result = await runTurn({ options: { model: 'fake', effort: 'low', bin: driver, sandbox: true, timeoutMs: 5000 },
      session: a, port: 1, workdir: work, profile,
      prompt: JSON.stringify({ servicePid: service.pid, runnerPid: process.pid, port: service.port, credentials: join(serviceDir, 'credentials.json') }) });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ psWorked: true, leaked: 0, envToken: false, status: 401, fileReadable: false });
    expect(readFileSync(join(serviceDir, 'credentials.json'), 'utf8')).not.toContain(controller.token);
  } finally { await service.stop(); rmSync(serviceDir, { recursive: true, force: true }); }
}, 20_000);

attack('a client can use only its own relay, whose credential overrides client-supplied Authorization', async () => {
  const { a, work, control } = setup();
  const { createServer } = await import('node:http');
  const { startRoute } = await import('./relay.ts');
  const { freePort } = await import('./service.ts');
  const seen: string[] = [];
  const target = createServer((req, res) => { seen.push(req.headers.authorization ?? ''); res.end('ok'); });
  const port = await freePort();
  await new Promise<void>(resolve => target.listen(port, '127.0.0.1', resolve));
  const own = await startRoute(port, 'synthetic-A', () => undefined);
  const other = await startRoute(port, 'synthetic-B', () => undefined);
  const driverDir = mkdtempSync(join(root, 'relay-driver-'));
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
  const { a, work, control } = setup();
  const systemTemp = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
  const temporary = mkdtempSync(join(systemTemp, 'wf-behave-security-'));
  const marker = join(temporary, 'marker'); writeFileSync(marker, 'synthetic');
  try {
    const profile = writeProfile(control, a, work, '/bin/sh');
    expect(shell(profile.path, `cat '${marker}'`).status).not.toBe(0);
    expect(shell(profile.path, `echo forged > '${marker}'`).status).not.toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
