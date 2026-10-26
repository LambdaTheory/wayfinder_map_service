import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { startProxyChannel } from '../runner/proxy-channel.ts';
import { launcher } from './host.ts';
import { launch } from './launch.ts';
import { awaitHost, watchLauncher } from './lifecycle.ts';
import type { LaunchPhase } from './lifecycle.ts';

const attack = test.skipIf(process.platform !== 'darwin');
async function fixture() {
  const root = mkdtempSync('/private/tmp/wf-interactive-lifecycle-');
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/auth.json'), 'synthetic-login');
  let received = '';
  const server = createServer(socket => { socket.on('error', () => undefined); socket.on('data', data => { received += data; socket.write(data); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let checkpoint: (() => void) | undefined;
  const channel = await startProxyChannel({ HTTPS_PROXY: `http://127.0.0.1:${port}` }, () => checkpoint?.());
  return { root, scratch, channel, received: () => received,
    checkWith: (check: () => void) => { checkpoint = check; },
    close: async () => { await channel.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

attack('wrapper waits for the host before spawning; a closed host refuses the launch', async () => {
  const f = await fixture(); let controlDir: string | undefined;
  try {
    const driver = join(f.root, 'client.mjs');
    writeFileSync(driver, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync('started','yes');`, { mode: 0o700 });
    const prepared = launcher({ scratch: f.scratch, client: 'codex', bin: driver, port: 23456,
      model: 'fake', effort: 'low', subscriptionHome: f.root, proxyChannel: f.channel });
    controlDir = prepared.controlDir;
    const run = launch(prepared.manifestPath, prepared.manifestHash, {});
    const failed = expect(run).rejects.toThrow('host closed');
    expect(readFileSync(join(controlDir, 'launch.jsonl'), 'utf8')).toContain('starting');
    await delay(30);
    expect(existsSync(join(f.scratch, 'work/started'))).toBe(false);
    writeFileSync(join(controlDir, 'host.closed'), '');
    await failed;
    expect(f.channel.evidence().connections).toBe(0);
  } finally { await f.close(); if (controlDir) rmSync(controlDir, { recursive: true, force: true }); }
});

test('an accept-time checkpoint consumes an exit without waiting for the polling timer', async () => {
  const f = await fixture(); const control = join(f.root, 'controls'); mkdirSync(control);
  const monitor = watchLauncher(control, f.channel); f.checkWith(monitor.check);
  try {
    appendFileSync(join(control, 'launch.jsonl'), JSON.stringify({ phase: 'starting' }) + '\n');
    await awaitHost(control, 'starting');
    appendFileSync(join(control, 'launch.jsonl'), JSON.stringify({ phase: 'exited', exitAtNs: process.hrtime.bigint().toString() }) + '\n');
    const socket = connect(Number(new URL(f.channel.environment.HTTPS_PROXY!).port), '127.0.0.1');
    socket.on('error', () => undefined); socket.write('leftover');
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect(f.received()).toBe('');
    expect(f.channel.evidence()).toMatchObject({ blockedConnections: 1, postExitConnections: 0 });
    expect(monitor.evidence()).toEqual({ started: true, exited: true, failures: [] });
  } finally { await monitor.close(); await f.close(); }
});

test.each(['starting', 'exited'] as const)('shutdown consumes a pending %s without opening forwarding', async phase => {
  const f = await fixture(); const control = join(f.root, 'controls'); mkdirSync(control);
  const monitor = watchLauncher(control, f.channel);
  try {
    if (phase === 'exited') {
      appendFileSync(join(control, 'launch.jsonl'), JSON.stringify({ phase: 'starting' }) + '\n');
      await awaitHost(control, 'starting');
    }
    appendFileSync(join(control, 'launch.jsonl'), JSON.stringify({ phase, exitAtNs: process.hrtime.bigint().toString() }) + '\n');
    await monitor.close();
    expect(monitor.evidence()).toEqual({ started: phase === 'exited', exited: phase === 'exited', failures: [] });
    if (phase === 'exited') await expect(awaitHost(control, 'exited')).resolves.toBeUndefined();
    const socket = connect(Number(new URL(f.channel.environment.HTTPS_PROXY!).port), '127.0.0.1');
    socket.on('error', () => undefined); socket.write('leftover');
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect(f.received()).toBe(''); expect(f.channel.evidence().blockedConnections).toBe(1);
  } finally { await monitor.close(); await f.close(); }
});

test.each(['exit', 'shutdown', 'invalid-log'])('trusted lifecycle %s revokes held sockets and prevents reopening', async mode => {
  const f = await fixture(); const control = join(f.root, 'controls'); mkdirSync(control);
  const monitor = watchLauncher(control, f.channel);
  const signal = (phase: LaunchPhase) => appendFileSync(join(control, 'launch.jsonl'), JSON.stringify({ phase,
    ...(phase === 'exited' ? { exitAtNs: process.hrtime.bigint().toString() } : {}) }) + '\n');
  try {
    signal('starting'); await awaitHost(control, 'starting');
    const socket = connect(Number(new URL(f.channel.environment.HTTPS_PROXY!).port), '127.0.0.1');
    socket.on('error', () => undefined);
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    const echo = new Promise<void>(resolve => socket.once('data', () => resolve()));
    socket.write('held'); await echo;
    expect(f.received()).toBe('held');
    if (mode === 'exit') { signal('exited'); await awaitHost(control, 'exited'); }
    else if (mode === 'shutdown') await monitor.close();
    else { signal('starting'); await expect(awaitHost(control, 'exited')).rejects.toThrow('host closed'); }
    await closed;
    const denied = connect(Number(new URL(f.channel.environment.HTTPS_PROXY!).port), '127.0.0.1');
    denied.on('error', () => undefined); denied.write('leftover');
    await new Promise<void>(resolve => denied.once('close', () => resolve()));
    expect(f.received()).toBe('held'); expect(f.channel.evidence().blockedConnections).toBe(1);
    if (mode === 'exit') {
      signal('starting'); await expect.poll(() => existsSync(join(control, 'host.closed'))).toBe(true);
      await expect(awaitHost(control, 'starting')).rejects.toThrow('host closed');
    }
    await monitor.close(); await f.channel.close();
    expect(f.channel.evidence().closed).toBe(true);
    if (mode !== 'shutdown') expect(monitor.evidence().failures).toHaveLength(1);
  } finally { await monitor.close(); await f.close(); }
});
