// Regression evidence uses only synthetic credentials, the real launcher and real Seatbelt.
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { library } from '../library.ts';
import * as controllers from './controller.ts';
import * as dedicated from './dedicated.ts';
import { prepareClient, prepareSandbox, prepareSession } from './codex.ts';
import { isolationSnapshot, runAttempt } from './run.ts';
import { freePort, newToken, startService } from './service.ts';
import { syntheticClientState } from './test-state.ts';

const attack = test.skipIf(!existsSync('/usr/bin/sandbox-exec'));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() { const path = realpathSync(mkdtempSync('/private/tmp/wf-dedicated-privacy-')); roots.push(path); return path; }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fakeSource = readFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), 'utf8');

attack('a degraded service cannot make the real launcher pass the Controller credential to Codex', async () => {
  const scratch = root(); const layout = prepareSandbox(scratch); roots.push(layout.controlDir);
  const workdir = join(scratch, 'work'); mkdirSync(workdir);
  const controller = { clientId: 'Behaviour-Controller', token: newToken() };
  const serviceDir = dedicated.dedicatedServiceDirectory(); roots.push(serviceDir);
  const service = await startService(serviceDir, controller, []);
  let degrade = false;
  const proxy = createServer((req, res) => {
    if (degrade && req.headers.authorization !== `Bearer ${readFileSync(join(serviceDir, 'wayfinder-token'), 'utf8').trim()}`) { res.writeHead(401); res.end(); return; }
    const upstream = httpRequest({ host: '127.0.0.1', port: service.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${service.port}` } }, reply => { res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res); });
    upstream.once('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const port = await freePort(); await new Promise<void>(resolve => proxy.listen(port, '127.0.0.1', resolve));
  try {
    const binary = join(scratch, 'fake-client');
    writeFileSync(binary, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli fake'); process.exit(0); }
const { createHash } = await import('node:crypto');
const { writeFileSync } = await import('node:fs');
writeFileSync('client-launched', String(createHash('sha256').update(process.env.WAYFINDER_TOKEN).digest('hex') === ${JSON.stringify(digest(controller.token))}));
`, { mode: 0o700 });
    const options = { bin: prepareClient(layout.controlDir, binary), model: 'fake', effort: 'low', sandbox: true, timeoutMs: 10_000 };
    const session = prepareSession(scratch, 'A', newToken(), { contents: '{}' });
    const setup = dedicated.prepareDedicated(session, { ...service, port }, controller, options, layout, workdir);
    session.codexHome = setup.codexHome;
    const req = { options, session, port, workdir, profile: setup.profile, prompt: '' };
    const healthy = await dedicated.runDedicatedTurn(req, setup);
    expect(healthy.exitCode).toBe(0); expect(readFileSync(join(workdir, 'client-launched'), 'utf8')).toBe('false');
    rmSync(join(workdir, 'client-launched')); degrade = true;
    const refused = await dedicated.runDedicatedTurn(req, setup);
    // Compare only booleans/status, never place credential bytes into assertion output.
    expect(existsSync(join(workdir, 'client-launched'))).toBe(false);
    expect(refused.exitCode).not.toBe(0); expect(refused.stderr).toContain('refused a fallback primary credential');
    expect(existsSync(setup.capturePath)).toBe(false);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); await service.stop(); }
}, 30_000);

async function maliciousAttempt(label: string, appendix: string, exportFails = false) {
  const scratchRoot = root(); const clientState = syntheticClientState(scratchRoot);
  const bin = join(scratchRoot, 'fake-codex'); writeFileSync(bin, fakeSource + '\n' + appendix, { mode: 0o700 });
  const realLaunch = dedicated.dedicatedLaunch; const launchTokens: string[] = [];
  vi.spyOn(dedicated, 'dedicatedLaunch').mockImplementation(setup => {
    const launch = realLaunch(setup); if (launch) launchTokens.push(launch.token); return launch;
  });
  if (exportFails) {
    const realConnect = controllers.connectController;
    vi.spyOn(controllers, 'connectController').mockImplementation(async (...args) => {
      const controller = await realConnect(...args);
      return { ...controller, exportCatalog: async () => { throw new Error('synthetic catalog failure'); } };
    });
  }
  const out = join(scratchRoot, 'records'); const scenario = library.find(s => s.id === 'S12')!;
  const outcome = await runAttempt({ entry: 'dedicated', batchId: label, scenarios: [], count: 1, ceiling: 1,
    out, codex: { model: 'fake', effort: 'low', bin, sandbox: true, timeoutMs: 15_000 }, scratchRoot, ...clientState },
  { attemptId: 'D-1', scenario: { ...scenario, turns: [{ session: 'A', kind: 'opening', say: 'start' }] } }, () => false, () => undefined);
  const path = join(out, 'D-1');
  return { path, outcome, record: JSON.parse(readFileSync(join(path, 'attempt.json'), 'utf8')),
    secrets: [JSON.parse(clientState.loginSource.contents).OPENAI_API_KEY, ...launchTokens] as string[] };
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]);
}
const ownLogin = `const privacyLogin = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).OPENAI_API_KEY;`;

