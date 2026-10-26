// Process-local harness endpoint ownership. Cross-process callers must also supply their known ports.
import { existsSync } from 'node:fs';

export const reservedPorts = [18765, 18766];
const protectedPorts = new Map<number, number>();
const proxyGrants = new Map<string, Set<number>>();
export const isProtectedPort = (port: number) => reservedPorts.includes(port) || protectedPorts.has(port);
function proxyPorts(): Set<number> {
  for (const owner of proxyGrants.keys()) if (!existsSync(owner)) proxyGrants.delete(owner);
  return new Set([...proxyGrants.values()].flatMap(ports => [...ports]));
}
export const portUnavailable = (port: number) => isProtectedPort(port) || proxyPorts().has(port);

/** Reserve proxy capabilities for as long as the runner-owned control directory survives. */
export function reserveProxyPorts(owner: string, ports: readonly number[]): void {
  if (ports.some(isProtectedPort)) throw new Error('Proxy uses a protected harness endpoint');
  proxyGrants.set(owner, new Set([...(proxyGrants.get(owner) ?? []), ...ports]));
}

/** A service/relay (and a relay's upstream) cannot occupy an already granted proxy endpoint. */
export function protectPorts(ports: readonly number[]): () => void {
  const proxies = proxyPorts();
  if (ports.some(port => proxies.has(port) || reservedPorts.includes(port))) throw new Error('Harness endpoint collides with a proxy or reserved port');
  for (const port of ports) protectedPorts.set(port, (protectedPorts.get(port) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    for (const port of ports) {
      const remaining = (protectedPorts.get(port) ?? 1) - 1;
      if (remaining) protectedPorts.set(port, remaining); else protectedPorts.delete(port);
    }
  };
}
