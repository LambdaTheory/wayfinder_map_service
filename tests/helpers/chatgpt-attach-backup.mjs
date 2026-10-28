// Run the real attach entry point and its three backup phases. Only network,
// process spawning and the 30-minute clock are fake; SQLite is unmodified.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';

mock.module('../../dist/mcp-service.js', { exports: {
  startLocalMcpService() { throw new Error('Attach must not start a service'); },
} });
mock.module('../../scripts/local-chatgpt-relay.mjs', { exports: {
  createLocalChatGptRelay() {
    const relay = new EventEmitter();
    relay.listen = (_port, _host, ready) => ready();
    relay.close = done => done();
    return relay;
  },
} });
let tunnelStopped = false;
mock.module('node:child_process', { exports: {
  execFileSync,
  spawn() {
    const tunnel = new EventEmitter();
    tunnel.exitCode = null;
    tunnel.kill = () => { tunnelStopped = true; tunnel.exitCode = 0; };
    return tunnel;
  },
} });
const requests = [];
mock.module('../../scripts/local-chatgpt-attach.mjs', { exports: {
  async probeLocalChatGptService(port, token) {
    requests.push({ port, token });
    return { accepted: true, version: '3.1.0' };
  },
} });
let scheduledBackup;
globalThis.setInterval = (callback, delay) => {
  assert.equal(delay, 30 * 60 * 1000);
  scheduledBackup = callback;
  return 1;
};
globalThis.clearInterval = () => {};

await import('../../scripts/local-chatgpt-test.mjs');
assert.deepEqual(requests, [{ port: 18766, token: process.env.WAYFINDER_ATTACH_TOKEN }]);
assert.equal(typeof scheduledBackup, 'function');
scheduledBackup();
process.emit('SIGTERM');
// The fake relay closes synchronously; allow the async shutdown to finish.
await new Promise(resolve => setImmediate(resolve));
assert.equal(tunnelStopped, true);
