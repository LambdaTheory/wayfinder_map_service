// Synthetic settings and fake clients only; never load the real user's settings or credentials.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { CliReviewDriver, reviewSandbox } from './review-cli.ts';
import { ReviewProxyError, reviewProxyEnvironment, reviewProxyRules, reviewProxyVariables } from './review-proxy.ts';

const root = mkdtempSync(join(tmpdir(), 'wayfinder-review-proxy-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
function home(settings?: unknown): string {
  const dir = mkdtempSync(join(root, 'home-')); mkdirSync(join(dir, '.claude'));
  if (settings !== undefined) writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(settings));
  return dir;
}

describe('proxy selection and validation', () => {
  test('only the six proxy keys are selected, with terminal values (including empty) taking precedence', () => {
    const env = { HTTP_PROXY: 'http://127.0.0.1:1234', HTTPS_PROXY: 'http://127.0.0.1:2345', NO_PROXY: 'fixture.invalid',
      http_proxy: 'http://localhost:3456', https_proxy: 'http://localhost:4567', no_proxy: 'another.invalid',
      ALL_PROXY: 'ignored', all_proxy: 'ignored', ANTHROPIC_API_KEY: 'synthetic-do-not-forward', NODE_OPTIONS: 'ignored', OTHER: 'ignored' };
    const inherited = { HTTPS_PROXY: 'http://127.0.0.1:5678', NO_PROXY: '', ALL_PROXY: 'ignored', OPENAI_API_KEY: 'synthetic-do-not-forward' };
    const selected = reviewProxyEnvironment(home({ env, hooks: { ignored: true } }), inherited);
    expect(selected).toEqual({ HTTP_PROXY: env.HTTP_PROXY, HTTPS_PROXY: inherited.HTTPS_PROXY, NO_PROXY: '',
      http_proxy: env.http_proxy, https_proxy: env.https_proxy, no_proxy: env.no_proxy });
  });
  test('missing settings and no proxies preserve the existing network policy', () => {
    const selected = reviewProxyEnvironment(home(), {});
    expect(selected).toEqual({}); expect(reviewProxyRules(selected)).toEqual([]);
    const profile = reviewSandbox(root, root, root, undefined, undefined, selected);
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:*"))');
    expect(profile).not.toContain('(allow network-outbound');
  });
  test.each([null, [], 'private fixture', { env: null }, { env: [] }, { env: 'private fixture' }])(
    'invalid settings shape returns a fixed error without its contents (%j)', settings => {
      expect(() => reviewProxyEnvironment(home(settings), {})).toThrow('Review proxy settings unavailable; refusing to fall back to a direct connection');
    });
  test('invalid JSON, unreadable settings and proxy value types do not leak contents or paths', () => {
    const malformed = home(); const path = join(malformed, '.claude/settings.json');
    writeFileSync(path, '{synthetic-private-content');
    expect(() => reviewProxyEnvironment(malformed, {})).toThrow(new ReviewProxyError('Review proxy settings unavailable; refusing to fall back to a direct connection'));
    rmSync(path); mkdirSync(path);
    expect(() => reviewProxyEnvironment(malformed, {})).toThrow(new ReviewProxyError('Review proxy settings unavailable; refusing to fall back to a direct connection'));
    expect(() => reviewProxyEnvironment(home({ env: { HTTPS_PROXY: { private: 'fixture' } } }), {}))
      .toThrow(new ReviewProxyError('Review proxy setting must be a string'));
  });
  test('only exact loopback TCP endpoints create rules; bypass lists and remote proxies add no local access', () => {
    expect(reviewProxyRules({ HTTP_PROXY: 'http://127.1:2345', HTTPS_PROXY: 'http://127.0.0.1:2345',
      http_proxy: 'http://localhost', https_proxy: 'https://[::1]', NO_PROXY: 'localhost:18766', ALL_PROXY: 'http://127.0.0.1:9999' }))
      .toEqual(['(allow network-outbound (remote tcp4 "localhost:2345"))',
        '(allow network-outbound (remote tcp "localhost:80"))', '(allow network-outbound (remote tcp6 "localhost:443"))']);
    expect(reviewProxyRules({ HTTPS_PROXY: 'https://proxy.invalid:443', NO_PROXY: '*', no_proxy: '127.0.0.1' })).toEqual([]);
  });
  test.each(['not a URL', 'http://localhost:99999', 'http://localhost:0', 'file:///private/fixture', 'socks5://localhost:1234'])(
    'invalid or unsupported proxy URLs fail without echoing the URL (%s)', value => {
      expect(() => reviewProxyRules({ HTTPS_PROXY: value })).toThrow(ReviewProxyError);
      try { reviewProxyRules({ HTTPS_PROXY: value }); } catch (error) { expect(String(error)).not.toContain(value); }
    });
  test.each([18765, 18766])('reserved port %i cannot gain a proxy exception', port => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]', 'proxy.invalid'])
      expect(() => reviewProxyRules({ HTTPS_PROXY: `http://${hostname}:${port}` })).toThrow('Review proxy uses a reserved Wayfinder port');
  });
});

