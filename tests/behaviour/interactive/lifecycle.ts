// The existing protected launch log carries wrapper signals; acknowledgements live beside it.
// Neither file is readable/writable by the sandboxed client. No HTTP credential channel is added.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProxyChannel } from '../runner/proxy-channel.ts';

export async function awaitHost(controlDir: string, phase: 'starting' | 'exited'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(join(controlDir, 'host.closed'))) throw new Error('Interactive host closed');
    if (existsSync(join(controlDir, `host.${phase}`))) return;
    await delay(10);
  }
  throw new Error('Interactive host acknowledgement timed out');
}

export function watchLauncher(controlDir: string, channel: ProxyChannel) {
  const log = join(controlDir, 'launch.jsonl');
  let consumed = ''; let running = false; let exited = false; let stopping = false;
  let release: (() => void) | undefined;
  const failures: string[] = [];
  const acknowledge = (phase: string) => writeFileSync(join(controlDir, `host.${phase}`), '', { mode: 0o600, flag: 'wx' });
  const revoke = () => { release?.(); release = undefined; };
  const poll = () => {
    if (!existsSync(log)) return;
    const text = readFileSync(log, 'utf8');
    if (!text.startsWith(consumed)) throw new Error('changed launch log');
    const end = text.lastIndexOf('\n') + 1; // A partial append is not yet a signal.
    const next = text.slice(consumed.length, end);
    for (const line of next.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as { phase?: string; duplicateLaunch?: boolean };
      if (entry.phase === 'starting') {
        if (running || exited) throw new Error('duplicate start signal');
        running = true; release = channel.activate(); acknowledge('starting');
      } else if (entry.phase === 'exited' || (entry.phase === 'refused' && !entry.duplicateLaunch)) {
        revoke(); exited = true; acknowledge('exited');
      }
    }
    consumed = text.slice(0, end);
  };
  const fail = () => {
    failures.push('Interactive launcher handshake failed'); revoke(); stopping = true;
    try { if (!existsSync(join(controlDir, 'host.closed'))) acknowledge('closed'); } catch { /* Network revocation already happened. */ }
  };
  const monitor = (async () => {
    while (!stopping) {
      try { poll(); } catch { fail(); }
      if (!stopping) await delay(10);
    }
  })();
  return {
    async close() {
      stopping = true;
      await monitor;
      // Never consume a pending start after shutdown has begun.
      revoke();
      try { if (!existsSync(join(controlDir, 'host.closed'))) acknowledge('closed'); }
      catch { failures.push('Interactive launcher shutdown acknowledgement failed'); }
    },
    evidence: () => ({ started: running, exited, failures: [...failures] }),
  };
}
