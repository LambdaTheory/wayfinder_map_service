// A private route per session. It forwards the client's bytes unchanged and lets the Controller
// interpose before a write, without filling arguments or turning its observations into agent receipts.
import { createServer, request } from 'node:http';
import { freePort } from './service.ts';

export interface RpcRequest { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
export interface Route {
  port: number;
  sessionIds: Set<string>;
  before?: (rpc: RpcRequest) => Promise<void>;
  after?: (rpc: RpcRequest, body: string) => Promise<void>;
  cut(): void;
  close(): Promise<void>;
}

export async function startRoute(target: number, observe: (record: unknown) => void): Promise<Route> {
  let cut = false;
  const upstream = new Set<ReturnType<typeof request>>();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let rpc: RpcRequest = {};
      try { rpc = JSON.parse(body.toString()) as RpcRequest; } catch { /* GET/DELETE have no JSON body */ }
      const sessionId = req.headers['mcp-session-id'] ?? null;
      observe({ phase: 'request', at: new Date().toISOString(), method: req.method, sessionId, rpc });
      if (cut && rpc.method === 'tools/call') { res.writeHead(503).end('Service Unavailable'); observe({ phase: 'cut', sessionId, rpc }); return; }
      await route.before?.(rpc);
      const proxy = request({ hostname: '127.0.0.1', port: target, method: req.method, path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${target}` } }, response => {
        const id = response.headers['mcp-session-id'];
        if (typeof id === 'string') route.sessionIds.add(id);
        // Stream responses as they arrive (including SSE). Capture each response for hooks and raw evidence.
        const captured: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { captured.push(chunk); });
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res, { end: false });
        response.on('end', () => {
          const text = Buffer.concat(captured).toString();
          observe({ phase: 'response', at: new Date().toISOString(), requestId: rpc.id, method: rpc.method, sessionId: id ?? sessionId, status: response.statusCode, body: text });
          void Promise.resolve(route.after?.(rpc, text)).then(() => res.end(), error => res.destroy(error as Error));
        });
      });
      upstream.add(proxy);
      proxy.on('close', () => upstream.delete(proxy));
      proxy.on('error', error => { observe({ phase: 'error', requestId: rpc.id, error: error.message }); if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => proxy.destroy());
      proxy.end(body);
    } catch (error) {
      observe({ phase: 'hook-error', error: String(error) });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  const route: Route = { port: await freePort(), sessionIds: new Set(),
    cut: () => { cut = true; },
    close: async () => { for (const req of upstream) req.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(route.port, '127.0.0.1', resolve); });
  return route;
}

/** Structured result from JSON or an SSE message; absence is not a successful read. */
export function structuredReply(body: string): Record<string, unknown> | undefined {
  for (const line of [body, ...body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())]) {
    try { const rpc = JSON.parse(line) as { result?: { structuredContent?: Record<string, unknown> } }; if (rpc.result?.structuredContent) return rpc.result.structuredContent; } catch { /* another SSE line */ }
  }
  return undefined;
}
