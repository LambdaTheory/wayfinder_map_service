import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launcher } from './host.ts';
import { launch, readManifest } from './launch.ts';
import { startRoute } from '../runner/relay.ts';
import { freePort } from '../runner/service.ts';
import type { InteractiveClient } from './native.ts';

const attack = test.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(client: InteractiveClient, code: string, port: number) {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-interactive-launch-')); dirs.push(root);
  const scratch = join(root, 'attempt'); mkdirSync(scratch);
  const subscriptionHome = join(root, 'subscription'); mkdirSync(join(subscriptionHome, '.codex'), { recursive: true });
  writeFileSync(join(subscriptionHome, '.codex/auth.json'), 'synthetic-login');
  const driver = join(root, 'fake-client.mjs');
  writeFileSync(driver, '#!/usr/bin/env node\n' + code); chmodSync(driver, 0o700);
  const prepared = launcher({ scratch, client, bin: driver, port, model: 'fake', effort: 'low', subscriptionHome,
    proxyEnv: { HTTPS_PROXY: 'http://synthetic-proxy.invalid', NO_PROXY: '127.0.0.1', ANTHROPIC_API_KEY: 'excluded-key', EXTRA: 'excluded-setting' } });
  dirs.push(prepared.controlDir);
  const manifest = readManifest(prepared.manifestPath, prepared.manifestHash);
  return { ...prepared, manifest, scratch, subscriptionHome, work: manifest.workdir };
}

attack('the interactive client reaches its credential relay but cannot read or alter runner controls or the source login', async () => {
  const received: string[] = [];
  const server = createServer((req, res) => { received.push(req.headers.authorization ?? ''); res.end('ok'); });
  const port = await freePort();
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const route = await startRoute(port, 'synthetic-session-token', () => undefined);
  try {
    const f = fixture('codex', `
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync('attack.json', 'utf8'));
const readable = path => { try { readFileSync(path); return true; } catch { return false; } };
const writable = path => { try { writeFileSync(path, 'forged'); return true; } catch { return false; } };
const status = async port => { try { return (await fetch('http://127.0.0.1:' + port + '/mcp', { headers: { Authorization: 'Bearer forged' }, signal: AbortSignal.timeout(1000) })).status; } catch { return 'denied'; } };
writeFileSync('result.json', JSON.stringify({
  reads: input.controls.map(readable), writes: input.controls.map(writable), source: readable(input.source),
  ownLogin: readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8'),
  own: await status(input.relay), direct: await status(input.direct),
  tokens: Object.keys(process.env).filter(k => /TOKEN|API_KEY/.test(k)),
}));
`, route.port);
    writeFileSync(join(f.work, 'attack.json'), JSON.stringify({ controls: [f.manifestPath, f.profile.path, join(f.controlDir, 'launch.once')],
      source: join(f.subscriptionHome, '.codex/auth.json'), relay: route.port, direct: port }));
    writeFileSync(join(f.subscriptionHome, '.codex/auth.json'), 'synthetic-latest-login');
    expect(await launch(f.manifestPath, f.manifestHash, { WAYFINDER_TOKEN: 'excluded-token', OPENAI_API_KEY: 'excluded-key' })).toBe(0);
    expect(JSON.parse(readFileSync(join(f.work, 'result.json'), 'utf8'))).toEqual({ reads: [false, false, false], writes: [false, false, false], source: false,
      ownLogin: 'synthetic-latest-login', own: 200, direct: 'denied', tokens: [] });
    expect(received).toEqual(['Bearer synthetic-session-token']);
    expect(readFileSync(join(f.subscriptionHome, '.codex/auth.json'), 'utf8')).toBe('synthetic-latest-login');
    expect(statSync(f.profile.mutableReadOnlyFiles[0]!).mode & 0o777).toBe(0o600);
  } finally { await route.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

attack.each(['manifest', 'profile'] as const)('an altered %s refuses the interactive process before launch', async target => {
  const f = fixture('codex', `import { writeFileSync } from 'node:fs'; writeFileSync('started', 'yes');`, 23456);
  writeFileSync(target === 'manifest' ? f.manifestPath : f.profile.path, 'forged');
  await expect(launch(f.manifestPath, f.manifestHash, {})).rejects.toThrow(/isolation failure/);
  expect(existsSync(join(f.work, 'started'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.controlDir, 'launch.jsonl'), 'utf8'))).toMatchObject({ phase: 'refused', launched: false });
});

attack('a trusted control mutation during an interactive process is recorded on exit', async () => {
  let path = '';
  const server = createServer((_req, res) => { writeFileSync(path, 'forged'); res.end('ok'); });
  const port = await freePort();
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const f = fixture('codex', `await (await fetch('http://127.0.0.1:${port}')).text();`, port);
    path = f.profile.path;
    expect(await launch(f.manifestPath, f.manifestHash, {})).toBe(1);
    const events = readFileSync(join(f.controlDir, 'launch.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ phase: 'exited', launched: true, code: 0, isolationFailure: expect.stringContaining('changed') });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

attack('Claude subscription authentication uses a descriptor and keeps the six-variable proxy filter', async () => {
  const f = fixture('claude', `
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync(Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), 'utf8');
writeFileSync('result.json', JSON.stringify({ subscription: token === 'synthetic-subscription', env: process.env }));
`, 23456);
  expect(await launch(f.manifestPath, f.manifestHash, { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-subscription', ANTHROPIC_API_KEY: 'excluded-key', EXTRA: 'excluded-setting' })).toBe(0);
  const result = JSON.parse(readFileSync(join(f.work, 'result.json'), 'utf8'));
  expect(result.subscription).toBe(true);
  expect(result.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', HTTPS_PROXY: 'http://synthetic-proxy.invalid', NO_PROXY: '127.0.0.1' });
  for (const key of ['WAYFINDER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'EXTRA']) expect(result.env).not.toHaveProperty(key);
});

attack.each(['after exit', 'while running'])('a launcher refuses a second attempt %s', async timing => {
  const f = fixture('codex', `import { appendFileSync } from 'node:fs'; appendFileSync('starts', 'x');`, 23456);
  const first = launch(f.manifestPath, f.manifestHash, {});
  if (timing === 'after exit') expect(await first).toBe(0);
  await expect(launch(f.manifestPath, f.manifestHash, {})).rejects.toThrow(/already attempted/);
  expect(await first).toBe(0);
  expect(readFileSync(join(f.work, 'starts'), 'utf8')).toBe('x');
  const rows = readFileSync(join(f.controlDir, 'launch.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.phase === 'started')).toHaveLength(1);
  expect(rows.find(row => row.duplicateLaunch)).toMatchObject({ phase: 'refused', launched: false });
  expect(rows.find(row => row.duplicateLaunch)).not.toHaveProperty('launchFailure');
});

attack('a refused launch also consumes the Attempt and requires a fresh command', async () => {
  const f = fixture('claude', `import { writeFileSync } from 'node:fs'; writeFileSync('started', 'yes');`, 23456);
  await expect(launch(f.manifestPath, f.manifestHash, {})).rejects.toThrow(/setup-token/);
  await expect(launch(f.manifestPath, f.manifestHash, { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-subscription' })).rejects.toThrow(/already attempted/);
  expect(existsSync(join(f.work, 'started'))).toBe(false);
});
