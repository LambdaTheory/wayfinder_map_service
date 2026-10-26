import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Exercise the pinned actual SDK client at runtime. Its accessor declarations
// conflict with its own Transport interface under exactOptionalPropertyTypes;
// this JS test harness does not weaken strict checking of product code.
export async function createHttpTestClient(port, token) {
  const client = new Client({ name: 'wayfinder-http-test', version: '0.1.0' });
  let negotiatedProtocol;
  let initializeResult;
  let streamResponse;
  const streamProbe = new Promise(resolve => { streamResponse = resolve; });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (options?.method === 'GET') streamResponse({ status: response.status });
      if (options?.body && JSON.parse(options.body).method === 'initialize' && response.ok) {
        initializeResult = (await response.clone().json()).result;
        negotiatedProtocol = initializeResult.protocolVersion;
      }
      return response;
    },
  });
  await client.connect(transport);
  return { client, transport, negotiatedProtocol, initializeResult, streamProbe };
}
