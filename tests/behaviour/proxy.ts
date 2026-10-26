import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reservedPorts } from './runner/service.ts';

export class ProxyError extends Error {}

export const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;

/** Match the dedicated launcher's precedence, retaining only its six proxy variables. */
export function proxyEnvironment(subscriptionHome: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  let settings: { env?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(readFileSync(join(subscriptionHome, '.claude/settings.json'), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)))) {
      throw new Error('Invalid settings shape');
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ProxyError('Proxy settings unavailable; refusing to fall back to a direct connection');
  }
  const selected: Record<string, string> = {};
  for (const key of proxyVariables) {
    const value = inherited[key] ?? settings.env?.[key];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new ProxyError('Proxy setting must be a string');
      selected[key] = value;
    }
  }
  return selected;
}

/** Validate once before launch; keep the forwarded URLs and sandbox exceptions on the same IPv4 endpoints. */
export function proxyRouting(environment: NodeJS.ProcessEnv): { environment: Record<string, string>; rules: string[] } {
  const selected: Record<string, string> = {};
  for (const key of proxyVariables) if (environment[key] !== undefined) selected[key] = environment[key];
  const endpoints = new Set<string>();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const value = environment[key];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ProxyError('Proxy URL is invalid'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError('Proxy URL must use HTTP or HTTPS');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (port === 0) throw new ProxyError('Proxy URL must use a nonzero port');
    // Refuse even non-loopback URLs on these ports; no proxy exception may target the everyday service or relay.
    if (reservedPorts.includes(port)) throw new ProxyError('Proxy uses a reserved Wayfinder port');
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
      throw new ProxyError('Proxy must use localhost or 127.0.0.1');
    // Seatbelt's tcp6 localhost exception also admits IPv4-mapped sockets. Never generate that exception.
    // Normalize localhost so native clients cannot resolve it to ::1 while the policy permits only IPv4.
    url.hostname = '127.0.0.1'; selected[key] = url.href;
    endpoints.add(`(remote tcp4 "localhost:${port}")`);
  }
  return { environment: selected, rules: [...endpoints].map(endpoint => `(allow network-outbound ${endpoint})`) };
}

/** Safe Batch metadata: no URLs, credentials or bypass-list values. */
export function proxySummary(environment: NodeJS.ProcessEnv) {
  const routing = proxyRouting(environment);
  return { enabled: routing.rules.length > 0, variables: Object.keys(routing.environment) };
}
