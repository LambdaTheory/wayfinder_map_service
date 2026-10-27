import type { ServerResponse } from 'node:http';

// Modern auto mode switches to SSE as soon as a handler emits progress. Parse
// complete events across arbitrary byte boundaries, redact protocol errors, and
// observe only terminal responses. Never buffer a whole long-running response.
export async function sendMcpResponse(result: Response, response: ServerResponse, observe: (payload: Record<string, unknown> | undefined) => void) {
  const clean = (payload: Record<string, unknown>) => {
    if ('result' in payload || 'error' in payload) observe(payload);
    if (payload.error && typeof payload.error === 'object') payload.error = {
      code: (payload.error as { code: number }).code, message: 'Protocol request failed',
    };
    return JSON.stringify(payload);
  };
  const headers = Object.fromEntries(result.headers);
  delete headers['content-length']; // Redaction can change the encoded length.
  if (!response.destroyed) response.writeHead(result.status, headers);
  if (!result.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await result.text();
    const payload = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    if (!payload) observe(undefined);
    if (!response.destroyed) response.end(payload ? clean(payload) : undefined);
    return;
  }
  response.flushHeaders();
  const reader = result.body!.pipeThrough(new TextDecoderStream()).getReader();
  const disconnected = () => { void reader.cancel().catch(() => {}); };
  response.once('close', disconnected);
  let pending = '';
  const event = (block: string) => {
    const lines = block.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    // Preserve transport event IDs and retry fields, but never raw SDK errors.
    const rest = lines.filter(line => !line.startsWith('data:')).join('\n');
    const encoded = data ? `${rest ? `${rest}\n` : ''}data: ${clean(JSON.parse(data) as Record<string, unknown>)}\n\n` : `${rest}\n\n`;
    if (!response.destroyed) response.write(encoded);
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += chunk.value;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        event(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
      }
    }
    if (pending.trim()) event(pending);
    if (!response.destroyed) response.end();
  } finally { response.removeListener('close', disconnected); reader.releaseLock(); }
}
