// Full manual-host exercise. Every client, proxy, login and database is synthetic and owned here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { host, cacheRoot } from '../../interactive/host.ts';
import { readManifest } from '../../interactive/launch.ts';

const [attempt, mode, client] = process.argv.slice(2);
const root = mkdtempSync('/private/tmp/wf-interactive-proxy-');
const dir = join(cacheRoot(), `B118-${attempt}`);
mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/auth.json'), 'synthetic-login');
let requests = 0; let authenticated = 0;
const proxy = createServer((req, res) => { requests++; if (req.headers.authorization) authenticated++; res.end('fake-upstream'); });
const sockets = new Set();
proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
proxy.on('connect', (_req, socket) => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  socket.once('data', bytes => {
    requests++; if (/\r\nauthorization:/i.test(bytes.toString())) authenticated++;
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nfake-upstream');
  });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
assert(![18765, 18766].includes(port));
const url = `http://127.0.0.1:${port}`;
if (mode === 'ambient') {
  // This subprocess was started with Node proxy mode; an actual global-fetch control must hit us.
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.http_proxy = process.env.https_proxy = url;
  process.env.NO_PROXY = process.env.no_proxy = 'localhost';
  const { setGlobalProxyFromEnv } = await import('node:http');
  setGlobalProxyFromEnv({ HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost' });
  assert.equal(await (await fetch('http://synthetic.invalid/control', { signal: AbortSignal.timeout(2000) })).text(), 'fake-upstream');
}
const initialRequests = requests;
const detached = ['detached', 'immediate', 'delayed', 'delayed-signal'].includes(mode);
const signalHook = join(root, 'delay-exit-signal.mjs');
if (mode === 'delayed-signal') writeFileSync(signalHook, `
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const append = fs.appendFileSync;
fs.appendFileSync = function(path, data, ...args) {
  if (String(path).endsWith('/launch.jsonl') && JSON.parse(data).phase === 'exited') {
    const work = JSON.parse(fs.readFileSync(String(path).replace('launch.jsonl', 'launch.json'), 'utf8')).workdir;
    fs.writeFileSync(work + '/exit-observed', 'wrapper captured exit time');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return append.call(this, path, data, ...args);
}; syncBuiltinESMExports();
`);
const descendant = `
import { get, Agent } from 'node:http';
import { connect } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const [ready, result, observation, exitObserved] = process.argv.slice(1);
const parent = process.ppid;
const directProbe = () => new Promise(resolve=>{const s=connect(${port},'127.0.0.1');s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('connected');});});
writeFileSync(result,JSON.stringify({direct:await directProbe()}));
writeFileSync(ready, 'ready');
const agent = new Agent({proxyEnv:{}});
const probe = () => { const r = get(process.env.HTTPS_PROXY, {agent}, res => res.resume()); r.on('error',()=>{}); };
if (${JSON.stringify(mode)} === 'detached') {
  probe(); const timer = setInterval(probe, 10);
  setTimeout(()=>{clearInterval(timer); agent.destroy(); process.exit(0);}, 1800);
} else {
  const watchdog = setTimeout(()=>process.exit(2), 3000);
  while (process.ppid === parent) await delay(1);
  if (${JSON.stringify(mode)} === 'delayed') { while (!existsSync(observation)) await delay(1); await delay(40); }
  if (${JSON.stringify(mode)} === 'delayed-signal') { while (!existsSync(exitObserved)) await delay(1); }
  const outcome = await new Promise(resolve=>{const r=get(process.env.HTTPS_PROXY + '/leftover',{agent},res=>{res.resume();res.on('end',()=>resolve('forwarded'));});r.on('error',e=>resolve(e.code));});
  const direct = await directProbe();
  writeFileSync(result,JSON.stringify({outcome,direct}));clearTimeout(watchdog);agent.destroy();
}
`;
const driver = join(root, 'client.mjs');
writeFileSync(driver, `#!${process.execPath}
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { get, Agent } from 'node:http';
import { connect } from 'node:net';
const input = JSON.parse(readFileSync('input.json', 'utf8'));
for (const file of input.controls) assert.throws(()=>writeFileSync(file,'forged'),{code:'EPERM'});
assert.throws(()=>readFileSync(input.manifest),{code:'EPERM'});
const direct = await new Promise(resolve=>{const s=connect(${port},'127.0.0.1');s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('connected');});});
assert.equal(direct,'EPERM');
await new Promise((resolve,reject)=>{const req=get(process.env.HTTPS_PROXY,{agent:new Agent({proxyEnv:{}})},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{assert.equal(s,'fake-upstream');resolve();});});req.on('error',reject);});
const response = await fetch(input.relay, {method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-interactive',version:'1'}}})});
assert.equal(response.status,200); await response.text();
${detached ? `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.cwd()+'/child-ready',process.cwd()+'/child-result',process.cwd()+'/observation',process.cwd()+'/exit-observed'],{cwd:'/',env:process.env,detached:true,stdio:'ignore'});child.unref();writeFileSync('descendant.json',JSON.stringify({pid:child.pid}));while(!existsSync('child-ready'))await new Promise(r=>setTimeout(r,1));process.exit(0);` : ''}
${mode === 'early' ? "const timer=setInterval(()=>{const r=get(process.env.HTTPS_PROXY,{agent:new Agent({proxyEnv:{}})},res=>res.resume());r.on('error',()=>{});},25);writeFileSync('ready','yes');await new Promise(r=>setTimeout(r,1000));clearInterval(timer);" : ''}
`, { mode: 0o700 });

let prepared; let task = Promise.resolve(); let error; let afterWrapper = 0; let wrapperDone; let observationTimer; let childResult;
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = (text, ...args) => {
  if (String(text).includes('Client command')) {
    const command = String(text).match(/Client command \(approved Batch only\): ([^\n]+)/)[1];
    const parts = [...command.matchAll(/'([^']*)'/g)].map(match => match[1]);
    const manifestPath = parts.at(-2); const manifest = readManifest(manifestPath, parts.at(-1));
    const controlDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
    prepared = { controlDir, work: manifest.workdir };
    if (mode === 'delayed') observationTimer = setInterval(() => {
      if (existsSync(join(controlDir, 'host.closed'))) {
        writeFileSync(join(manifest.workdir, 'observation'), 'final observation'); clearInterval(observationTimer);
      }
    }, 5);
    const relay = client === 'codex' ? JSON.parse(manifest.args.find(arg => arg.startsWith('mcp_servers.wayfinder.url=')).split('=').slice(1).join('='))
      : JSON.parse(readFileSync(manifest.args[manifest.args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.wayfinder.url;
    writeFileSync(join(manifest.workdir, 'input.json'), JSON.stringify({ relay, manifest: manifestPath,
      controls: ['launch.jsonl', 'host.starting', 'host.exited', 'host.closed'].map(name => join(controlDir, name)) }));
    task = (async () => {
      if (mode === 'before') {
        await new Promise(resolve => { const s = connect(Number(new URL(manifest.env.HTTPS_PROXY).port), '127.0.0.1'); s.on('error',()=>resolve()); s.on('close',resolve); });
        assert.equal(requests, initialRequests);
      }
      const wrapper = spawn(parts[0], [...(mode === 'delayed-signal' ? ['--import', signalHook] : []), ...parts.slice(1)], { stdio: 'ignore', env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' } });
      wrapperDone = new Promise((resolve, reject) => { wrapper.once('error', reject); wrapper.once('exit', resolve); });
      if (mode === 'early') {
        while (!existsSync(join(manifest.workdir, 'ready'))) await delay(10);
        afterWrapper = requests;
        return; // Deliberately report complete while the trusted wrapper is still running.
      }
      const code = await wrapperDone;
      assert.equal(code, 0);
      afterWrapper = requests;
      await delay(80); assert.equal(requests, afterWrapper); // The inactive listener cannot forward leftover traffic.
    })().catch(value => { error = value; });
  }
  if (String(text).includes('Client exited; enter')) { task.then(() => output(text, ...args)); return true; }
  return output(text, ...args);
};
try {
  await host(['B118', attempt, client, 'synthetic-model', 'low', 'W7', driver], { subscriptionHome: root,
    inheritedEnv: { HTTPS_PROXY: url, NO_PROXY: '127.0.0.1' },
    observe: () => {
      if (prepared && existsSync(join(prepared.work, 'child-result'))) childResult = JSON.parse(readFileSync(join(prepared.work, 'child-result'), 'utf8'));
      return { configs: {}, everyday: { known: false, reason: 'synthetic observer' } };
    } });
  if (error) throw error;
  if (mode === 'early') assert.equal(await wrapperDone, 1);
  const afterHost = requests;
  await delay(mode === 'detached' ? 1800 : 30); // The bounded owned child exits itself, including after assertion failure.
  assert.equal(requests, afterHost);
  assert.equal(authenticated, 0);
  assert(requests > initialRequests);
  writeFileSync(join(dir, 'proof.json'), JSON.stringify({ afterWrapper, afterHost, final: requests, authenticated, childResult }));
} finally {
  process.stdout.write = output; clearInterval(observationTimer);
  // A fixture assertion must not leave its bounded detached process behind.
  if (detached) await delay(1800);
  for (const socket of sockets) socket.destroy();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  rmSync(root, { recursive: true, force: true });
  if (prepared) rmSync(prepared.controlDir, { recursive: true, force: true });
  if (prepared) rmSync(dirname(prepared.work), { recursive: true, force: true });
}