attack('artifact files and directories redact login/launch credentials and preserve redaction collisions', async () => {
  const f = await maliciousAttempt('PathLeaks', `${ownLogin}
for (const base of ['.', 'outputs/mcp']) {
  const dir = join(base, privacyLogin); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.env.WAYFINDER_TOKEN), 'secret-file');
  writeFileSync(join(dir, '<launcher-token-0>'), 'existing-token-placeholder');
  const placeholder = join(base, '<codex-login-A-0>'); mkdirSync(placeholder, { recursive: true });
  writeFileSync(join(placeholder, 'original'), 'existing-placeholder');
}`);
  expect(f.outcome.completeness).toBe('complete'); expect(f.secrets).toHaveLength(2);
  const retained = files(f.path);
  expect(retained.some(path => f.secrets.some(secret => path.includes(secret)))).toBe(false);
  for (const base of ['raw/work', 'raw/outputs/mcp']) {
    const content = files(join(f.path, base)).filter(p => base !== 'raw/work' || !p.startsWith(join(f.path, base, 'outputs') + '/'))
      .map(p => readFileSync(p, 'utf8'));
    expect(content.filter(v => v === 'secret-file')).toHaveLength(1);
    expect(content.filter(v => v === 'existing-placeholder')).toHaveLength(1);
    expect(content.filter(v => v === 'existing-token-placeholder')).toHaveLength(1);
  }
});

attack.each([false, true])('persisted credentials never survive as SQLite evidence (catalog failure: %s)', async exportFails => {
  const f = await maliciousAttempt(`DatabaseLeaks-${exportFails}`, `${ownLogin}
const privacyCreated = await tool('map_create', { version, mapId: 'Privacy.Leak', title: 'Synthetic privacy probe',
  destination: privacyLogin + ' ' + process.env.WAYFINDER_TOKEN });
if (privacyCreated.kind !== 'created') throw new Error('synthetic Map did not commit');
`, exportFails);
  expect(f.secrets).toHaveLength(2);
  expect(f.record.events.some((e: { kind: string; tool?: string }) => e.kind === 'tool-call' && e.tool === 'map_create')).toBe(true);
  expect(existsSync(join(f.path, 'database'))).toBe(false);
  const retained = files(f.path);
  expect(retained.some(p => f.secrets.some(secret => readFileSync(p).includes(Buffer.from(secret))))).toBe(false);
  expect(f.record.missing).toContain('raw.database');
  expect(f.record.isolation.retainedDatabase).toBeNull(); expect(f.record.isolation.databaseDirectoryRemoved).toBe(true);
  if (exportFails) { expect(f.record.missing).toContain('maps'); expect(f.outcome.completeness).toBe('driver-failed'); }
  else expect(f.record.maps).toHaveLength(1);
}, 30_000);

attack('post-turn isolation failure retains safe launch facts and names the withheld evidence', async () => {
  const uncollectable = 'synthetic-private-refresh-after-auth-change';
  const f = await maliciousAttempt('PostIsolation', `
writeFileSync('refreshed-secret', ${JSON.stringify(uncollectable)});
await tool('map_create', { version, mapId: 'Privacy.PostFailure', title: 'Synthetic refresh', destination: ${JSON.stringify(uncollectable)} });
emit({ type: 'item.started', item: { id: 'unfinished', type: 'mcp_tool_call', server: 'wayfinder', tool: 'map_create', arguments: { destination: ${JSON.stringify(uncollectable)} } } });
rmSync(join(process.env.CODEX_HOME, 'auth.json'));
const { symlinkSync } = await import('node:fs'); symlinkSync('/synthetic-forbidden-auth', join(process.env.CODEX_HOME, 'auth.json'));
`);
  expect(f.outcome.completeness).toBe('driver-failed');
  const context = JSON.parse(readFileSync(join(f.path, 'raw/entry-context.json'), 'utf8'));
  expect(context.launches).toHaveLength(1); expect(f.record.isolation.launcherInvocations).toBe(1);
  expect(f.record.missing).toContain('raw.client'); expect(f.record.missing).toContain('sessions[0].turns[0]');
  expect(files(f.path).some(path => readFileSync(path).includes(Buffer.from(uncollectable)))).toBe(false);
  expect(f.record.missing).toContain('raw.work'); expect(f.record.missing).toContain('maps');
});

test('the synthetic personal snapshot covers every Dedicated launcher-written credential/context path', () => {
  const scratch = root(); const state = syntheticClientState(scratch);
  const names = ['.wayfinder-service/credential-owners.json', '.wayfinder-service/wayfinder-token', '.codex-wayfinder/AGENTS.md'];
  const before = isolationSnapshot(state.personalConfigRoot);
  for (const name of names) { const path = join(state.personalConfigRoot, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'synthetic-change'); }
  const after = isolationSnapshot(state.personalConfigRoot);
  expect(names.every(name => before.files[join(state.personalConfigRoot, name)] !== after.files[join(state.personalConfigRoot, name)])).toBe(true);
});
