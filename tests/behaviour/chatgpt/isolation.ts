// lsof observations never connect to the daily service or open its database/configuration.
import { spawnSync } from 'node:child_process';
import type { Field } from '../evidence.ts';
import { everydayPort, reservedPorts } from '../runner/service.ts';

export type Inventory = (...args: string[]) => Field<string>;
const unknown = (reason: string) => ({ known: false as const, reason });
export const lsof: Inventory = (...args) => {
  const r = spawnSync('lsof', args, { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.signal || (r.status !== 0 && !(r.status === 1 && !r.stdout && !r.stderr))) return unknown('lsof unavailable, failed or timed out');
  return { known: true, value: r.stdout };
};
export function everydayListener(inventory: Inventory = lsof): Field<string[]> {
  const r = inventory('-nP', `-iTCP:${everydayPort}`, '-sTCP:LISTEN', '-t');
  return r.known ? { known: true, value: [...new Set(r.value.trim().split(/\s+/).filter(Boolean))].sort() } : r;
}
export function unchangedListener(before: Field<string[]>, after: Field<string[]>): Field<boolean> {
  return before.known && after.known ? { known: true, value: JSON.stringify(before.value) === JSON.stringify(after.value) }
    : unknown('daily listener inventory unavailable before or after the run');
}
export function observeIsolation(databasePath: string, servicePort: number, relayPort: number, inventory: Inventory = lsof) {
  const files = inventory('-nP', '-p', String(process.pid), '-Fn');
  const sockets = inventory('-nP', '-a', '-p', String(process.pid), '-iTCP', '-Fn');
  const listeners = inventory('-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-Fn');
  const dbs: Field<string[]> = files.known ? { known: true, value: [...new Set(files.value.split('\n').filter(l => /^n.*\.sqlite$/.test(l)).map(l => l.slice(1)))] } : files;
  const ports: Field<number[]> = listeners.known ? { known: true, value: listeners.value.split('\n').filter(l => l.startsWith('n')).flatMap(l => {
    const match = /:(\d+)$/.exec(l); return match ? [Number(match[1])] : [];
  }) } : listeners;
  return { measuredAt: new Date().toISOString(), processId: process.pid, databasePath, servicePort, relayPort,
    openedDatabases: dbs, listenerPorts: ports,
    servedOnlyOwnDatabase: dbs.known ? { known: true, value: dbs.value.length === 1 && dbs.value[0] === databasePath } : dbs,
    listeningOnlyOnOwnPorts: ports.known ? { known: true, value: ports.value.includes(servicePort) && ports.value.includes(relayPort)
      && ports.value.every(p => p === servicePort || p === relayPort) } : ports,
    avoidedEverydayPorts: sockets.known ? { known: true, value: reservedPorts.every(p => !new RegExp(`:${p}\\b`).test(sockets.value)) } : sockets };
}
