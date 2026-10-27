import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { directAgent, directFetch } from './direct-http.ts';

// The independent fixture controller keeps the SDK's legacy connection default;
// test-agent traffic selects and exercises its own protocol era.
export async function createControllerClient(port, token) {
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const agent = directAgent();
  const client = new Client({ name: 'wayfinder-behaviour-controller', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } },
    fetch: directFetch(endpoint, agent),
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  });
  const close = async () => { try { await client.close(); } finally { agent.destroy(); } };
  try { await client.connect(transport); }
  catch (error) { await close(); throw error; }
  return { client, close };
}
