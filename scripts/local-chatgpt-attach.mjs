import { Agent, request } from 'node:http';

/** Probe an existing service and close the temporary MCP session. */
export async function probeLocalChatGptService(servicePort, token) {
  // Never consult the global agent/fetch dispatcher or ambient proxy configuration.
  const agent = new Agent({ proxyEnv: {}, keepAlive: false });
  const headers = {
    authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  };
  let initializedSession;
  const send = (method, body, session) => new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: servicePort, path: '/mcp', method, agent,
      headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) },
      signal: AbortSignal.timeout(3000),
    }, response => {
      // The service already owns this session, even if its response body later fails.
      if (method === 'POST') initializedSession = response.headers['mcp-session-id'];
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        // The initialize body includes workflow instructions; bound it and never log it.
        if (text.length + chunk.length > 1_048_576) { req.destroy(new Error('Initialize response too large')); return; }
        text += chunk;
      });
      response.once('error', reject);
      response.once('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        text,
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
  let accepted = false;
  let version;
  try {
    const reply = await send('POST', JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chatgpt-test-runner', version: '1' } },
    }));
    accepted = reply.ok;
    if (accepted) for (const chunk of [reply.text, ...reply.text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5))]) {
      try {
        const value = JSON.parse(chunk).result?.serverInfo?.version;
        if (typeof value === 'string' && value.length <= 32 && /^\d+\.\d+\.\d+(?:\+dev\.[a-f0-9]+)?$/.test(value)) {
          version = value; break;
        }
      } catch { /* Other SSE frames need not contain the initialize result. */ }
    }
  } catch { /* A failed initialization remains a failed probe after cleanup. */ }
  finally {
    try {
      // Cleanup gets its own bounded request, including after a partial-body failure.
      // node:http never follows redirects, so the credential stays on this endpoint.
      if (initializedSession) await send('DELETE', undefined, initializedSession);
    } catch { accepted = false; }
    finally { agent.destroy(); }
  }
  return { accepted, version: accepted ? version : undefined };
}

export async function acceptsLocalChatGptToken(servicePort, token) {
  return (await probeLocalChatGptService(servicePort, token)).accepted;
}