async function listener(hostname = '127.0.0.1') {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end('synthetic proxy'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, hostname, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return { port: address.port, connections: () => connections,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function clearProxyEnvironment() { for (const key of reviewProxyVariables) vi.stubEnv(key, undefined); }

describe.skipIf(process.platform !== 'darwin')('real sandbox with fake reviewers and proxy listeners', () => {
  test.each(['claude', 'codex'] as const)('%s refuses reserved ports and malformed settings before launching', async cli => {
    clearProxyEnvironment(); vi.stubEnv('PATH', '/usr/bin:/bin'); // No native model executable can be found.
    for (const settings of [{ env: { HTTPS_PROXY: 'http://127.0.0.1:18766' } }, null]) {
      const driver = new CliReviewDriver(5000, home(settings));
      const response = await driver.invoke({ id: 'fixture', kind: 'availability', target: { cli, model: 'fixture' }, input: 'No real model.' });
      expect(response.status).toBe('unavailable');
      expect(response.detail).toBe(settings ? 'Review proxy uses a reserved Wayfinder port' : 'Review proxy settings unavailable; refusing to fall back to a direct connection');
      expect(response.invocation).toBeUndefined();
    }
  });
  test.each(['claude', 'codex'].flatMap(cli => ['127.0.0.1', '::1', 'localhost'].map(hostname => ({ cli: cli as 'claude' | 'codex', hostname }))))(
    '$cli connects only to its $hostname proxy, using settings or terminal routing', async ({ cli, hostname }) => {
    const connectHost = hostname === 'localhost' ? '127.0.0.1' : hostname;
    const proxy = await listener(connectHost); const unrelated = await listener(connectHost);
    try {
      for (const source of ['settings', 'terminal', 'none'] as const) {
        clearProxyEnvironment();
        const proxyUrl = `http://${hostname === '::1' ? '[::1]' : hostname}:${proxy.port}`;
        const expected = source === 'none' ? {} : Object.fromEntries(reviewProxyVariables.map(key => [key, key.toLowerCase() === 'no_proxy' ? 'fixture.invalid' : proxyUrl]));
        const subscriptionHome = home({ env: { ...(source === 'settings' ? expected : {}),
          ...(source === 'terminal' ? { HTTPS_PROXY: 'http://127.0.0.1:18766' } : {}),
          ALL_PROXY: 'ignored', NODE_OPTIONS: 'ignored', ANTHROPIC_API_KEY: 'synthetic-do-not-forward' } });
        if (source === 'terminal') for (const [key, value] of Object.entries(expected)) vi.stubEnv(key, value);
        vi.stubEnv('ALL_PROXY', `http://127.0.0.1:${unrelated.port}`);
        vi.stubEnv('all_proxy', `http://127.0.0.1:${unrelated.port}`);
        vi.stubEnv('OPENAI_API_KEY', 'synthetic-do-not-forward');
        const install = mkdtempSync(join(root, 'install-')); const binDir = join(install, 'bin'); mkdirSync(binDir);
        writeFileSync(join(binDir, cli), `#!${process.execPath}
const assert = require('node:assert/strict'); const net = require('node:net'); const fs = require('node:fs'); const dgram = require('node:dgram');
async function connect(port, hostname = ${JSON.stringify(connectHost)}) {
  return new Promise(resolve => {
    const socket = net.connect(port, hostname); let data = '';
    socket.setTimeout(1500, () => { socket.destroy(); resolve('timeout'); });
    socket.on('data', chunk => { data += chunk; });
    socket.once('end', () => resolve(data === 'synthetic proxy' ? 'connected' : 'unexpected response'));
    socket.once('error', error => resolve(error.code));
  });
}
async function sendUdp(port) {
  return new Promise(resolve => {
    const socket = dgram.createSocket(${JSON.stringify(connectHost === '::1' ? 'udp6' : 'udp4')});
    socket.send('synthetic packet', port, ${JSON.stringify(connectHost)}, error => { socket.close(); resolve(error?.code ?? 'sent'); });
  });
}
(async () => {
  const expected = ${JSON.stringify(expected)};
  for (const key of ${JSON.stringify(reviewProxyVariables)}) assert.equal(process.env[key], expected[key]);
  for (const key of ['ALL_PROXY', 'all_proxy', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined);
  assert.throws(() => fs.readFileSync(${JSON.stringify(join(subscriptionHome, '.claude/settings.json'))}), {code:'EPERM'});
  assert.equal(await connect(${proxy.port}), ${JSON.stringify(source === 'none' ? 'EPERM' : 'connected')});
  assert.equal(await sendUdp(${proxy.port}), 'EPERM');
  ${hostname === 'localhost' ? '' : `assert.equal(await connect(${proxy.port}, ${JSON.stringify(connectHost === '::1' ? '127.0.0.1' : '::1')}), 'EPERM');`}
  for (const port of [18765, 18766, ${unrelated.port}]) assert.equal(await connect(port), 'EPERM');
  if (process.argv.includes('status')) {
    console.log(${JSON.stringify(cli === 'claude' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT')}); return;
  }
  const events = ${JSON.stringify(cli === 'claude'
    ? [{ type: 'system', subtype: 'init', model: 'fixture', tools: [], mcp_servers: [] },
      { type: 'assistant', message: { id: 'msg-fixture', model: 'fixture', content: [] } },
      { type: 'result', subtype: 'success', result: 'AVAILABLE' }]
    : [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'item.completed', item: { id: 'fixture', type: 'agent_message', text: 'AVAILABLE' } }, { type: 'turn.completed' }])};
  for (const event of events) console.log(JSON.stringify(event));
})().catch(error => { console.error('fake reviewer failed: ' + error.message); process.exitCode = 1; });
`, { mode: 0o700 });
        vi.stubEnv('PATH', `${binDir}:/usr/bin:/bin`);
        const response = await new CliReviewDriver(5000, subscriptionHome).invoke({ id: 'fixture', kind: 'availability', target: { cli, model: 'fixture' }, input: 'No real model.' });
        expect(response.status, response.detail + response.stderr).toBe('complete');
        expect(response.text).toBe('AVAILABLE');
      }
      expect(proxy.connections()).toBe(4); // Two routed runs, each with login and review.
      expect(unrelated.connections()).toBe(0);
    } finally { await proxy.close(); await unrelated.close(); }
  });
});
