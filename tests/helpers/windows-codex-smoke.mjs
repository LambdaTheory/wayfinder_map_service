// Synthetic Windows stdio/HTTP interoperability, including a hostile proxy env.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHttpTestClient } from './mcp-http-client.mjs';
const root = join(homedir(), '.wayfinder-windows-tests', randomUUID());
const env = { ...process.env, WAYFINDER_WINDOWS_HOME: root };
const entry = resolve('dist/windows-local.js');
const run = (...args) => execFileSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 60000 });
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
let host, client, http; let logs = '';
async function start() {
  host = spawn(process.execPath, [entry, 'serve'], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('Startup timeout')),30000);
    host.stdout.on('data', d => { logs+=d; if(String(d).includes('Windows ready')) {clearTimeout(timer);resolve();} });
    host.stderr.on('data', d => { logs+=d; });
    host.once('exit',()=>{clearTimeout(timer);reject(Error('Startup failed'));});
  });
}
async function stop() {
  const exited=new Promise(r=>host.once('exit',(code,signal)=>r({code,signal})));
  run('stop'); assert.deepEqual(await exited,{code:0,signal:null}); host=undefined;
}
async function connect(protocol='2025-11-25') {
  client=new Client({name:'windows-stdio-acceptance',version:'1.0.0'}, {
    supportedProtocolVersions:[protocol], versionNegotiation:{mode:protocol==='2025-11-25'?'legacy':{pin:protocol}},
  });
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'mcp-stdio'],stderr:'pipe',env:{
    ...env, HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',
    NO_PROXY:'127.0.0.1,localhost,::1',NODE_USE_ENV_PROXY:'0',
  }});
  transport.stderr.on('data',d=>{logs+=d;});
  await client.connect(transport); return client;
}
try {
  run('init',String(port)); const {token}=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
  await start(); await connect();
  http=await createHttpTestClient(port,token);
  assert.deepEqual(await client.listTools(),await http.client.listTools());
  assert.equal(client.getInstructions(),http.initializeResult.instructions);
  assert.deepEqual(client.getServerVersion(),http.initializeResult.serverInfo);
  assert.deepEqual(await client.listResources(),await http.client.listResources());
  assert.deepEqual(await client.listPrompts(),await http.client.listPrompts());
  const version=client.getServerVersion().version;
  const call=async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
  assert.equal((await call('map_list',{})).maps.length,0);
  const mapId='Windows.Stdio.Synthetic';
  assert.equal((await call('map_create',{version,mapId,title:'stdio synthetic',destination:'verify transport forwarding'})).kind,'committed');
  assert.equal((await call('map_read',{mapId})).revision.state.currentRevision,1);
  const waited=await call('map_wait',{version,mapId,claimantId:'stdio-synthetic',maxWaitSeconds:1});
  assert.equal(waited.outcome,'none_yet');
  await client.close(); client=undefined;
  assert.match(run('status'),/running/); // Closing the Agent never stops its service.
  await http.client.close(); http=undefined; await stop();
  await start(); await connect();
  assert.equal((await call('map_read',{mapId})).revision.state.currentRevision,1);
  await client.close(); client=undefined;
  await connect('2026-07-28'); assert.equal((await client.listTools()).tools.length,5);
  await client.close(); client=undefined; await stop();
  await assert.rejects(()=>connect()); await client.close().catch(()=>{}); client=undefined;
  for(const sensitive of [token,root,'verify transport forwarding'])assert(!logs.includes(sensitive));
  const result={passed:true,protocols:['2025-11-25','2026-07-28'],exactToolCatalog:true,initializationInstructions:true,
    resourcesAndPrompts:true,proxyIsolation:true,writeReadWait:true,restartPersistence:true,closedAgentPreservesService:true,
    unavailableServiceFails:true,noCredentialsInLogs:true};
  const evidence=resolve('.scratch/windows-evidence');mkdirSync(evidence,{recursive:true});
  writeFileSync(join(evidence,'stdio-result.json'),JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
} finally {
  await client?.close().catch(()=>{}); await http?.client.close().catch(()=>{});
  if(host)await stop().catch(()=>{host.kill();});
  assert(root.startsWith(join(homedir(),'.wayfinder-windows-tests')+'\\'));
  rmSync(root,{recursive:true,force:true});
}
