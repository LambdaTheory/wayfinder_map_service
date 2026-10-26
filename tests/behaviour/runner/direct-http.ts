import { Agent, request } from 'node:http';
import { Readable } from 'node:stream';

/** Private agents never consult Node's global agent or its environment/config-file proxy settings. */
export const directAgent = () => new Agent({ proxyEnv: {}, keepAlive: false });

/** SDK fetch adapter for one owned local MCP endpoint, including streaming GET responses and aborts.
 * Redirects are returned as errors to the SDK, never followed with a credential. */
export function directFetch(endpoint: URL, agent: Agent): typeof fetch {
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
    throw new Error('Direct MCP transport requires an owned loopback HTTP endpoint');
  return async (input, init) => {
    const outgoing = new Request(input, init);
    if (outgoing.url !== endpoint.href) throw new Error('Direct MCP transport endpoint changed');
    const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const req = request(endpoint, { agent, method: outgoing.method,
        headers: Object.fromEntries(outgoing.headers), signal: outgoing.signal }, response => {
        try {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
          const status = response.statusCode ?? 500;
          const noBody = outgoing.method === 'HEAD' || [204, 205, 304].includes(status);
          if (noBody) response.resume();
          // Node and DOM declare different BYOB generics for the same runtime Web Stream.
          const stream = noBody ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(stream, { status, headers, statusText: response.statusMessage ?? '' }));
        } catch (error) { response.destroy(); reject(error); }
      });
      req.once('error', reject);
      req.end(body);
    });
  };
}
