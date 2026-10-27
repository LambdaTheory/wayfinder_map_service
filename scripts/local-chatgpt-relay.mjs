import { createServer, request as httpRequest } from 'node:http';

// Both ChatGPT relays preserve MCP routing headers; credentials stay operator-owned.
export const mcpRequestHeaders = [
  'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name',
];
export const mcpResponseHeaders = [
  'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version',
];

/** Create the everyday relay without opening a database, listener or tunnel. */
export function createLocalChatGptRelay(servicePort, token) {
  const relay = createServer((incoming, outgoing) => {
    if (incoming.url !== '/mcp') {
      outgoing.writeHead(404).end();
      return;
    }
    if (!['POST', 'DELETE'].includes(incoming.method)) {
      outgoing.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    if (incoming.headers.origin !== undefined) {
      outgoing.writeHead(403).end();
      return;
    }
    const headers = {
      host: `127.0.0.1:${servicePort}`,
      authorization: `Bearer ${token}`,
    };
    for (const name of [...mcpRequestHeaders, 'content-length']) {
      if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: servicePort, path: '/mcp',
      method: incoming.method, headers,
    }, response => {
      const forwarded = {};
      for (const name of mcpResponseHeaders) {
        if (response.headers[name] !== undefined) forwarded[name] = response.headers[name];
      }
      outgoing.writeHead(response.statusCode ?? 502, forwarded);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502).end();
      else outgoing.destroy();
    });
    incoming.pipe(upstream);
  });
  relay.requestTimeout = 30_000;
  return relay;
}
