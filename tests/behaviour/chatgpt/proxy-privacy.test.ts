// Actual command, fake cloudflared, owned forwarding proxy and synthetic MCP client only.
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runRoot } from './run.ts';
import { checkoutRoot } from '../runner/service.ts';
import { directAgent } from '../runner/direct-http.ts';
import { createControllerClient } from '../runner/controller-client.mjs';

for (const mode of ['off', 'argv', 'options', 'env', 'explicit-config', 'default-config'])
  test(`ChatGPT fake-tunnel command keeps observer/session credentials direct in ${mode} proxy mode`, async () => {
    mkdirSync(runRoot, {recursive:true,mode:0o700});
    const root = mkdtempSync(join(runRoot, 'chatgpt-proxy-'));
    const batch = `proxy-${randomUUID()}`; const batchDir = join(runRoot, batch); const tunnel = randomUUID();
    const config = join(root, 'config.yml');
    writeFileSync(config, `tunnel: ${tunnel}\ncredentials-file: ${join(root, 'nonexistent-credentials.json')}\n`);
    writeFileSync(join(root, 'node.config.json'), JSON.stringify({nodeOptions:{'use-env-proxy':true}}));
    const agent = directAgent(); const sockets = new Set<import('node:net').Socket>();
    let childPid = 0; let authenticated = 0; let controls = 0;
    const positive = createServer((_req,res) => res.end('owned-control'));
    await new Promise<void>(resolve => positive.listen(0, '127.0.0.1', resolve));
    const positivePort = (positive.address() as {port:number}).port;
    const allowed = (port: number) => {
      if ([18765,18766].includes(port)) return false;
      if (port === positivePort) return true;
      try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {encoding:'utf8'})
        .trim().split('\n').every(pid => Number(pid) === childPid); } catch { return false; }
    };
    const proxy = createServer((req,res) => {
      if (req.headers.authorization) authenticated++;
      if (req.url?.endsWith('/positive-control')) controls++;
      const url = new URL(req.url!);
      if (url.hostname !== '127.0.0.1' || !allowed(Number(url.port))) {res.writeHead(502).end();return;}
      const upstream = request(url, {agent, method:req.method, headers:req.headers}, reply => {res.writeHead(reply.statusCode!,reply.headers);reply.pipe(res);});
      upstream.on('error',()=>res.destroy()); req.pipe(upstream);
    });
    proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    proxy.on('connect',(req,socket,head)=>{
      const url = new URL(`http://${req.url}`);
      if (url.hostname !== '127.0.0.1' || !allowed(Number(url.port))) {socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
      const upstream = connect(Number(url.port),'127.0.0.1',()=>{
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if(head.length)upstream.write(head); socket.pipe(upstream);upstream.pipe(socket);
      });
      // Count header presence only, including a header split across TCP chunks; never persist a credential.
      let headers=''; let countedAuth=false; let countedControl=false;
      socket.on('data',bytes=>{
        headers+=bytes.toString();
        if(!countedAuth && /\r\nauthorization:/i.test(headers)){authenticated++;countedAuth=true;}
        if(!countedControl && headers.includes('/positive-control')){controls++;countedControl=true;}
        if(headers.includes('\r\n\r\n'))headers='';
      });
      upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
    });
    await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const proxyPort=(proxy.address() as {port:number}).port;
    const hook=join(root,'positive.mjs');writeFileSync(hook,`await (await fetch('http://127.0.0.1:${positivePort}/positive-control')).text();`);
    const flags = mode==='argv' ? ['--use_env_proxy'] : mode==='explicit-config' ? ['--experimental-config-file='+join(root,'node.config.json')]
      : mode==='default-config' ? ['--experimental-default-config-file'] : [];
    const child=spawn(process.execPath,[...flags,'--import',hook,join(checkoutRoot,'tests/behaviour/chatgpt/run.ts'),'run','--batch',batch,
      '--scenarios','F11','--ceiling','1','--model','fake','--approval','synthetic verification only','--hostname','test.example.com','--fake-tunnel','--config',config],{
      cwd:root,env:{PATH:process.env.PATH!,HOME:process.env.HOME!,HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,http_proxy:`http://127.0.0.1:${proxyPort}`,
        NO_PROXY:'localhost',no_proxy:'localhost',...(mode==='env'?{NODE_USE_ENV_PROXY:'1'}:{}),...(mode==='options'?{NODE_OPTIONS:'--use-env_proxy'}:{})},stdio:['pipe','pipe','pipe']});
    childPid=child.pid!;const exited=once(child,'exit');let output='';
    child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
    const waitFor=async(pattern:RegExp)=>{
      const until=Date.now()+20_000;
      while(!pattern.test(output)){
        if(child.exitCode!==null || child.signalCode!==null || Date.now()>until)throw new Error('Owned ChatGPT command did not reach expected checkpoint');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    };
    try {
      await waitFor(/Ready F11-1/);
      expect(controls>0).toBe(mode!=='off');
      const isolation=JSON.parse(readFileSync(join(batchDir,'F11-1/raw/isolation.json'),'utf8'));
      const client=await createControllerClient(isolation.relayPort,'synthetic-inbound-only');
      try {
        expect((await client.client.listTools()).tools.length).toBeGreaterThan(0);
        child.stdin.write('begin\n');await waitFor(/Send this Scenario message/);
        await client.client.callTool({name:'map_read',arguments:{mapId:'DistributedAgents.Feishu.20261023'}});
      } finally {await client.close();}
      const wire=JSON.parse(readFileSync(join(batchDir,'F11-1/raw/wire.json'),'utf8'));
      expect(wire.some((e:{request:{method:string};status:number})=>e.request.method==='initialize' && e.status===200)).toBe(true);
      const capture=join(batchDir,'F11-1/raw/capture.json');
      writeFileSync(capture,JSON.stringify({messagesComplete:true,otherToolsComplete:true,messages:[{text:'Synthetic response',afterCall:wire.findLast((e:{request:{method:string}})=>e.request.method==='tools/call').id}]}));
      child.stdin.write(`end ${capture}\n`);await waitFor(/Turn captured/);child.stdin.write('next\n');await exited;
      expect(child.exitCode).toBe(0);expect(authenticated).toBe(0);
      const record=JSON.parse(readFileSync(join(batchDir,'batch.json'),'utf8'));
      expect(record.fakeTunnel).toBe(true);expect(record.outcomes[0].completeness).toBe('complete');
      expect(existsSync(join(root,'fake-connector.json'))).toBe(false);
      expect(existsSync(join(batchDir,'tunnel.yml'))).toBe(false);
      expect(existsSync(join(runRoot,`opencode-${tunnel}.lock`))).toBe(false);
    } finally {
      if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exited;}
      if(existsSync(join(root,'fake-connector.json')) && existsSync(join(root,'fake-run.json'))){
        const pid=JSON.parse(readFileSync(join(root,'fake-run.json'),'utf8')).pid;try{process.kill(pid,'SIGTERM');}catch{}
      }
      agent.destroy();for(const socket of sockets)socket.destroy();
      await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>positive.close(()=>resolve()))]);
      rmSync(join(runRoot,`opencode-${tunnel}.lock`),{recursive:true,force:true});rmSync(batchDir,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});
    }
  },40_000);
