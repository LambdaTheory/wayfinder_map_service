// Run the real attach entry point and its three backup phases. Only network,
// process spawning and the 30-minute clock are fake; SQLite is unmodified.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

mock.module('../../dist/mcp-service.js', { namedExports: {
  startLocalMcpService() { throw new Error('Attach must not start a service'); },
} });
mock.module('../../scripts/local-chatgpt-relay.mjs', { namedExports: {
  createLocalChatGptRelay() {
    const relay = new EventEmitter();
    relay.listen = (_port, _host, ready) => ready();
    relay.close = done => done();
    return relay;
  },
} });
let tunnelStopped = false;
mock.module('node:child_process', { namedExports: {
  execFileSync,
  spawn() {
    const tunnel = new EventEmitter();
    tunnel.exitCode = null;
    tunnel.kill = () => { tunnelStopped = true; tunnel.exitCode = 0; };
    return tunnel;
  },
} });
const requests = [];
globalThis.fetch = async (_url, init) => {
  requests.push(init.method);
  return new Response(null, { headers: { 'mcp-session-id': 'synthetic-attach-session' } });
};
let scheduledBackup;
globalThis.setInterval = (callback, delay) => {
  assert.equal(delay, 30 * 60 * 1000);
  scheduledBackup = callback;
  return 1;
};
globalThis.clearInterval = () => {};

await import('../../scripts/local-chatgpt-test.mjs');
assert.deepEqual(requests, ['POST', 'DELETE']);
assert.equal(typeof scheduledBackup, 'function');
scheduledBackup();
process.emit('SIGTERM');
// The fake relay closes synchronously; allow the async shutdown to finish.
await new Promise(resolve => setImmediate(resolve));
assert.equal(tunnelStopped, true);
