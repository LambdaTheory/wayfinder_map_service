import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProtectedPort, permitsProxyPort, reservedPorts } from './runner/network-ports.ts';

import type { ProxyPermit } from './runner/network-ports.ts';

export class ProxyError extends Error {}

export const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;

/** null selects tested Codex clients' terminal-only route; Claude and both B03b reviewers supply settings HOME. */
export function proxyEnvironment(subscriptionHome: string | null, inherited: NodeJS.ProcessEnv): Record<string, string> {
  let settings: { env?: Record<string, unknown> } = {};
  try {
    if (subscriptionHome !== null) settings = JSON.parse(readFileSync(join(subscriptionHome, '.claude/settings.json'), 'utf8'));
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

/** Validate before launch; keep the forwarded URLs and sandbox exceptions on the same IPv4 endpoints. */
export function proxyRouting(environment: NodeJS.ProcessEnv, protectedPorts: readonly number[] = [], permit?: ProxyPermit): { environment: Record<string, string>; rules: string[]; ports: number[] } {
  const selected: Record<string, string> = {};
  for (const key of proxyVariables) if (environment[key] !== undefined) selected[key] = environment[key];
  const endpoints = new Set<number>();
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
    if ((isProtectedPort(port) && !permitsProxyPort(permit, port)) || protectedPorts.includes(port)) throw new ProxyError('Proxy uses a protected harness endpoint');
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
      throw new ProxyError('Proxy must use localhost or 127.0.0.1');
    // Seatbelt's tcp6 localhost exception also admits IPv4-mapped sockets. Never generate that exception.
    // Normalize localhost so native clients cannot resolve it to ::1 while the policy permits only IPv4.
    url.hostname = '127.0.0.1'; selected[key] = url.href;
    endpoints.add(port);
  }
  return { environment: selected, ports: [...endpoints], rules: [...endpoints].map(port => `(allow network-outbound (remote tcp4 "localhost:${port}"))`) };
}

/** Safe Batch metadata: no URLs, credentials or bypass-list values. */
export function proxySummary(environment: NodeJS.ProcessEnv, permit?: ProxyPermit) {
  const routing = proxyRouting(environment, [], permit);
  return { enabled: routing.rules.length > 0, variables: Object.keys(routing.environment) };
}

/** Register native echo forms without including bypass lists or unrelated environment entries. */
export function proxySecrets(original: NodeJS.ProcessEnv, normalized: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = {};
  const add = (name: string, value: string | undefined) => { if (value) secrets[name] = value; };
  for (const key of proxyVariables.filter(key => key.toLowerCase() !== 'no_proxy')) {
    for (const [suffix, environment] of [['', original], ['-normalized', normalized]] as const) {
      const value = environment[key]; if (!value) continue;
      const label = `proxy-${key}${suffix}`;
      add(label, value);
      const url = new URL(value); // Callers have already validated the selected routing.
      const userinfo = url.password ? `${url.username}:${url.password}` : '';
      for (const [field, part] of [['userinfo', userinfo], ['username', url.username], ['password', url.password]]) {
        add(`${label}-${field}`, part);
        add(`${label}-${field}-lowercase-escapes`, part?.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()));
        try {
          const decoded = decodeURIComponent(part!);
          add(`${label}-${field}-decoded`, decoded);
          add(`${label}-${field}-encoded`, encodeURIComponent(decoded));
        } catch { /* An invalid percent escape has only its literal representation. */ }
      }
      if (userinfo) {
        try { add(`${label}-basic`, `Basic ${Buffer.from(decodeURIComponent(userinfo)).toString('base64')}`); }
        catch { /* Invalid escapes are already registered literally. */ }
      }
    }
  }
  // Replace whole URLs/userinfo before their components when values overlap.
  return Object.fromEntries(Object.entries(secrets).sort((a, b) => b[1].length - a[1].length));
}
