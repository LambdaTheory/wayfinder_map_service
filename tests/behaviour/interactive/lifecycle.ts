// The existing protected launch log carries wrapper signals; acknowledgements live beside it.
// Neither file is readable/writable by the sandboxed client. No HTTP credential channel is added.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProxyChannel } from '../runner/proxy-channel.ts';

export type LaunchPhase = 'starting' | 'started' | 'exited' | 'verified' | 'refused';
export interface LaunchRecord {
  phase: LaunchPhase; at?: string; exitAtNs?: string; launched?: boolean;
  code?: number | null; signal?: string | null;
  duplicateLaunch?: boolean; isolationFailure?: string; launchFailure?: string;
}
export const hostSignalPath = (controlDir: string, phase: 'starting' | 'exited' | 'closed') => join(controlDir, `host.${phase}`);

export async function awaitHost(controlDir: string, phase: 'starting' | 'exited'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // Shutdown may acknowledge an already-recorded exit and close in the same host turn.
    if (phase === 'exited' && existsSync(hostSignalPath(controlDir, phase))) return;
    if (existsSync(hostSignalPath(controlDir, 'closed'))) throw new Error('Interactive host closed');
    if (existsSync(hostSignalPath(controlDir, phase))) return;
    await delay(10);
  }
  throw new Error('Interactive host acknowledgement timed out');
}

export function watchLauncher(controlDir: string, channel: ProxyChannel) {
  const log = join(controlDir, 'launch.jsonl');
  let consumed = ''; let running = false; let exited = false; let stopping = false;
  let release: (() => void) | undefined;
  const failures: string[] = [];
  const acknowledge = (phase: 'starting' | 'exited' | 'closed') => writeFileSync(hostSignalPath(controlDir, phase), '', { mode: 0o600, flag: 'wx' });
  const revoke = () => { release?.(); release = undefined; };
  const poll = (allowStart = true) => {
    if (!existsSync(log)) return;
    const text = readFileSync(log, 'utf8');
    if (!text.startsWith(consumed)) throw new Error('changed launch log');
    const end = text.lastIndexOf('\n') + 1; // A partial append is not yet a signal.
    const next = text.slice(consumed.length, end);
    for (const line of next.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as LaunchRecord;
      if (entry.phase === 'starting') {
        if (running || exited) throw new Error('duplicate start signal');
        if (allowStart) { running = true; release = channel.activate(); acknowledge('starting'); }
      } else if (entry.phase === 'exited' || (entry.phase === 'refused' && !entry.duplicateLaunch)) {
        revoke();
        if (entry.phase === 'exited') {
          if (exited) throw new Error('duplicate exit signal');
          if (!entry.exitAtNs || !/^\d{1,30}$/.test(entry.exitAtNs)) throw new Error('missing client exit time');
          channel.revokeAt(BigInt(entry.exitAtNs));
        }
        if (!exited) { exited = true; acknowledge('exited'); }
      }
    }
    consumed = text.slice(0, end);
  };
  const fail = () => {
    failures.push('Interactive launcher handshake failed'); revoke(); stopping = true;
    try { if (!existsSync(hostSignalPath(controlDir, 'closed'))) acknowledge('closed'); } catch { /* Network revocation already happened. */ }
  };
  const check = () => { if (!stopping) try { poll(); } catch { fail(); } };
  const monitor = (async () => {
    while (!stopping) {
      check();
      if (!stopping) await delay(10);
    }
  })();
  return {
    check,
    async close() {
      stopping = true;
      revoke();
      // Collect a just-written exit, including its original time, but never activate a pending start.
      if (!failures.length) try { poll(false); } catch { fail(); }
      try { if (!existsSync(hostSignalPath(controlDir, 'closed'))) acknowledge('closed'); }
      catch { failures.push('Interactive launcher shutdown acknowledgement failed'); }
      await monitor;
    },
    evidence: () => ({ started: running, exited, failures: [...failures] }),
  };
}
