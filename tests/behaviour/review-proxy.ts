import { claudeProxyEnvironment, proxyVariables } from './interactive/subscription.ts';
import { reservedPorts } from './runner/service.ts';

export { proxyVariables as reviewProxyVariables };
export class ReviewProxyError extends Error {}

/** Only select proxy keys; never forward settings, hooks, credentials or arbitrary environment entries. */
export function reviewProxyEnvironment(subscriptionHome: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  try {
    return claudeProxyEnvironment(subscriptionHome, inherited);
  } catch (error) {
    if (error instanceof Error && error.message === 'Claude proxy setting must be a string')
      throw new ReviewProxyError('Review proxy setting must be a string');
    throw new ReviewProxyError('Review proxy settings unavailable; refusing to fall back to a direct connection');
  }
}

/** Validate once before launch; keep the forwarded URLs and sandbox exceptions on the same IPv4 endpoints. */
export function reviewProxyRouting(environment: NodeJS.ProcessEnv): { environment: Record<string, string>; rules: string[] } {
  const selected: Record<string, string> = {};
  for (const key of proxyVariables) if (environment[key] !== undefined) selected[key] = environment[key];
  const endpoints = new Set<string>();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const value = environment[key];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ReviewProxyError('Review proxy URL is invalid'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReviewProxyError('Review proxy URL must use HTTP or HTTPS');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (port === 0) throw new ReviewProxyError('Review proxy URL must use a nonzero port');
    // Refuse even non-loopback URLs on these ports; no proxy exception may target the everyday service or relay.
    if (reservedPorts.includes(port)) throw new ReviewProxyError('Review proxy uses a reserved Wayfinder port');
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
      throw new ReviewProxyError('Review proxy must use localhost or 127.0.0.1');
    // Seatbelt's tcp6 localhost exception also admits IPv4-mapped sockets. Never generate that exception.
    // Normalize localhost so native clients cannot resolve it to ::1 while the policy permits only IPv4.
    url.hostname = '127.0.0.1'; selected[key] = url.href;
    endpoints.add(`(remote tcp4 "localhost:${port}")`);
  }
  return { environment: selected, rules: [...endpoints].map(endpoint => `(allow network-outbound ${endpoint})`) };
}
