import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Exercise the pinned SDK client with explicit protocol selection; the default
// remains the legacy era for existing fixtures and independent service probes.
export async function createHttpTestClient(port, token, protocol = '2025-11-25') {
  const client = new Client({ name: 'wayfinder-http-test', version: '0.1.0' }, {
    supportedProtocolVersions: [protocol],
    versionNegotiation: { mode: protocol === '2025-11-25' ? 'legacy' : { pin: protocol } },
  });
  const requests = [];
  let negotiatedProtocol;
  let initializeResult;
  let streamResponse;
  const streamProbe = new Promise(resolve => { streamResponse = resolve; });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, options) => {
      requests.push({ method: options?.method, headers: Object.fromEntries(new Headers(options?.headers)),
        body: options?.body ? JSON.parse(options.body) : null });
      const response = await fetch(url, options);
      if (options?.method === 'GET') streamResponse({ status: response.status });
      if (options?.body && JSON.parse(options.body).method === 'initialize' && response.ok) {
        const text = await response.clone().text();
        const payload = response.headers.get('content-type')?.includes('text/event-stream')
          ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.result)
          : JSON.parse(text);
        initializeResult = payload.result;
        negotiatedProtocol = initializeResult.protocolVersion;
      }
      return response;
    },
  });
  await client.connect(transport);
  negotiatedProtocol = client.getNegotiatedProtocolVersion();
  return { client, transport, negotiatedProtocol, initializeResult, streamProbe, requests };
}
