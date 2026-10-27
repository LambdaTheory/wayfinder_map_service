import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { sendMcpResponse } from '../src/mcp-response.js';

test('SSE forwards progress before completion, parses split UTF-8/CRLF/multiline data and redacts errors', async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const observed: unknown[] = [];
  const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 0, message: '等待' } };
  const server = createServer(async (_request, response) => {
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      const first = new TextEncoder().encode(`: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(progress)}\r\n\r\n`);
      for (const byte of first) controller.enqueue(Uint8Array.of(byte));
      await gate;
      const last = new TextEncoder().encode('event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"error":{"code":-32602,"message":"private-path","data":"private-token"}}\r\n\r\n');
      for (const byte of last) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } });
    await sendMcpResponse(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), response, value => observed.push(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture port');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`); const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = ''; while (!text.includes('等待')) text += (await reader.read()).value;
    expect(text).toContain('notifications/progress'); expect(observed).toEqual([]);
    finish(); for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += chunk.value; }
    expect(text).toContain('Protocol request failed'); expect(text).not.toContain('private-');
    expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject({ id: 1, error: { code: -32602 } });
  } finally { finish(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
