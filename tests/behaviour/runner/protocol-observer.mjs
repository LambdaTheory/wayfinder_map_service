// Passive instrumentation of this disposable service only. No arguments, tokens, paths or business results.
import '../../helpers/codex-acceptance-observer.mjs';
import { Server } from 'node:http';
import { appendFileSync } from 'node:fs';

const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && process.env.WAYFINDER_PROTOCOL_REPORT) {
    const [req] = args;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const rpc = JSON.parse(body);
        if (rpc.method === 'tools/call') appendFileSync(process.env.WAYFINDER_PROTOCOL_REPORT, JSON.stringify({
          kind: 'tool-call', requestId: rpc.id, sessionId: req.headers['mcp-session-id'] ?? null, tool: rpc.params?.name,
        }) + '\n', { mode: 0o600 });
      } catch { /* A non-JSON request provides no observation. */ }
    });
  }
  return emit.call(this, event, ...args);
};
