// Real shipped transports in fresh runtimes; all endpoints and tokens are synthetic.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { freePort } from './behaviour/runner/service.ts';
import { acceptsLocalChatGptToken } from '../scripts/local-chatgpt-attach.mjs';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const token = 'synthetic-shipped-proxy-test-token';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|pythonpath|pythonhome|request_method)$/i.test(key)));
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

async function listen(server: Server) {
  const port = await freePort();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  cleanups.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return port;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wf-shipped-proxy-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const received: { method: string; session: string | undefined; body: string }[] = [];
  const service = createServer(async (req, res) => {
    if (req.url === '/positive-control') { res.end('direct'); return; }
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method!, session: req.headers['mcp-session-id'] as string | undefined,
      body: Buffer.concat(chunks).toString() });
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    res.writeHead(200, { 'mcp-session-id': 'synthetic-session', 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { instructions: 'version: synthetic' } }));
  });
  const servicePort = await listen(service);
  let authenticated = 0; let controls = 0;
  const observe = (auth: boolean, url: string) => { if (auth) authenticated++; if (url.includes('/positive-control')) controls++; };
  const proxy = createServer((req, res) => { observe(!!req.headers.authorization, req.url ?? ''); res.end('proxy'); });
  // fetch may tunnel HTTP via CONNECT. Parse complete headers even when split across packets.
  const tunnels = new Set<import('node:stream').Duplex>();
  proxy.on('connect', (_req, socket, head) => {
    tunnels.add(socket); socket.once('close', () => tunnels.delete(socket));
    socket.on('error', () => {});
    let bytes = head.toString(); let replied = false;
    const receive = (chunk: Buffer) => {
      bytes += chunk.toString();
      if (replied || !bytes.includes('\r\n\r\n')) return;
      replied = true;
      const headers = bytes.slice(0, bytes.indexOf('\r\n\r\n'));
      observe(/\r\nauthorization:/i.test(headers), headers.split('\r\n')[0]!);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy');
    };
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', receive); receive(Buffer.alloc(0));
  });
  const proxyPort = await listen(proxy);
  cleanups.push(() => { for (const socket of tunnels) socket.destroy(); });
  return { root, servicePort, proxyPort, service, received, authenticated: () => authenticated, controls: () => controls };
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  }); } finally { clearTimeout(timer); }
}

const flagSpellings = ['--use-env-proxy', '--use_env_proxy', '--use-env_proxy', '--use_env-proxy'];
const nodeModes = ['environment-only', 'env', 'explicit-config', 'default-config', 'global-proxy',
  ...flagSpellings.flatMap(flag => ['argv:' + flag, 'options:' + flag])];
test.each(nodeModes)('shipped Node attach and relay keep credentials direct: %s', async mode => {
  const f = await fixture();
  const config = join(f.root, 'node.config.json');
  writeFileSync(config, JSON.stringify({ nodeOptions: { 'use-env-proxy': true } }));
  const proxy = 'http://127.0.0.1:' + f.proxyPort;
  const env = { ...cleanEnv(), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: '', no_proxy: '', ...(mode === 'env' ? { NODE_USE_ENV_PROXY: '1' } : {}),
    ...(mode.startsWith('options:') ? { NODE_OPTIONS: mode.slice('options:'.length) } : {}) };
  const args = [...(mode.startsWith('argv:') ? [mode.slice('argv:'.length)] : []),
    ...(mode === 'explicit-config' ? ['--experimental-config-file=' + config] : mode === 'default-config' ? ['--experimental-default-config-file'] : []),
    here('./helpers/shipped-node-proxy.mjs'), mode, String(f.servicePort), String(await freePort()), token];
  const result = await run(process.execPath, args, f.root, env);
  expect(f.controls()).toBeGreaterThan(0);
  expect(f.authenticated()).toBe(0);
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(f.received.map(r => r.method)).toEqual(['POST', 'DELETE', 'POST', 'DELETE']);
  expect(f.received.filter(r => r.method === 'DELETE').every(r => r.session === 'synthetic-session')).toBe(true);
  expect(JSON.parse(f.received[0]!.body).method).toBe('initialize');
}, 15_000);

test.each([301, 302, 303, 307, 308])('authenticated probes refuse HTTP %i redirects', async status => {
  const f = await fixture();
  let originCalls = 0;
  f.service.removeAllListeners('request');
  f.service.on('request', (req, res) => {
    if (req.headers.authorization === 'Bearer ' + token) originCalls++;
    res.writeHead(status, { location: 'http://127.0.0.1:' + f.proxyPort + '/redirect-target' }).end();
  });
  expect(await acceptsLocalChatGptToken(f.servicePort, token)).toBe(false);
  const code = 'import runpy,sys; launcher=runpy.run_path(sys.argv[1]); assert launcher["post"](sys.argv[2], {})[0] == int(sys.argv[3])';
  const result = await run('python3', ['-c', code, here('../scripts/wayfinder-agent/wayfinder'), token, String(status)],
    f.root, { ...cleanEnv(), HOME: f.root, WAYFINDER_AGENT_PORT: String(f.servicePort) });
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(originCalls).toBe(2);
  expect(f.authenticated()).toBe(0);
});

test.each(['unauthorized', 'disconnect', 'timeout'])('attach probe reports %s without retaining its connection', async failure => {
  const f = await fixture();
  f.service.removeAllListeners('request');
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  f.service.once('connection', socket => socket.once('close', disconnected));
  f.service.on('request', (req, res) => {
    if (failure === 'unauthorized') res.writeHead(401).end();
    if (failure === 'disconnect') req.socket.destroy();
    // timeout deliberately leaves the owned connection unanswered.
  });
  expect(await acceptsLocalChatGptToken(f.servicePort, token)).toBe(false);
  await closed;
}, 5000);

test.each(['HTTP_PROXY', 'http_proxy', 'system-settings', 'installed-opener'])('launcher credentials ignore Python proxy source %s', async mode => {
  const f = await fixture();
  const proxy = 'http://127.0.0.1:' + f.proxyPort;
  const result = await run('python3', [here('./helpers/shipped-python-proxy.py'), mode, proxy,
    here('../scripts/wayfinder-agent/wayfinder'), token], f.root, { ...cleanEnv(), HOME: f.root,
    WAYFINDER_AGENT_PORT: String(f.servicePort), WAYFINDER_AGENT_SERVICE_DIR: join(f.root, 'svc'),
    WAYFINDER_AGENT_STATE_ROOT: f.root, WAYFINDER_AGENT_OUTPUTS: join(f.root, 'outputs'),
    NO_PROXY: '', no_proxy: '', ...(['HTTP_PROXY', 'http_proxy'].includes(mode) ? { [mode]: proxy } : {}) });
  expect(f.controls()).toBeGreaterThan(0);
  expect(f.authenticated()).toBe(0);
  expect(result, result.output).toMatchObject({ code: 0 });
  expect(f.received.map(r => r.method)).toEqual(['POST', 'DELETE']);
  expect(f.received[1]!.session).toBe('synthetic-session');
}, 15_000);
