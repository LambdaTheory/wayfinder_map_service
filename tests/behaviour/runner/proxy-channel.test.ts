import { connect, createServer } from 'node:net';
import { expect, test } from 'vitest';
import { startProxyChannel } from './proxy-channel.ts';
import { portUnavailable } from './network-ports.ts';
import type { ProxyPermit } from './network-ports.ts';
import { proxyRouting } from '../proxy.ts';

const exchange = (port: number, payload: Buffer) => new Promise<Buffer>((resolve, reject) => {
  const client = connect(port, '127.0.0.1', () => client.write(payload));
  client.once('error', reject); client.once('data', bytes => { client.destroy(); resolve(typeof bytes === 'string' ? Buffer.from(bytes) : bytes); });
});
const rejected = (port: number) => new Promise<void>(resolve => {
  const client = connect(port, '127.0.0.1'); client.on('error', () => undefined); client.on('close', () => resolve());
});

test('Attempt channels forward only during a client lease, disconnect old sockets, and cannot be borrowed by another permit', async () => {
  let upstreamConnections = 0;
  const upstream = createServer(socket => { upstreamConnections++; socket.on('error', () => undefined); socket.on('data', bytes => socket.write(bytes)); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const target = (upstream.address() as { port: number }).port;
  const input = { HTTP_PROXY: `http://run:synthetic@localhost:${target}`, HTTPS_PROXY: `https://run:synthetic@localhost:${target}`, NO_PROXY: 'localhost' };
  const first = await startProxyChannel(input); const second = await startProxyChannel(input);
  try {
    const port = Number(new URL(first.environment.HTTP_PROXY!).port);
    expect(port).not.toBe(target); expect(new URL(first.environment.HTTPS_PROXY!).port).toBe(String(port));
    expect(first.environment.NO_PROXY).toBe('localhost');
    expect(() => proxyRouting(first.environment)).toThrow('protected harness endpoint');
    expect(() => proxyRouting(first.environment, [], {} as ProxyPermit)).toThrow('protected harness endpoint');
    expect(() => proxyRouting(first.environment, [], second.permit)).toThrow('protected harness endpoint');
    expect(proxyRouting(first.environment, [], first.permit).ports).toEqual([port]);
    await rejected(port); expect(upstreamConnections).toBe(0);
    const release = first.activate();
    expect(await exchange(port, Buffer.from([0, 255, 128, 1]))).toEqual(Buffer.from([0, 255, 128, 1]));
    const held = connect(port, '127.0.0.1'); held.on('error', () => undefined);
    await new Promise<void>(resolve => { held.once('data', () => resolve()); held.once('connect', () => held.write('held')); });
    const disconnected = new Promise<void>(resolve => held.once('close', () => resolve()));
    release(); await disconnected;
    const count = upstreamConnections;
    await rejected(port); expect(upstreamConnections).toBe(count);
    expect(first.evidence().blockedConnections).toBe(2);
    await first.close(); expect(first.evidence().closed).toBe(true); expect(portUnavailable(port)).toBe(true);
    expect(() => first.activate()).toThrow('closed');
    await rejected(port); expect(upstreamConnections).toBe(count);
  } finally {
    await first.close(); await second.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('a delayed exit signal accounts for already-forwarded connections at or after the original exit time', async () => {
  const upstream = createServer(socket => { socket.on('error', () => undefined); socket.on('data', bytes => socket.write(bytes)); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const channel = await startProxyChannel({ HTTPS_PROXY: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  try {
    const port = Number(new URL(channel.environment.HTTPS_PROXY!).port);
    channel.activate();
    await exchange(port, Buffer.from('running'));
    const exitedAt = process.hrtime.bigint();
    // The wrapper event has happened, but its signal has not reached the channel yet.
    await exchange(port, Buffer.from('late'));
    channel.revokeAt(exitedAt);
    await rejected(port);
    expect(channel.evidence()).toMatchObject({ connections: 3, blockedConnections: 1, postExitConnections: 1 });
    channel.revokeAt(exitedAt);
    expect(channel.evidence().postExitConnections).toBe(1); // No double counting on cleanup.
    expect(() => channel.activate()).toThrow('closed');
  } finally { await channel.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
