// B02a-style before/after observations, without reading auth files, service credentials or database contents.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Field } from '../evidence.ts';
import { reservedPorts } from '../runner/service.ts';

const unknown = (reason: string): Field<never> => ({ known: false, reason });
const known = <T>(value: T): Field<T> => ({ known: true, value });
export type ProcessQuery = (args: string[]) => Field<string>;
export const processQuery: ProcessQuery = args => {
  const result = spawnSync('lsof', args, { encoding: 'utf8' });
  return result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout && !result.stderr))
    ? unknown('lsof observation unavailable') : known(result.stdout);
};
export function openDatabases(pid: number, query: ProcessQuery = processQuery): Field<string[]> {
  const result = query(['-p', String(pid), '-Fn']);
  return result.known ? known(result.value.split('\n').filter(l => l.startsWith('n') && /\.sqlite$/.test(l)).map(l => l.slice(1))) : result;
}
export interface IsolationSnapshot {
  configs: Record<string, Field<{ exists: boolean; sha256: string | null; containsRunPath: boolean }>>;
  everyday: Field<{ port: number; pids: number[]; databases: { path: string; size: number; modified: number }[] }[]>;
}
export function isolationSnapshot(runPaths: string[], configRoot = homedir(), query: ProcessQuery = processQuery): IsolationSnapshot {
  const configs: IsolationSnapshot['configs'] = {};
  // Deliberately do not reuse runner.isolationSnapshot: it reads auth.json and private service credentials.
  for (const name of ['.codex/config.toml', '.claude/settings.json']) {
    try {
      const text = readFileSync(join(configRoot, name), 'utf8');
      configs[name] = known({ exists: true, sha256: createHash('sha256').update(text).digest('hex'), containsRunPath: runPaths.some(p => text.includes(p)) });
    } catch (error) {
      configs[name] = (error as NodeJS.ErrnoException).code === 'ENOENT' ? known({ exists: false, sha256: null, containsRunPath: false }) : unknown('configuration observation unavailable');
    }
  }
  const everyday: Extract<IsolationSnapshot['everyday'], { known: true }>['value'] = [];
  for (const port of reservedPorts) {
    const result = query(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (!result.known) return { configs, everyday: result };
    const pids = result.value.trim().split(/\s+/).filter(Boolean).map(Number);
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) return { configs, everyday: unknown('invalid listener PID observation') };
    const databases = [];
    for (const pid of pids) {
      const opened = openDatabases(pid, query);
      if (!opened.known) return { configs, everyday: opened };
      for (const path of opened.value) {
        try { const stat = statSync(path); databases.push({ path, size: stat.size, modified: stat.mtimeMs }); }
        catch { return { configs, everyday: unknown('database metadata observation unavailable') }; }
      }
    }
    everyday.push({ port, pids, databases });
  }
  return { configs, everyday: known(everyday) };
}
export function isolationMeasurements(before: IsolationSnapshot, after: IsolationSnapshot, opened: Field<string[]>, ownDatabase?: string) {
  const configsKnown = Object.keys(before.configs).length > 0 && Object.keys(after.configs).length > 0 && [...Object.values(before.configs), ...Object.values(after.configs)].every(v => v.known);
  const dailyPaths = before.everyday.known ? before.everyday.value.flatMap(s => s.databases.map(d => d.path)) : [];
  return { before, after,
    personalConfigurationUnchanged: configsKnown ? known(JSON.stringify(before.configs) === JSON.stringify(after.configs)) : unknown('one or more configuration snapshots unavailable'),
    runPathsInPersonalConfiguration: configsKnown ? known(Object.values(after.configs).some(v => v.known && v.value.containsRunPath)) : unknown('configuration snapshot unavailable'),
    everydaySnapshotUnchanged: before.everyday.known && after.everyday.known ? known(JSON.stringify(before.everyday) === JSON.stringify(after.everyday)) : unknown('everyday service snapshot unavailable'),
    servedOwnDatabase: opened.known && opened.value.length > 0 && ownDatabase ? known(opened.value.length === 1 && opened.value[0] === ownDatabase) : unknown('own service open database not observed'),
    touchedEverydayDatabase: opened.known && dailyPaths.length ? known(opened.value.some(p => dailyPaths.includes(p))) : unknown('could not compare open database paths'),
    everydayServiceUntouched: unknown('before/after metadata cannot prove absence of transient calls; no request is sent to the everyday service'),
    observationScope: 'Two metadata snapshots and own-service open files; no credential or database-content reads.' };
}
