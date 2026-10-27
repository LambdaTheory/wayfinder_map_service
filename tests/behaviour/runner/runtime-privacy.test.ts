// Each case starts Node afresh: environment-proxy mode is selected before module initialization.
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const attack = test.skipIf(!existsSync('/usr/bin/sandbox-exec'));
const here = fileURLToPath(new URL('.', import.meta.url));
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy)$/i.test(key)));

async function fixture(entry: 'mcp-only' | 'dedicated', mode: string, appendix = '', watchdogMs = 0, history = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-runtime-privacy-'));
  const echoedTokens: string[] = []; const descendants = new Set<number>(); let descendantRequests = 0;
  const watcher = watch(root, {recursive:true}, (_event, path) => {
    if (path?.endsWith('owned-fixture-pids.json')) try { for (const pid of JSON.parse(readFileSync(join(root,path), 'utf8'))) descendants.add(pid); } catch { /* own file creation/removal */ }
  });
  let watchdogFired = false; const started = Date.now();
  let nativeProxyCalls = 0;
  let runnerPid = 0; let credentialsAtProxy = 0; let requestsAtProxy = 0; let positiveControl = 0;
  const allowed = (port: number) => {
    if ([18765, 18766].includes(port)) return false;
    try {
      const pids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n');
      return pids.length > 0 && pids.every(pid => Number(pid) === process.pid || Number(pid) === runnerPid
        || Number(execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf8' }).trim()) === runnerPid);
    } catch { return false; }
  };
  const proxy = createServer((req, res) => {
    if (req.headers['x-native-probe']) { nativeProxyCalls++; res.end('native-proxy-fixture'); return; }
    if (req.headers['x-descendant']) { descendants.add(Number(req.headers['x-descendant'])); descendantRequests++; res.end('fixture'); return; }
    if (req.headers['x-synthetic-token']) { echoedTokens.push(String(req.headers['x-synthetic-token'])); res.end('fixture'); return; }
    requestsAtProxy++; if (req.headers.authorization) credentialsAtProxy++;
    if (req.url?.includes('/positive-control')) positiveControl++;
    let target: URL;
    try { target = new URL(req.url!); } catch { res.writeHead(400); res.end('absolute proxy URL required'); return; }
    if (target.hostname !== '127.0.0.1' || !allowed(Number(target.port))) { res.writeHead(502).end(); return; }
    const upstream = request(target, { method: req.method, headers: req.headers, agent: false }, reply => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  const sockets = new Set<import('node:net').Socket>();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    const target = new URL(`http://${req.url}`);
    if (target.hostname !== '127.0.0.1' || !allowed(Number(target.port))) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = connect(Number(target.port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    // Only counters leave the fixture; never print a captured authorization value.
    socket.on('data', bytes => { const text = bytes.toString(); if (/^(POST|GET|DELETE) /m.test(text)) requestsAtProxy++;
      if (/\r\nauthorization:/i.test(text)) credentialsAtProxy++;
      if (text.includes('/positive-control')) positiveControl++;
    });
    socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const positive = createServer((_req, res) => res.end('synthetic'));
  await new Promise<void>(resolve => positive.listen(0, '0.0.0.0', resolve));
  const target = (positive.address() as { port: number }).port;
  const ownIp = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address ?? '127.0.0.1';
  const udp = createSocket('udp4'); await new Promise<void>(resolve => udp.bind(0, '0.0.0.0', resolve));
  const udpPort = udp.address().port;
  if (appendix.includes('__OWNED_IP__')) {
    await new Promise<void>((resolve,reject) => { const c=connect(target,ownIp,()=>{c.destroy();resolve();});c.on('error',reject); });
    await new Promise<void>((resolve,reject) => { udp.once('message',()=>resolve());udp.send('positive-control',udpPort,ownIp,error=>{if(error)reject(error);}); });
  }
  appendix = appendix.replaceAll('__UPSTREAM_PORT__', String(port)).replaceAll('__PUBLIC_PORT__', String(target)).replaceAll('__UDP_PORT__', String(udpPort)).replaceAll('__OWNED_IP__', JSON.stringify(ownIp));
  const bin = join(root, 'fake-client.mjs');
  writeFileSync(bin, readFileSync(join(here, 'fake-codex.mjs'), 'utf8') + '\n' + appendix, { mode: 0o700 });
  const proxyUrl = `http://run:synthetic%40proxy-password@localhost:${port}`;
  const childScript = join(root, 'batch.mjs');
  writeFileSync(childScript, `
import { runBatch } from ${JSON.stringify(pathToFileURL(join(here, 'run.ts')).href)};
import { library } from ${JSON.stringify(pathToFileURL(join(here, '../library.ts')).href)};
import { setGlobalProxyFromEnv } from 'node:http';
import { syntheticClientState } from ${JSON.stringify(pathToFileURL(join(here, 'test-state.ts')).href)};
if (${JSON.stringify(mode)} === 'global-dispatcher') {
  await (await fetch('http://127.0.0.1:${target}/initialize-dispatcher')).text();
  setGlobalProxyFromEnv({HTTP_PROXY:'http://127.0.0.1:${port}',NO_PROXY:'localhost'});
}
await fetch('http://127.0.0.1:${target}/positive-control');
if (${history}) library.find(s => s.id === 'S0b').seed = {restores:'history',fixtures:[],maps:[{
  mapId:'Proxy.History',title:'Before',destination:'Synthetic seed',notes:'',tickets:[],
  history:[{author:'Proxy.Historical',commands:[{kind:'map.update',patch:{title:'After'}}]}]
}]};
const result = await runBatch({entry:${JSON.stringify(entry)},batchId:'RuntimePrivacy',scenarios:['S0b'],count:1,ceiling:1,
  out:${JSON.stringify(join(root, 'records'))},scratchRoot:${JSON.stringify(root)},...syntheticClientState(${JSON.stringify(root)}),
  proxyEnv:{HTTPS_PROXY:${JSON.stringify(proxyUrl)},NO_PROXY:'localhost'},
  codex:{model:'fake',effort:'low',bin:${JSON.stringify(bin)},sandbox:true,timeoutMs:3000}});
process.send(result);
`);
  const config = join(root, 'node.config.json');
  writeFileSync(config, JSON.stringify({nodeOptions:{'use-env-proxy':true}}));
  const args = [...(mode.startsWith('argv') ? [mode.split(':')[1] ?? '--use-env-proxy'] : []),
    ...(mode === 'explicit-config' ? ['--experimental-config-file=' + config] : mode === 'default-config' ? ['--experimental-default-config-file'] : []), childScript];
  const env = { ...safeEnv(), HTTP_PROXY: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
    NO_PROXY: 'localhost', no_proxy: 'localhost', ...(mode === 'env' ? { NODE_USE_ENV_PROXY: '1' } : {}),
    ...(mode.startsWith('options') ? { NODE_OPTIONS: mode.split(':')[1] ?? '--use-env-proxy' } : {}) };
  const child = spawn(process.execPath, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); runnerPid = child.pid!;
  let terminal = ''; let result: Awaited<ReturnType<typeof import('./run.ts').runBatch>> | undefined;
  child.stdout!.on('data', d => { terminal += d; }); child.stderr!.on('data', d => { terminal += d; });
  child.on('message', message => { result = message as typeof result; });
  const watchdog = watchdogMs ? setTimeout(() => { watchdogFired = true; for (const pid of descendants) try { process.kill(pid,'SIGKILL'); } catch {} }, watchdogMs) : undefined;
  const code = await new Promise<number | null>(resolve => child.on('close', resolve)); clearTimeout(watchdog);
  return { root, proxyUrl, terminal, watchdogFired, elapsedMs: Date.now()-started, result, code, credentialsAtProxy, requestsAtProxy, positiveControl, echoedTokens, nativeProxyCalls,
    descendants: () => [...descendants], descendantRequests: () => descendantRequests,
    close: async () => { watcher.close(); udp.close(); for (const pid of descendants) try { process.kill(pid, 'SIGKILL'); } catch { /* owned red-test descendant already exited */ }
      for (const socket of sockets) socket.destroy(); await Promise.all([
      new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => positive.close(() => resolve()))]); rmSync(root, { recursive: true, force: true }); } };
}

const proxyModes = ['explicit-config', 'default-config', 'off', 'env', 'global-dispatcher',
  ...['--use-env-proxy', '--use_env_proxy', '--use-env_proxy', '--use_env-proxy'].flatMap(flag => ['argv:' + flag, 'options:' + flag])];
attack.each((['mcp-only', 'dedicated'] as const).flatMap(entry => proxyModes.map(mode => ({entry,mode}))))('$entry keeps credentials direct with Node proxy mode $mode while client traffic uses the Attempt channel', async ({entry,mode}) => {
  const f = await fixture(entry, mode, `
const modelProxy = new URL(process.env.HTTPS_PROXY);
await new Promise((resolve,reject)=>import('node:http').then(({request})=>{
 const req=request({host:'127.0.0.1',port:modelProxy.port,headers:{'x-native-probe':'yes'}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.end();}));
`, 0, true);
  try {
    expect(f.code).toBe(0);
    expect(f.positiveControl > 0).toBe(mode !== 'off');
    expect(f.credentialsAtProxy).toBe(0);
    expect(f.result?.refusals).toEqual([]);
    expect(f.result?.outcomes[0]?.completeness).toBe('complete');
    expect(f.nativeProxyCalls).toBe(2);
    const record = JSON.parse(readFileSync(join(f.root, 'records/S0b-1/attempt.json'), 'utf8'));
    expect(record.maps.find((map: {mapId:string}) => map.mapId === 'Proxy.History').history[1].author.clientId).toBe('Proxy.Historical');
    const channel = JSON.parse(readFileSync(join(f.root, 'records/S0b-1/raw/proxy-channel.json'), 'utf8'));
    expect(channel).toEqual({enabled:true,connections:2,blockedConnections:0,closed:true});
  } finally { await f.close(); }
}, 30_000);


attack.each(['mcp-only', 'dedicated'] as const)('%s sanitizes error events and crash stderr in outcomes, terminal and batch.json', async entry => {
  for (const mode of ['error-event', 'crash']) {
    const f = await fixture(entry, 'off', `
const failureProxy = new URL(process.env.HTTPS_PROXY);
const failureLogin = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).OPENAI_API_KEY;
const failureToken = process.env.WAYFINDER_TOKEN ?? '';
if (failureToken) await new Promise(resolve => import('node:http').then(({request}) => {
  const req = request({host:'127.0.0.1',port:failureProxy.port,headers:{'x-synthetic-token':failureToken}}, res => {res.resume();res.on('end', resolve);}); req.end(); }));
const failureText = [process.env.HTTPS_PROXY, decodeURIComponent(failureProxy.password), failureLogin, failureToken].join(' ');
${mode === 'error-event' ? "emit({type:'error', message:failureText});" : ''}
console.error('synthetic failure ' + failureText); process.exit(${mode === 'error-event' ? 1 : 3});
`);
    try {
      expect(f.code).toBe(0); expect(f.result?.outcomes[0]?.completeness).toBe('driver-failed');
      const secrets = ['synthetic%40proxy-password', 'synthetic@proxy-password', 'synthetic-login-for-tests-only', ...f.echoedTokens];
      for (const text of [f.terminal, JSON.stringify(f.result), readFileSync(join(f.root, 'records/batch.json'), 'utf8'),
        readFileSync(join(f.root, 'records/S0b-1/attempt.json'), 'utf8')]) expect(secrets.some(secret => text.includes(secret))).toBe(false);
      if (entry === 'dedicated') expect(f.echoedTokens.length).toBe(1);
      expect(f.result?.outcomes[0]?.detail).toContain('<proxy-');
    } finally { await f.close(); }
  }
}, 45_000);


attack.each(['mcp-only', 'dedicated'] as const)('%s ends attached and detached clients before publishing an Attempt', async entry => {
  for (const mode of ['complete', 'crash', 'timeout']) {
    const f = await fixture(entry, 'off', `
const {spawn: spawnDescendant} = await import('node:child_process');
const descendantProxy = new URL(process.env.HTTPS_PROXY);
const descendantCode = "const http=require('node:http'); const net=require('node:net'); const ping=()=>{const req=http.request({host:'127.0.0.1',port:"+descendantProxy.port+",headers:{'x-descendant':String(process.pid)}},res=>res.resume());req.on('error',()=>{});req.end();const socket=net.connect("+new URL(url).port+",'127.0.0.1');socket.on('connect',()=>socket.end());socket.on('error',()=>{});};ping();setInterval(ping,80);";
for (const detached of [false,true]) spawnDescendant(process.execPath,['-e',descendantCode],{detached,stdio:'ignore'}).unref();
await new Promise(resolve=>setTimeout(resolve,300));
${mode === 'crash' ? 'process.exit(3);' : mode === 'timeout' ? 'await new Promise(resolve=>setTimeout(resolve,30_000));' : ''}
`);
    try {
      expect(f.code).toBe(0);
      const blocked = JSON.parse(readFileSync(join(f.root, 'records/S0b-1/raw/proxy-channel.json'), 'utf8')).blockedConnections;
      expect(f.result?.outcomes[0]?.completeness).toBe(blocked || mode === 'crash' ? 'driver-failed' : mode === 'timeout' ? 'timeout' : 'complete');
      expect(f.descendants().length).toBeGreaterThanOrEqual(2);
      const requests = f.descendantRequests();
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(f.descendantRequests()).toBe(requests);
      expect(f.descendants().every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })).toBe(true);
    } finally { await f.close(); }
  }
}, 60_000);


attack.each((['mcp-only', 'dedicated'] as const).flatMap(entry => [false,true].map(pipes => ({entry,pipes}))))('$entry bounds inherited-pipe drain (pipes=$pipes) and cuts escaped descendants off from its upstream proxy', async ({entry,pipes}) => {
    const f = await fixture(entry, 'off', `
const {spawn: spawnLate} = await import('node:child_process');
const lateProxy = new URL(process.env.HTTPS_PROXY);
const lateCode = "const http=require('node:http');const ping=()=>{const req=http.request({host:'127.0.0.1',port:"+lateProxy.port+",headers:{'x-descendant':String(process.pid)}},res=>res.resume());req.on('error',()=>{});req.end();};ping();setInterval(ping,40);setTimeout(()=>process.exit(0),6000);";
const late = spawnLate(process.execPath,['-e',lateCode],{detached:true,cwd:${pipes ? 'process.cwd()' : "'/'"},stdio:${pipes ? "['ignore','inherit','inherit']" : "'ignore'"}});late.unref();
writeFileSync('owned-fixture-pids.json',JSON.stringify([late.pid]));process.exit(0);
`, 8000);
    try {
      expect(f.watchdogFired).toBe(false); expect(f.elapsedMs).toBeLessThan(8000);
      const count = f.descendantRequests(); await new Promise(resolve=>setTimeout(resolve,200));
      expect(f.descendantRequests()).toBe(count);
      const channel = JSON.parse(readFileSync(join(f.root,'records/S0b-1/raw/proxy-channel.json'),'utf8'));
      expect(channel.closed).toBe(true);
      expect(f.descendants().length).toBeGreaterThan(0);
      if (channel.blockedConnections > 0 || pipes) expect(f.result?.outcomes[0]?.completeness).toBe('driver-failed');
    } finally { await f.close(); }
}, 30_000);


attack.each(['mcp-only', 'dedicated'] as const)('%s exposes only its forwarding endpoint, with no direct IPv4/alias/IPv6/UDP proxy bypass', async entry => {
  const f = await fixture(entry, 'off', `
const assert = (await import('node:assert/strict')).default;
const {connect: connectProbe,createServer: unixListener} = await import('node:net');
const {createSocket: udpProbe} = await import('node:dgram');
const unixPath = join(process.cwd(),'owned.sock');
const unix = unixListener(); await new Promise(resolve=>unix.listen(unixPath,resolve));
try {
 const result=await new Promise(resolve=>{const socket=connectProbe({path:unixPath});socket.on('connect',()=>{socket.destroy();resolve('connected');});socket.on('error',error=>resolve(error.code));});
 assert.equal(result,'EPERM');
} finally {await new Promise(resolve=>unix.close(resolve));}
const gateway = new URL(process.env.HTTPS_PROXY);
assert.notEqual(Number(gateway.port),__UPSTREAM_PORT__);
await new Promise((resolve,reject)=>import('node:http').then(({request})=>{
 const req=request({host:'127.0.0.1',port:gateway.port,headers:{'x-native-probe':'yes'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{assert.equal(body,'native-proxy-fixture');resolve();}catch(e){reject(e);}});});req.on('error',reject);req.end();}));
const denied = (host,port) => new Promise(resolve=>{const socket=connectProbe(port,host);socket.on('connect',()=>{socket.destroy();resolve('connected');});socket.on('error',e=>resolve(e.code));});
for(const host of ['127.0.0.1','localhost','127.1','0.0.0.0','::1','::ffff:127.0.0.1','::ffff:0.0.0.0']) assert.equal(await denied(host,__UPSTREAM_PORT__),'EPERM');
for(const host of ['::1','::ffff:127.0.0.1','::ffff:0.0.0.0']) assert.equal(await denied(host,Number(gateway.port)),'EPERM');
assert.equal(await denied(__OWNED_IP__,__PUBLIC_PORT__),'EPERM');
for(const [host,type,port] of [[__OWNED_IP__,'udp4',__UDP_PORT__],['127.0.0.1','udp4',Number(gateway.port)],['::ffff:127.0.0.1','udp6',Number(gateway.port)]]) {
 const result=await new Promise(resolve=>{const socket=udpProbe(type);socket.send('synthetic',port,host,error=>{socket.close();resolve(error?.code??'sent');});}); assert.equal(result,'EPERM');
}
`);
  try { expect(f.code).toBe(0); expect(f.result?.outcomes[0]?.completeness).toBe('complete'); expect(f.nativeProxyCalls).toBe(2); }
  finally { await f.close(); }
}, 30_000);
