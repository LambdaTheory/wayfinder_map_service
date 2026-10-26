// Match PR #98's subscription proxy selection without importing its unrelated host/auth machinery.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const reviewProxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
export class ReviewProxyError extends Error {}

/** Only select proxy keys; never forward settings, hooks, credentials or arbitrary environment entries. */
export function reviewProxyEnvironment(subscriptionHome: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  let settings: { env?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(readFileSync(join(subscriptionHome, '.claude/settings.json'), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)))) {
      throw new Error('Invalid settings shape');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ReviewProxyError('Review proxy settings unavailable; refusing to fall back to a direct connection');
  }
  const selected: Record<string, string> = {};
  for (const key of reviewProxyVariables) {
    const value = inherited[key] ?? settings.env?.[key];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new ReviewProxyError('Review proxy setting must be a string');
      selected[key] = value;
    }
  }
  return selected;
}

/** Keep the localhost deny rule; add only the configured HTTP(S) proxies' loopback TCP ports/families. */
export function reviewProxyRules(environment: NodeJS.ProcessEnv): string[] {
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
    if (port === 18765 || port === 18766) throw new ReviewProxyError('Review proxy uses a reserved Wayfinder port');
    const host = url.hostname;
    // Seatbelt accepts only '*' or 'localhost', not literal IP hosts. Restrict the address family for IP URLs.
    const protocol = host === 'localhost' ? 'tcp' : host === '127.0.0.1' ? 'tcp4' : host === '[::1]' ? 'tcp6' : null;
    if (protocol) endpoints.add(`(remote ${protocol} "localhost:${port}")`);
  }
  return [...endpoints].map(endpoint => `(allow network-outbound ${endpoint})`);
}
