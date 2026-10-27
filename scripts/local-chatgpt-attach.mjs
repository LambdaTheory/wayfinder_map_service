import { Agent, request } from 'node:http';

/** Probe an existing service and close the temporary MCP session. */
export async function acceptsLocalChatGptToken(servicePort, token) {
  // Never consult the global agent/fetch dispatcher or ambient proxy configuration.
  const agent = new Agent({ proxyEnv: {}, keepAlive: false });
  const headers = {
    authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  };
  const send = (method, body, session) => new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: servicePort, path: '/mcp', method, agent,
      headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) },
      signal: AbortSignal.timeout(3000),
    }, response => {
      response.once('error', reject);
      response.once('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        session: response.headers['mcp-session-id'],
      }));
      // The probe only needs status and session headers; consume the body to release the socket.
      response.resume();
    });
    req.once('error', reject);
    req.end(body);
  });
  try {
    const reply = await send('POST', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chatgpt-test-runner', version: '1' } },
    }));
    // node:http never follows redirects, so the credential stays on this endpoint.
    if (reply.session) await send('DELETE', undefined, reply.session);
    return reply.ok;
  } catch { return false; }
  finally { agent.destroy(); }
}
