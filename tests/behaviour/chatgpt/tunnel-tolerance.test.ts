import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { acquireTunnel } from './tunnel.ts';
import { startRelay } from './relay.ts';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tunnel-tolerance-'));
  const configPath = join(root, 'config.yml');
  writeFileSync(configPath, `tunnel: ${randomUUID()}\ncredentials-file: ${join(root, 'unused.json')}\n`);
  const events: { at: string; consecutive: number; summary: string }[] = [];
  const options = { root, dir: root, configPath, hostname: 'test.example.com', fake: true, fakeProcesses: '',
    onUnavailable: (event: typeof events[number]) => { events.push(event); } };
  const lease = await acquireTunnel(options);
  await lease.start(23456);
  const plan = (...actions: string[]) => writeFileSync(join(root, 'fake-info-plan.json'), JSON.stringify(actions));
  return { root, options, lease, events, plan, cleanup: async () => {
    rmSync(join(root, 'fake-info-plan.json'), { force: true });
    await lease.stop(); rmSync(root, { recursive: true, force: true });
  } };
}

for (const action of ['error', 'invalid', 'timeout']) test(`single tunnel info ${action} is tolerated until a successful check`, async () => {
  const f = await fixture();
  try {
    f.plan(action);
    await Promise.all([f.lease.check(), f.lease.check()]);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0]!.consecutive, 1);
    assert.ok(Number.isFinite(Date.parse(f.events[0]!.at)));
    assert.doesNotMatch(JSON.stringify(f.events), /synthetic-secret|unused.json/);
    f.plan('error'); await f.lease.check();
    assert.equal(f.events[1]!.consecutive, 1, 'success resets the budget');
  } finally { await f.cleanup(); }
}, 15_000);

test('tunnel info failures beyond the limit fail closed', async () => {
  const f = await fixture();
  try {
    f.plan('error', 'invalid', 'error', 'error');
    await assert.rejects(f.lease.check(), /tunnel info/);
    assert.deepEqual(f.events.map(e => e.consecutive), [1, 2, 3]);
  } finally { await f.cleanup(); }
});

test('repeated timed-out inspections fail within the ten-second tolerance budget', async () => {
  const f = await fixture();
  try {
    f.plan('timeout', 'timeout', 'timeout', 'timeout');
    const started = Date.now();
    await assert.rejects(f.lease.check(), /tolerance exhausted/);
    assert.ok(Date.now() - started < 10_000, 'bounded retries must not stack fifteen-second subprocess timeouts');
    assert.deepEqual(f.events.map(e => e.consecutive), [1, 2, 3]);
  } finally { await f.cleanup(); }
}, 15_000);

for (const state of ['foreign', 'missing', 'exit', 'local']) test(`${state} during tunnel info tolerance fails immediately`, async () => {
  const f = await fixture();
  try {
    f.options.onUnavailable = event => {
      f.events.push(event);
      if (state === 'exit') {
        const { pid } = JSON.parse(readFileSync(join(f.root, 'fake-run.json'), 'utf8'));
        process.kill(pid, 'SIGTERM');
      } else if (state === 'local') f.options.fakeProcesses = '42 cloudflared tunnel run opencode';
      else {
        const path = join(f.root, 'fake-connector.json');
        const own = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify(state === 'missing' ? [] : [...own, { id: randomUUID(), conns: [] }]));
      }
    };
    f.plan('error');
    await assert.rejects(f.lease.check(), state === 'exit' ? /not running|exited/ : state === 'local' ? /Another local/ : /ownership lost/);
    assert.equal(f.events.length, 1);
  } finally { await f.cleanup(); }
});

test('relay does not forward while tunnel info is unavailable and resumes only after success', async () => {
  const f = await fixture();
  let forwarded = 0;
  const server = createServer((_req, res) => { forwarded++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = await startRelay((server.address() as { port: number }).port, 'fake-token', () => {}, () => {});
  try {
    relay.beforeForward = () => f.lease.check();
    f.options.onUnavailable = event => { f.events.push(event); assert.equal(forwarded, 0); };
    f.plan('error', 'invalid');
    const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(f.events.length, 2);
    assert.equal(forwarded, 1);
  } finally { await relay.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
