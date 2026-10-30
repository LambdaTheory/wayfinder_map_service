// Local transport adapter only. The HTTP service remains the authority for
// initialization instructions, tool schemas, credentials and all Map state.
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export async function connectWindowsMcpStdio(port: number, token: string): Promise<void> {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000,
      initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  });
  let closing = false;
  let initializeId: string | number | undefined;
  async function close(failed = false) {
    if (closing) return;
    closing = true;
    if (failed) {
      // Never print the transport error: it can contain headers or payloads.
      process.stderr.write('Wayfinder MCP connection failed; check this Windows instance and restart the client connection.\n');
      process.exitCode = 1;
    }
    await Promise.allSettled([local.close(), remote.close()]);
  }
  local.onmessage = message => {
    if ('method' in message && message.method === 'initialize' && 'id' in message) initializeId = message.id;
    void remote.send(message).catch(() => close(true));
  };
  remote.onmessage = message => {
    if ('id' in message && message.id === initializeId && 'result' in message) {
      const result = message.result;
      if (typeof result.protocolVersion === 'string') remote.setProtocolVersion(result.protocolVersion);
    }
    void local.send(message).catch(() => close(true));
  };
  local.onerror = remote.onerror = () => { void close(true); };
  local.onclose = remote.onclose = () => { void close(); };
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await remote.start();
  await local.start();
}
