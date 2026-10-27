import assert from 'node:assert/strict';
import { Agent, request, setGlobalProxyFromEnv } from 'node:http';
import { acceptsLocalChatGptToken } from '../../scripts/local-chatgpt-attach.mjs';
import { createLocalChatGptRelay } from '../../scripts/local-chatgpt-relay.mjs';

const [mode, servicePort, relayPort, token] = process.argv.slice(2);
const envBefore = JSON.stringify(process.env);
if (mode === 'global-proxy') setGlobalProxyFromEnv();
const globalAgent = (await import('node:http')).globalAgent;
const globalFetch = globalThis.fetch;
const read = (url, options = {}) => new Promise((resolve, reject) => {
  const req = request(url, options, res => {
    let body = ''; res.on('data', b => body += b);
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.once('error', reject);
  req.end(options.method === 'POST' ? '{"jsonrpc":"2.0","id":2,"method":"ping"}' : undefined);
});
const control = 'http://127.0.0.1:' + servicePort + '/positive-control';
const expected = mode === 'environment-only' ? 'direct' : 'proxy';
assert.equal(await (await fetch(control)).text(), expected);
assert.equal((await read(control)).body, expected);
// Variables alone do not enable Node proxy mode. Exercise that proxy explicitly too.
const proxyAgent = new Agent({ proxyEnv: process.env, keepAlive: false });
try { assert.equal((await read(control, { agent: proxyAgent })).body, 'proxy'); } finally { proxyAgent.destroy(); }

const attached = await acceptsLocalChatGptToken(Number(servicePort), token);
const relay = createLocalChatGptRelay(Number(servicePort), token);
const direct = new Agent({ proxyEnv: {}, keepAlive: false });
let post, deleted;
try {
  await new Promise(resolve => relay.listen(Number(relayPort), '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + relayPort + '/mcp';
  post = await read(url, { method: 'POST', agent: direct, headers: { 'mcp-method': 'ping' } });
  deleted = await read(url, { method: 'DELETE', agent: direct, headers: { 'mcp-session-id': 'synthetic-session' } });
} finally { direct.destroy(); await new Promise(resolve => relay.close(resolve)); }
assert.equal(attached, true);
assert.equal(post.status, 200);
assert.equal(JSON.parse(post.body).result.instructions, 'version: synthetic');
assert.equal(deleted.status, 204);
assert.equal(JSON.stringify(process.env) === envBefore, true);
assert.equal((await import('node:http')).globalAgent, globalAgent);
assert.equal(globalThis.fetch, globalFetch);
assert.equal(await (await fetch(control)).text(), expected);
