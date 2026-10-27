// Real host and sandbox launcher with a synthetic client and explicit synthetic subscription state.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { host } from '../../interactive/host.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const subscriptionHome = mkdtempSync('/private/tmp/wayfinder-fake-login-');
const mode = process.env.B09_SYNTHETIC_REFRESH;
if (mode === 'no-open-files') {
  const bin = join(subscriptionHome, 'bin'); mkdirSync(bin);
  // lsof exits 1 with no output when no matching files can be reported. Never consult daily files.
  writeFileSync(join(bin, 'lsof'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}
const daily = join(subscriptionHome, '.codex/auth.json');
mkdirSync(join(subscriptionHome, '.codex'));
writeFileSync(daily, 'synthetic-old-login'); utimesSync(daily, 1, 1);
const proxies = [];
async function proxySource(source) {
  const server = createServer((_req, res) => res.end(source)); proxies.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if ([18765, 18766].includes(port)) throw new Error('unexpected fixture port');
  return `http://127.0.0.1:${port}`;
}
let settingsProxy; let terminalProxy;
if (mode?.includes('settings') || mode?.endsWith('-terminal')) {
  settingsProxy = await proxySource('settings'); terminalProxy = await proxySource('terminal');
  mkdirSync(join(subscriptionHome, '.claude'));
  writeFileSync(join(subscriptionHome, '.claude/settings.json'), mode === 'codex-malformed-settings' ? '{synthetic-invalid' : JSON.stringify({ env: { HTTPS_PROXY: settingsProxy } }));
}
const expectedSource = mode?.endsWith('-terminal') ? 'terminal' : mode === 'claude-settings' ? 'settings' : undefined;
const sourceProbe = mode === 'claude-proxy' ? `
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.CLAUDE_CONFIG_DIR + '/projects'; mkdirSync(dir, {recursive:true});
const u = new URL(process.env.HTTPS_PROXY);
const values = [process.env.HTTPS_PROXY, process.env.HTTPS_PROXY.replace(/\\/$/, ''), 'CONNECT via ' + process.env.HTTPS_PROXY.replace(/\\/$/, '') + ' failed', u.username + ':' + u.password, u.username, u.password];
writeFileSync(dir + '/synthetic.jsonl', JSON.stringify({text: 'http://127.0.0.1:23456/mcp http://localhost:23456/mcp ' + [...values, ...values.map(decodeURIComponent)].join(' ')}));
` : (mode?.includes('settings') || mode?.endsWith('-terminal'))
  ? `import assert from 'node:assert/strict'; import {get, Agent} from 'node:http';
${expectedSource ? `const value=await new Promise((resolve,reject)=>{const req=get(process.env.HTTPS_PROXY,{agent:new Agent({proxyEnv:{}})},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(text));});req.on('error',reject);});assert.equal(value,${JSON.stringify(expectedSource)});` : 'assert.equal(process.env.HTTPS_PROXY, undefined);'}` : '';
const driver = join(subscriptionHome, 'fake-client.mjs');
writeFileSync(driver, `#!${process.execPath}\n${sourceProbe}\n${mode === 'exit-nonzero' ? 'process.exit(7);' : mode === 'exit-signal' ? "process.kill(process.pid, 'SIGTERM');" : ''}\n`, { mode: 0o700 });
let observed = 0;
let scratch;
const output = process.stdout.write.bind(process.stdout);
let launching = Promise.resolve();
function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH, ...(mode?.startsWith('claude-') ? { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' } : {}) } });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.once('error', reject); child.once('exit', status => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}
process.stdout.write = (text, ...args) => {
  if (mode === 'native-link' && String(text).includes('Client command')) {
    const privateLogs = join(subscriptionHome, 'private-logs'); mkdirSync(privateLogs);
    writeFileSync(join(privateLogs, 'secret.jsonl'), 'synthetic-private-native-marker');
    symlinkSync(privateLogs, join(scratch, 'home/.codex/sessions'));
  }
  if (!mode?.startsWith('no-start') && String(text).includes('Client command')) {
    const command = String(text).match(/Client command \(approved Batch only\): ([^\n]+)/)[1];
    launching = (async () => {
      const launched = await run(command);
      if (mode === 'repeat-launch') await run(command);
      if (!['exit-nonzero', 'exit-signal', 'launch-failure'].includes(mode) && launched.status !== 0)
        throw new Error('Synthetic launcher failed: ' + launched.stderr);
    })();
  }
  if (String(text).includes('Client exited; enter')) {
    // Let the host event loop acknowledge the separate wrapper before exposing the operator prompt.
    launching.then(() => output(text, ...args), error => { console.error(error); process.stdin.destroy(); });
    return true;
  }
  return output(text, ...args);
};
try {
  await host([...process.argv.slice(2, -1), driver], { subscriptionHome,
    inheritedEnv: mode?.endsWith('-terminal') ? { HTTPS_PROXY: terminalProxy } : ['claude-proxy', 'protocol-refusal'].includes(mode) ? { NO_PROXY: '127.0.0.1', no_proxy: 'localhost', HTTPS_PROXY: 'http://synthetic-user:synthetic-password@localhost:23457' } : {},
    observe: paths => {
      ++observed;
      if (observed === 1) scratch = paths[1];
      if (observed === 2 && ['exit-without-start', 'missing-exit'].includes(mode)) {
        const log = join(paths[2], 'launch.jsonl');
        const rows = readFileSync(log, 'utf8').trim().split('\n').filter(line => JSON.parse(line).phase !== (mode === 'missing-exit' ? 'exited' : 'started'));
        writeFileSync(log, rows.join('\n') + '\n');
      }
      if (observed === 2 && mode === 'duplicate-start') {
        const log = join(paths[2], 'launch.jsonl'); const text = readFileSync(log, 'utf8');
        writeFileSync(log, text + text.split('\n').find(line => JSON.parse(line || '{}').phase === 'started') + '\n');
      }
      if (observed === 2 && mode === 'protocol-refusal') writeFileSync(join(paths[0], 'protocol.jsonl'), JSON.stringify({ kind: 'http://synthetic-user:synthetic-password@localhost:23457' }));
      if (observed === 2 && mode === 'control-tamper') writeFileSync(join(paths[2], 'launch.json'), 'forged');
      if (observed === 2 && ['refresh', 'failure', 'cancel'].includes(mode)) {
        const own = join(paths[1], 'home/.codex/auth.json');
        unlinkSync(own); writeFileSync(own, 'synthetic-refreshed-login'); utimesSync(own, 2, 2);
        if (mode === 'failure') unlinkSync(daily);
      }
      return { configs: {}, everyday: { known: false, reason: 'synthetic observer has no daily service access' } };
    } });
  if (mode === 'refresh' && readFileSync(daily, 'utf8') !== 'synthetic-refreshed-login') throw new Error('Synthetic refresh was lost');
} finally {
  for (const server of proxies) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(subscriptionHome, { recursive: true, force: true });
}
