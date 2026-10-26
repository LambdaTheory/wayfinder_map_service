// The pinned SDK uses global fetch and the relay uses node:http. Neither may inherit a proxy for credentials.
export function nodeProxyRefusal(): string | null {
  const enabled = process.env.NODE_USE_ENV_PROXY === '1'
    || process.execArgv.map(value => value.replaceAll('_', '-')).some(value => value === '--use-env-proxy' || value.startsWith('--use-env-proxy='))
    || /(?:^|[\s"'])--use-env-proxy(?:$|[\s="'])/.test((process.env.NODE_OPTIONS ?? '').replaceAll('_', '-'));
  return enabled ? 'Node environment proxy mode is unsupported for authenticated local harness traffic' : null;
}
export function requireDirectRuntime(): void {
  const refusal = nodeProxyRefusal(); if (refusal) throw new Error(refusal);
}
