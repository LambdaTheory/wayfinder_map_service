// Only an approved host run uses the real home. Tests must supply an explicit synthetic home.
import { chmodSync, constants, copyFileSync, lstatSync, realpathSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface LoginSync { status: 'missing' | 'linked' | 'daily-newer' | 'synced'; backup?: string }
/** A refresh replaces the symlink. Preserve newer bytes with a backup, without parsing or printing them. */
export function syncCodexLogin(scratch: string, subscriptionHome: string): LoginSync {
  const directory = join(scratch, 'home/.codex');
  let directoryStat;
  try { directoryStat = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }; throw error; }
  if (!directoryStat.isDirectory() || realpathSync(directory) !== join(realpathSync(scratch), 'home/.codex'))
    throw new Error('Unexpected client login directory; preserve scratch for the coordinator');
  const own = join(scratch, 'home/.codex/auth.json');
  let ownStat;
  try { ownStat = lstatSync(own); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }; throw error; }
  if (ownStat.isSymbolicLink()) return { status: 'linked' };
  if (!ownStat.isFile() || ownStat.nlink !== 1) throw new Error('Unexpected refreshed login type; preserve scratch for the coordinator');
  const daily = join(subscriptionHome, '.codex/auth.json');
  const previous = lstatSync(daily);
  if (!previous.isFile()) throw new Error('Unexpected daily login type; preserve scratch for the coordinator');
  if (ownStat.mtimeMs <= previous.mtimeMs) return { status: 'daily-newer' };
  const suffix = `${Date.now()}-${randomUUID()}`;
  const backup = `${daily}.bak-${suffix}`; const replacement = `${daily}.tmp-${suffix}`;
  try {
    copyFileSync(daily, backup, constants.COPYFILE_EXCL); chmodSync(backup, 0o600);
    utimesSync(backup, previous.atime, previous.mtime);
    copyFileSync(own, replacement, constants.COPYFILE_EXCL); chmodSync(replacement, 0o600);
    utimesSync(replacement, ownStat.atime, ownStat.mtime);
    const current = lstatSync(daily);
    if (!current.isFile() || current.ino !== previous.ino || current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
      throw new Error('Daily login changed during synchronization; preserve scratch for the coordinator');
    }
    renameSync(replacement, daily);
    return { status: 'synced', backup };
  } finally { rmSync(replacement, { force: true }); }
}
