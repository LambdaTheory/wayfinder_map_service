import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Resolve once at build time; the installed service needs neither Git nor repository sources.
// A dirty tree includes untracked, non-ignored files. Hash their contents as well as the
// tracked diff so successive edits at the same HEAD cannot attest one another's rules.
export function buildReleaseVersion(root, version) {
  if (!releasePattern.test(version ?? '')) throw new Error('package.json needs a valid release SemVer');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const sha = git('rev-parse', '--verify', 'HEAD').trim();
    const status = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const tags = git('tag', '--points-at', 'HEAD').trim().split('\n');
    if (!status && tags.includes(`v${version}`)) return version;
    // Keep the existing tool schema's 32-character version bound. Require at least
    // 64 bits for a dirty fingerprint; an oversized future base fails closed.
    const width = 32 - version.length - '+dev.'.length;
    if (width < 17) throw new Error('Release base leaves too little room for a development identity');
    if (!status) return `${version}+dev.${sha.slice(0, width)}`;
    const digest = createHash('sha256').update(sha).update(status).update(git('diff', '--binary', 'HEAD', '--'));
    for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) {
      const absolute = join(root, path);
      digest.update(path).update('\0');
      digest.update(lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).update('\0');
    }
    return `${version}+dev.d${digest.digest('hex').slice(0, width - 1)}`;
  } catch {
    // Never fall back to a published number when provenance cannot be established.
    throw new Error('Release version build refused: cannot establish Git HEAD and worktree state');
  }
}
