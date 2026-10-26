// Full fake Batches, owned services/proxies and synthetic login only; never a real model or daily endpoint.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as services from './service.ts';
import * as relays from './relay.ts';
import * as codex from './codex.ts';
import * as dedicated from './dedicated.ts';
import * as evidence from '../evidence.ts';
import { runBatch } from './run.ts';
import { syntheticClientState } from './test-state.ts';

const attack = test.skipIf(!existsSync('/usr/bin/sandbox-exec'));
const ownedServices: services.IsolatedService[] = [];
const ownedRoutes: relays.Route[] = [];
const roots: string[] = [];
afterEach(async () => {
  // Even a red cleanup regression must not leave the test's own process behind.
  for (const route of ownedRoutes.splice(0)) await route.close().catch(() => undefined);
  for (const service of ownedServices.splice(0)) await service.stop();
  vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const closed = (port: number) => new Promise<boolean>(resolve => { const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); });

async function fixture(appendix: string, entry: 'mcp-only' | 'dedicated' = 'mcp-only', proxyKey = 'HTTPS_PROXY') {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-proxy-privacy-')); roots.push(root);
  const clientState = syntheticClientState(root); let controllerToken = ''; let controllerExposed = false;
  const start = services.startService;
  vi.spyOn(services, 'startService').mockImplementation(async (...args) => {
    controllerToken = args[1].token;
    const service = await start(...args); ownedServices.push(service); roots.push(dirname(service.protocolReport)); return service;
  });
  const route = relays.startRoute;
  vi.spyOn(relays, 'startRoute').mockImplementation(async (...args) => { const result = await route(...args); ownedRoutes.push(result); return result; });
  const prepare = codex.prepareSandbox; const controls: string[] = [];
  vi.spyOn(codex, 'prepareSandbox').mockImplementation((...args) => { const result = prepare(...args); controls.push(result.controlDir); roots.push(result.controlDir); return result; });
  const prepareDedicated = dedicated.prepareDedicated;
  vi.spyOn(dedicated, 'prepareDedicated').mockImplementation((...args) => {
    const result = prepareDedicated(...args);
    controllerExposed ||= JSON.stringify(result.env).includes(controllerToken)
      || readFileSync(join(dirname(args[1].protocolReport), 'wayfinder-token'), 'utf8').includes(controllerToken);
    return result;
  });
  let leakedController = false; let unsafeClientRoute = false; let clientCalls = 0; const clientPids: number[] = [];
  const proxy = createServer((req, res) => {
    leakedController ||= !!controllerToken && JSON.stringify([req.url, req.headers]).includes(controllerToken);
    if (req.headers['x-fixture-kind'] === 'client') {
      const env = JSON.parse(String(req.headers['x-fixture-env'])) as Record<string, string>;
      unsafeClientRoute ||= 'WAYFINDER_NATIVE_PROXY_ENV' in env || env.NO_PROXY !== 'localhost' || !env[proxyKey]?.includes('@127.0.0.1:');
      clientCalls++; clientPids.push(Number(req.headers['x-fixture-pid'])); }
    res.writeHead(502); res.end('synthetic');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const proxyUrl = `http://run:synthetic-password-for-proxy@localhost:${port}`;
  const bin = join(root, 'fake-client.mjs');
  const source = readFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), 'utf8');
  writeFileSync(bin, source + '\n' + `
const privacyProxy = new URL(process.env.${proxyKey});
await new Promise((resolve, reject) => { import('node:http').then(({request}) => {
  const req = request({host: '127.0.0.1', port: privacyProxy.port, headers: {'x-fixture-kind':'client', 'x-fixture-pid':String(process.pid), 'x-fixture-env':JSON.stringify(process.env)}}, res => {res.resume(); res.on('end', resolve);}); req.on('error', reject); req.end(); }); });
${appendix}`, { mode: 0o700 });
  const out = join(root, 'records');
  const run = () => runBatch({ entry, batchId: 'Privacy', scenarios: ['S0b'], count: 1, ceiling: 1, out, scratchRoot: root,
    ...clientState, proxyEnv: { [proxyKey]: proxyUrl, NO_PROXY: 'localhost' },
    codex: { model: 'fake', effort: 'low', bin, sandbox: true, timeoutMs: 10_000 } });
  return { run, out, root, controls, proxyUrl, clientPids, controller: () => controllerToken, leaked: () => leakedController || controllerExposed, unsafeRoute: () => unsafeClientRoute, calls: () => clientCalls,
    close: () => new Promise<void>(resolve => proxy.close(() => resolve())) };
}

attack.each(['mcp-only', 'dedicated'] as const)('%s raw records scrub unknown fields and credential-bearing keys', async entry => {
  const f = await fixture(`
const privacyLogin = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).OPENAI_API_KEY;
emit({type:'item.completed',item:{type:'command_execution',id:'privacy',command:'echo synthetic',aggregated_output:'result ' + privacyProxy.password,exit_code:0,status:'completed'}});
emit({type:'fixture', [process.env.HTTPS_PROXY]:'url-key', [privacyLogin]:'login-key', body:'result ' + privacyProxy.password, arguments:{title:'result ' + privacyProxy.password}});
`, entry);
  try {
    const result = await f.run(); expect(result.outcomes[0]?.completeness).toBe('complete'); expect(f.calls()).toBe(2);
    const raw = files(join(f.out, 'S0b-1/raw')).map(path => readFileSync(path, 'utf8'));
    expect(raw.some(text => ['synthetic-password-for-proxy', f.proxyUrl, 'synthetic-login-for-tests-only', f.controller()].some(secret => text.includes(secret)))).toBe(false);
  } finally { await f.close(); }
});

attack('a protocol refusal still stops every owned process/relay and removes temporary controls', async () => {
  const f = await fixture(`await rpc('tools/call', {name:'map_list', arguments:{kind:process.env.HTTPS_PROXY}});`);
  try {
    const result = await f.run(); expect(result.outcomes[0]?.completeness).toBe('driver-failed');
    expect(ownedServices.every(service => !alive(service.pid))).toBe(true);
    expect(ownedServices.every(service => !existsSync(dirname(service.protocolReport)))).toBe(true);
    expect(f.clientPids.length).toBeGreaterThan(0); expect(f.clientPids.every(pid => !alive(pid))).toBe(true);
    expect(await Promise.all(ownedRoutes.map(route => closed(route.port)))).not.toContain(false);
    expect(f.controls.every(path => !existsSync(path))).toBe(true);
    expect(readdirSync(f.root).some(name => name.startsWith('wf-behave-'))).toBe(false);
  } finally { await f.close(); }
});

attack.each(['HTTP_PROXY', 'http_proxy'])('Dedicated launcher keeps Controller credentials away from %s and its client', async key => {
  const f = await fixture('', 'dedicated', key);
  try {
    const result = await f.run();
    expect(f.leaked()).toBe(false); expect(f.unsafeRoute()).toBe(false); expect(result.outcomes[0]?.completeness).toBe('complete'); expect(f.calls()).toBe(2);
  } finally { await f.close(); }
});

attack('a raw-file leak check withholds evidence even when the redactor misses a known secret', async () => {
  const f = await fixture(`emit({type:'fixture', aggregated_output:privacyProxy.password});`);
  const redact = evidence.redact;
  vi.spyOn(evidence, 'redact').mockImplementation((text, secrets) => text.includes('"aggregated_output"') ? text : redact(text, secrets));
  try {
    const result = await f.run(); expect(result.outcomes[0]?.completeness).toBe('driver-failed');
    const record = JSON.parse(readFileSync(join(f.out, 'S0b-1/attempt.json'), 'utf8'));
    expect(record.missing).toContain('raw.turn-0-A.stdout.jsonl');
    expect(existsSync(join(f.out, 'S0b-1/raw/turn-0-A.stdout.jsonl'))).toBe(false);
    expect(ownedServices.every(service => !alive(service.pid))).toBe(true);
    expect(ownedServices.every(service => !existsSync(dirname(service.protocolReport)))).toBe(true);
  } finally { await f.close(); }
});

attack.each(['preparation', 'finalization'])('unexpected %s failure still releases all Attempt resources', async phase => {
  const f = await fixture('', 'dedicated');
  if (phase === 'preparation') vi.spyOn(codex, 'prepareSession').mockImplementation(() => { throw new Error('synthetic preparation failure'); });
  else vi.spyOn(dedicated, 'dedicatedContext').mockImplementation(() => { throw new Error('synthetic finalization failure'); });
  try {
    const result = await f.run(); expect(result.outcomes[0]?.completeness).toBe('driver-failed');
    expect(ownedServices.every(service => !alive(service.pid))).toBe(true);
    expect(ownedServices.every(service => !existsSync(dirname(service.protocolReport)))).toBe(true);
    expect(f.clientPids.every(pid => !alive(pid))).toBe(true);
    expect(await Promise.all(ownedRoutes.map(route => closed(route.port)))).not.toContain(false);
    expect(f.controls.length).toBeGreaterThan(0); expect(f.controls.every(path => !existsSync(path))).toBe(true);
    expect(readdirSync(f.root).some(name => name.startsWith('wf-behave-'))).toBe(false);
  } finally { await f.close(); }
});

attack('cleanup rejection keeps the Batch outcome and saved Attempt consistently failed', async () => {
  const start = relays.startRoute;
  const f = await fixture('');
  vi.spyOn(relays, 'startRoute').mockImplementation(async (...args) => {
    const route = await start(...args); ownedRoutes.push(route); const close = route.close;
    route.close = async () => { await close(); throw new Error('synthetic close failure'); }; return route;
  });
  try {
    const result = await f.run(); expect(result.outcomes[0]?.completeness).toBe('driver-failed');
    const record = JSON.parse(readFileSync(join(f.out, 'S0b-1/attempt.json'), 'utf8'));
    expect(record.run.completeness).toBe('driver-failed');
    expect(record.missing).toContain('isolation.cleanup');
    expect(result.outcomes[0]?.record).toBe('S0b-1/attempt.json');
    expect(ownedServices.every(service => !alive(service.pid))).toBe(true);
  } finally { await f.close(); }
});
