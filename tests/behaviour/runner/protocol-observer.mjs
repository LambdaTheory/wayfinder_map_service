// Instrumentation for every disposable Batch service. No arguments, tokens, paths or business results.
import '../../helpers/codex-acceptance-observer.mjs';
import { Server } from 'node:http';
import { appendFileSync } from 'node:fs';

const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && process.env.WAYFINDER_PROTOCOL_REPORT) {
    const [req] = args;
    const requestEmit = req.emit;
    let body = ''; let bytes = 0;
    // Observe what the service consumes; never add a data listener or switch the request into flowing mode.
    req.emit = function (name, ...values) {
      if (name === 'data') {
        bytes += values[0].length;
        if (bytes <= 1_048_576) body += values[0];
        else body = '';
      }
      if (name === 'end' && body) {
        try {
          const rpc = JSON.parse(body);
          if (rpc.method === 'tools/call') appendFileSync(process.env.WAYFINDER_PROTOCOL_REPORT, JSON.stringify({
            kind: 'tool-call', requestId: rpc.id, sessionId: req.headers['mcp-session-id'] ?? null, tool: rpc.params?.name,
          }) + '\n', { mode: 0o600 });
        } catch { /* A non-JSON request provides no observation. */ }
      }
      return requestEmit.call(this, name, ...values);
    };
  }
  return emit.call(this, event, ...args);
};
