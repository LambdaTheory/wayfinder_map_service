// A transparent TCP hop: no proxy credentials are inspected and no ambient HTTP agent is used.
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { proxyRouting, proxySecrets } from '../proxy.ts';
import { freePort } from './service.ts';
import { protectProxyPorts } from './network-ports.ts';
import type { ProxyPermit } from './network-ports.ts';

export interface ProxyChannel {
  environment: Record<string, string>;
  permit?: ProxyPermit;
  activate(): () => void;
  revokeAt(exitedAt: bigint): void;
  observe(): Promise<void>;
  close(): Promise<void>;
  evidence(): { enabled: boolean; connections: number; blockedConnections: number; postExitConnections?: number; closed: boolean };
}

export const proxyChannelSecrets = (original: NodeJS.ProcessEnv, rewritten: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(proxySecrets(original, rewritten)).map(([name, value]) => [name.replace('proxy-', 'proxy-channel-'), value]));

export async function startProxyChannel(input: NodeJS.ProcessEnv, checkpoint?: () => void): Promise<ProxyChannel> {
  const routing = proxyRouting(input);
  const environment = { ...routing.environment };
  const listeners: ReturnType<typeof createServer>[] = [];
  const sockets = new Set<Socket>();
  const endpoints = new Map<number, number>();
  let users = 0; let closed = false; let connections = 0; let blockedConnections = 0;
  const forwardedAt: bigint[] = [];
  let exitedAt: bigint | undefined;
  let protectedPorts: ReturnType<typeof protectProxyPorts> | undefined;
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true; users = 0; disconnect();
    await Promise.all(listeners.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    protectedPorts?.release();
  })();
  try {
    for (const target of routing.ports) {
      const server = createServer(client => {
        const acceptedAt = process.hrtime.bigint();
        connections++;
        // An interactive exit may already be in the trusted log even if its timer has not fired.
        checkpoint?.();
        if (closed || users === 0) { blockedConnections++; client.destroy(); return; }
        forwardedAt.push(acceptedAt);
        const upstream = connect({ host: '127.0.0.1', port: target });
        for (const socket of [client, upstream]) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
        const stop = () => { client.destroy(); upstream.destroy(); };
        client.once('error', stop); upstream.once('error', stop);
        client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
        client.pipe(upstream); upstream.pipe(client);
      });
      const port = await freePort([...routing.ports, ...endpoints.values()]);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      listeners.push(server); endpoints.set(target, port);
    }
    if (endpoints.size) protectedPorts = protectProxyPorts([...endpoints.values()]);
    for (const [key, value] of Object.entries(environment)) {
      if (!value || key.toLowerCase() === 'no_proxy') continue;
      const url = new URL(value); url.port = String(endpoints.get(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))!);
      environment[key] = url.href;
    }
    return { environment, ...(protectedPorts ? { permit: protectedPorts.permit } : {}),
      activate() {
        if (closed || exitedAt !== undefined) throw new Error('Attempt proxy channel is closed');
        users++; let released = false;
        return () => { if (!released) { released = true; if (!closed && users > 0 && --users === 0) disconnect(); } };
      },
      revokeAt(at) {
        // Same-host monotonic nanoseconds (Node 26.3/macOS uses mach_continuous_time).
        // Retain the already-forwarded connections separately: they were not blocked in time.
        users = 0; disconnect();
        if (at < 0n || at > process.hrtime.bigint()) throw new Error('Invalid client exit time');
        exitedAt = exitedAt === undefined || at < exitedAt ? at : exitedAt;
      },
      async observe() { if (endpoints.size && !closed && users === 0) await new Promise(resolve => setTimeout(resolve, 500)); },
      close,
      evidence: () => ({ enabled: endpoints.size > 0, connections, blockedConnections,
        ...(exitedAt === undefined ? {} : { postExitConnections: forwardedAt.filter(at => at >= exitedAt!).length }), closed }),
    };
  } catch (error) { await close(); throw error; }
}
