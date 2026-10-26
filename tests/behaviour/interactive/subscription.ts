// Only an approved host run uses the real home. Tests must supply an explicit synthetic home.
import { chmodSync, constants, copyFileSync, lstatSync, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;

/** Match the dedicated launcher's precedence, retaining only its six proxy variables. */
export function claudeProxyEnvironment(subscriptionHome: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  let settings: { env?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(readFileSync(join(subscriptionHome, '.claude/settings.json'), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)))) {
      throw new Error('Invalid settings shape');
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Claude proxy settings unavailable; refusing to fall back to a direct connection');
  }
  const selected: Record<string, string> = {};
  for (const key of proxyVariables) {
    const value = inherited[key] ?? settings.env?.[key];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error('Claude proxy setting must be a string');
      selected[key] = value;
    }
  }
  return selected;
}

export interface LoginSync { status: 'missing' | 'linked' | 'daily-newer' | 'synced'; backup?: string }
/** A refresh replaces the symlink. Preserve newer bytes with a backup, without parsing or printing them. */
export function syncCodexLogin(scratch: string, subscriptionHome: string): LoginSync {
  const own = join(scratch, 'home/.codex/auth.json');
  let ownStat;
  try { ownStat = lstatSync(own); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }; throw error; }
  if (ownStat.isSymbolicLink()) return { status: 'linked' };
  if (!ownStat.isFile()) throw new Error('Unexpected refreshed login type; preserve scratch for the coordinator');
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
