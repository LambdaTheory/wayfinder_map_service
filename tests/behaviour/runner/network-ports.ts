// Process-local harness endpoint ownership. Cross-process callers must also supply their known ports.
import { existsSync } from 'node:fs';

export const reservedPorts = [18765, 18766];
const retiredProxyPorts = new Set<number>();
const protectedPorts = new Map<number, number>();
const proxyGrants = new Map<string, Set<number>>();
export const isProtectedPort = (port: number) => reservedPorts.includes(port) || protectedPorts.has(port) || retiredProxyPorts.has(port);
function proxyPorts(): Set<number> {
  for (const owner of proxyGrants.keys()) if (!existsSync(owner)) proxyGrants.delete(owner);
  return new Set([...proxyGrants.values()].flatMap(ports => [...ports]));
}
export const portUnavailable = (port: number) => isProtectedPort(port) || proxyPorts().has(port);

/** Reserve proxy capabilities for as long as the runner-owned control directory survives. */
export function reserveProxyPorts(owner: string, ports: readonly number[], permit?: ProxyPermit): void {
  if (ports.some(port => isProtectedPort(port) && !permitsProxyPort(permit, port))) throw new Error('Proxy uses a protected harness endpoint');
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

/** Only the controller that created a forwarding listener can grant its protected port to a client. */
export interface ProxyPermit { readonly proxyPermit: unique symbol }
const permits = new WeakMap<ProxyPermit, Set<number>>();
export const permitsProxyPort = (permit: ProxyPermit | undefined, port: number) => !!permit && !!permits.get(permit)?.has(port);
export function protectProxyPorts(ports: number[]): { permit: ProxyPermit; release(): void } {
  const release = protectPorts(ports); const permit = Object.freeze({}) as ProxyPermit;
  permits.set(permit, new Set(ports));
  return { permit, release: () => { ports.forEach(port => retiredProxyPorts.add(port)); release(); } };
}
