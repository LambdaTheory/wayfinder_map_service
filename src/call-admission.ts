import type { CallToolResult } from '@modelcontextprotocol/server';

// Suspended waits release their admission slot. Their eventual delivery queues
// for a slot instead of being rejected as a new busy call.
export class CallAdmission {
  private active = 0;
  private stopping = false;
  private readonly queued = new Set<() => void>();
  private readonly drains = new Set<() => void>();

  async admit(call: (suspend: () => void) => Promise<CallToolResult>): Promise<CallToolResult> {
    const code = this.stopping ? 'service_stopping' : this.active >= 4 ? 'service_busy' : undefined;
    if (code) return { content: [], isError: true, structuredContent: {
      kind: 'infrastructure_error', code, outcome: 'not_published', requiresRestart: false,
    } };
    this.active++;
    let held = true;
    const suspend = () => { if (held) { held = false; this.leave(); } };
    try { return await call(suspend); } finally { suspend(); }
  }

  async release<T>(call: () => T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= 4) await new Promise<void>((resolve, reject) => {
      const abort = () => { this.queued.delete(ready); reject(signal.reason); };
      const ready = () => { signal.removeEventListener('abort', abort); this.active++; resolve(); };
      this.queued.add(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
    else this.active++;
    try { signal.throwIfAborted(); return call(); } finally { this.leave(); }
  }

  stop() { this.stopping = true; }
  async drain() { if (this.active) await new Promise<void>(resolve => this.drains.add(resolve)); }
  private leave() {
    this.active--;
    const next = this.queued.values().next().value;
    if (next) { this.queued.delete(next); next(); }
    if (this.active === 0) { for (const resolve of this.drains) resolve(); this.drains.clear(); }
  }
}
