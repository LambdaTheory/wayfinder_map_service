// Real Seatbelt, owned ephemeral listeners and synthetic settings only; no model or daily endpoint.
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { proxyEnvironment, proxyRouting, proxyVariables } from '../proxy.ts';
import { launcher } from '../interactive/host.ts';
import { launch } from '../interactive/launch.ts';
import { prepareSandbox, prepareSession, runTurn, writeProfile } from './codex.ts';

const root = realpathSync(mkdtempSync('/private/tmp/wf-shared-proxy-'));
const controls: string[] = [];
afterAll(() => { controls.forEach(p => rmSync(p, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); });
const attack = test.skipIf(process.platform !== 'darwin');
async function listener(host = '127.0.0.1') {
  let count = 0;
  const server = createServer(socket => { count++; socket.on('error', () => undefined); socket.end('synthetic proxy'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host, ipv6Only: host === '::1' }, resolve); });
  const port = (server.address() as { port: number }).port;
  // No probing a reserved endpoint, even if a local port allocator ever changes its range.
  if ([17897, 18765, 18766].includes(port)) { server.close(); throw new Error('unexpected fixture port'); }
  return { port, count: () => count, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function reachable(port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, host); socket.on('data', () => undefined);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('positive control timed out')); });
    socket.once('end', resolve); socket.once('error', reject);
  });
}
const modes = ['runner', 'shared-api', 'interactive-codex', 'interactive-claude'] as const;
attack.each(modes.flatMap(mode => ['settings', 'terminal', 'none'].map(source => ({ mode, source }))))(
  '$mode admits only the relay and configured proxy ($source)', async ({ mode, source }) => {
  const proxy = await listener(); const relay = await listener(); const other = await listener();
  const wildcard = await listener('0.0.0.0'); const ipv6 = await listener('::1');
  const subscription = mkdtempSync(join(root, 'subscription-'));
  mkdirSync(join(subscription, '.codex')); writeFileSync(join(subscription, '.codex/auth.json'), 'synthetic-login');
  mkdirSync(join(subscription, '.claude'));
  const url = `http://synthetic-user:synthetic-password@localhost:${proxy.port}`;
  const selected = source === 'none' ? {} : Object.fromEntries(proxyVariables.map(key => [key, key.toLowerCase() === 'no_proxy' ? '127.0.0.1,localhost' : url]));
  writeFileSync(join(subscription, '.claude/settings.json'), JSON.stringify({ env: {
    ...(source === 'settings' ? selected : source === 'terminal' ? { HTTPS_PROXY: 'http://localhost:18766' } : {}),
    ALL_PROXY: 'ignored', NODE_OPTIONS: 'ignored', ANTHROPIC_API_KEY: 'synthetic-do-not-forward',
  }, hooks: { ignored: true } }));
  const input = proxyEnvironment(subscription, source === 'terminal' ? selected : {});
  const expected = proxyRouting(input).environment;
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const fake = join(root, `client-${mode}-${source}.mjs`);
  writeFileSync(fake, `#!${process.execPath}
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
const tcp = (port, host = '127.0.0.1') => new Promise(resolve => {
  const s = connect(port, host); let data = '';
  s.setTimeout(1000, () => { s.destroy(); resolve('timeout'); });
  s.on('data', chunk => { data += chunk; });
  s.once('end', () => resolve(data === 'synthetic proxy' ? 'connected' : 'wrong response'));
  s.once('error', e => resolve(e.code));
});
const udp = (port, host, type) => new Promise(resolve => {
  const s = createSocket(type);
  s.send('fixture', port, host, error => { s.close(); resolve(error?.code ?? 'sent'); });
});
for (const key of ${JSON.stringify(proxyVariables)}) assert.equal(process.env[key], ${JSON.stringify(expected)}[key]);
for (const key of ['ALL_PROXY', 'all_proxy', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined);
assert.throws(() => readFileSync(${JSON.stringify(join(subscription, '.claude/settings.json'))}), {code: 'EPERM'});
assert.equal(await tcp(${relay.port}), 'connected');
assert.equal(await tcp(${proxy.port}), ${JSON.stringify(source === 'none' ? 'EPERM' : 'connected')});
for (const port of [${other.port}, ${wildcard.port}]) {
  for (const host of ['127.0.0.1', '127.1', 'localhost', '0.0.0.0', '::ffff:127.0.0.1', '::ffff:0.0.0.0'])
    assert.equal(await tcp(port, host), 'EPERM', host + ':' + port);
}
for (const port of [${proxy.port}, ${relay.port}]) {
  for (const host of ['::ffff:127.0.0.1', '::ffff:0.0.0.0']) assert.equal(await tcp(port, host), 'EPERM');
  for (const host of ['127.0.0.1', '0.0.0.0']) assert.equal(await udp(port, host, 'udp4'), 'EPERM');
  for (const host of ['::1', '::ffff:127.0.0.1', '::ffff:0.0.0.0']) assert.equal(await udp(port, host, 'udp6'), 'EPERM');
}
assert.equal(await tcp(${ipv6.port}, '::1'), 'EPERM');
writeFileSync('result', 'passed');
`, { mode: 0o700 });
  try {
    // Establish that the blocked aliases reach live owned listeners without Seatbelt.
    for (const [port, host] of [[other.port, '127.1'], [other.port, 'localhost'], [wildcard.port, '0.0.0.0'],
      [other.port, '::ffff:127.0.0.1'], [wildcard.port, '::ffff:0.0.0.0'], [ipv6.port, '::1']] as const) await reachable(port, host);
    const blockedCounts = [other.count(), wildcard.count(), ipv6.count()];
    let work: string;
    let profilePath: string;
    if (mode.startsWith('interactive')) {
      const prepared = launcher({ scratch, client: mode === 'interactive-codex' ? 'codex' : 'claude', bin: fake,
        port: relay.port, model: 'fixture', effort: 'low', subscriptionHome: subscription, proxyEnv: input });
      controls.push(prepared.controlDir); work = join(scratch, 'work'); profilePath = prepared.profile.path;
      expect(await launch(prepared.manifestPath, prepared.manifestHash, { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-subscription' })).toBe(0);
    } else {
      const session = prepareSession(scratch, 'A', 'synthetic', null);
      work = join(scratch, 'work'); mkdirSync(work);
      const layout = prepareSandbox(scratch); controls.push(layout.controlDir);
      // Shared API consumer (the Dedicated Entry contract) stages its own intentional client assets.
      const clientDir = join(layout.readOnlyDir, 'client'); mkdirSync(clientDir);
      const bin = join(clientDir, 'client.mjs'); writeFileSync(bin, readFileSync(fake), { mode: 0o700 });
      const profile = writeProfile(layout.controlDir, session, work, bin, { localPorts: [relay.port], proxyEnv: input });
      profilePath = profile.path;
      if (mode === 'runner') {
        const result = await runTurn({ options: { model: 'fixture', effort: 'low', bin, sandbox: true, timeoutMs: 8000 },
          session, port: relay.port, workdir: work, profile, prompt: '' });
        expect(result.exitCode, result.stderr).toBe(0);
      } else {
        const code = await new Promise<number | null>(resolve => {
          const child = spawn('/usr/bin/sandbox-exec', ['-f', profile.path, bin], { cwd: work,
            env: { PATH: '/usr/bin:/bin', HOME: session.home, ...profile.proxyEnvironment }, stdio: 'inherit' });
          child.once('close', resolve);
        });
        expect(code).toBe(0);
      }
    }
    expect(readFileSync(join(work, 'result'), 'utf8')).toBe('passed');
    const policy = readFileSync(profilePath, 'utf8');
    for (const port of [18765, 18766]) expect(policy).toContain(`(deny network-outbound (remote ip "localhost:${port}"))`);
    expect(proxy.count()).toBe(source === 'none' ? 0 : 1); expect(relay.count()).toBe(1);
    expect([other.count(), wildcard.count(), ipv6.count()]).toEqual(blockedCounts);
  } finally { await Promise.all([proxy.close(), relay.close(), other.close(), wildcard.close(), ipv6.close()]); }
}, 15_000);

test.each([18765, 18766])('reserved proxy port %i is refused before any shared client starts', port => {
  const scratch = mkdtempSync(join(root, 'reserved-'));
  const session = prepareSession(scratch, 'A', 'synthetic', null);
  const work = join(scratch, 'work'); mkdirSync(work);
  const { controlDir } = prepareSandbox(scratch); controls.push(controlDir);
  for (const host of ['localhost', '127.0.0.1', '[::ffff:127.0.0.1]', 'proxy.invalid']) {
    const proxyEnv = { HTTPS_PROXY: `http://${host}:${port}` };
    expect(() => writeProfile(controlDir, session, work, '/bin/sh', { proxyEnv })).toThrow(/reserved Wayfinder port/);
    expect(() => launcher({ scratch, client: 'codex', bin: '/bin/sh', port: 12345, model: 'fixture', effort: 'low',
      subscriptionHome: '/nonexistent-unread-subscription', proxyEnv })).toThrow(/reserved Wayfinder port/);
  }
});

attack('UDP positive controls reach owned IPv4 and IPv6 listeners without the sandbox', async () => {
  for (const [type, host] of [['udp4', '127.0.0.1'], ['udp6', '::1']] as const) {
    const server = createSocket(type); const client = createSocket(type);
    try {
      await new Promise<void>(resolve => server.bind(0, host, resolve));
      const received = new Promise<string>(resolve => server.once('message', data => resolve(data.toString())));
      client.send('fixture', server.address().port, host);
      expect(await received).toBe('fixture');
    } finally { client.close(); server.close(); }
  }
});
