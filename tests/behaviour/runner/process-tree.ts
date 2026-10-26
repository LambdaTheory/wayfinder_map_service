// macOS turn ownership: group termination is supplemented by observed descendants and owned scratch cwd.
// This is not an OS job container; see shared-sandbox-proxy.md for the hostile double-fork limit.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

interface ProcessIdentity { pid: number; parent: number; start: string; state: string }
function snapshot(): ProcessIdentity[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,state=,lstart='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), state: m[3]!, start: m[4]!.trim() }] : [];
  });
}

export function trackClientTree(rootPid: number, directories: string[], sweepCwd = false) {
  const roots = [...new Set(directories.map(path => realpathSync(path)))];
  const owned = new Map<number, string>(); let failed = false; let seed = true;
  const collect = (cwd: boolean) => {
    const rows = snapshot();
    if (seed) { seed = false; const root = rows.find(row => row.pid === rootPid); if (root) owned.set(root.pid, root.start); }
    const cwdPids = new Set<number>();
    if (cwd) for (const root of roots) {
      const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-d', 'cwd', '-Fpn', '+D', root], { encoding: 'utf8', timeout: 3000 });
      if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr.trim()) throw new Error('owned process scan failed');
      let pid = 0;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        if (line.startsWith('n') && (line.slice(1) === root || line.slice(1).startsWith(root + '/'))) cwdPids.add(pid);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const parent = rows.find(p => p.pid === row.parent);
        if (row.pid !== process.pid && (cwdPids.has(row.pid) || (parent && owned.get(parent.pid) === parent.start)) && owned.get(row.pid) !== row.start) {
          owned.set(row.pid, row.start); changed = true;
        }
      }
    }
    return rows.filter(row => owned.get(row.pid) === row.start && !row.state.startsWith('Z'));
  };
  const signal = (row: ProcessIdentity, name: NodeJS.Signals) => {
    // Recheck identity immediately before a signal. Never act on a recycled PID or unrelated cwd.
    const current = spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 });
    if (current.status === 1) return;
    if (current.error || current.status !== 0) throw new Error('owned process identity check failed');
    if (current.stdout.trim() !== row.start) return;
    try { process.kill(row.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  try { collect(false); } catch { failed = true; }
  const timer = setInterval(() => { try { collect(false); } catch { failed = true; } }, 100);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    const frozen = new Map<number, ProcessIdentity>();
    let incomplete = false;
    try {
      // Freeze before killing so the observed tree cannot keep forking while it is being drained.
      for (let round = 0; round < 5; round++) {
        const fresh = collect(sweepCwd).filter(row => frozen.get(row.pid)?.start !== row.start);
        if (!fresh.length) break;
        for (const row of fresh) { frozen.set(row.pid, row); signal(row, 'SIGSTOP'); }
      }
    } catch { incomplete = true; }
    finally { for (const row of frozen.values()) try { signal(row, 'SIGKILL'); } catch { incomplete = true; } }
    if (incomplete) throw new Error('owned process scan or termination failed');
  };
  let pending: Promise<void> | undefined;
  return {
    emergencyStop() { try { stop(); } catch { /* exit hook cannot publish a successful Attempt */ } },
    terminate(): Promise<void> {
      return pending ??= (async () => {
        try {
          stop();
          const deadline = Date.now() + 3000;
          while (collect(false).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
          if (collect(sweepCwd).length || failed) throw new Error('owned client process cleanup failed');
        } finally { clearInterval(timer); }
      })();
    },
  };
}

/** The shared workdir belongs to the Attempt: sweep it only after all concurrent turns have stopped. */
export const clearClientDirectories = (directories: string[]) => trackClientTree(0, directories, true).terminate();
