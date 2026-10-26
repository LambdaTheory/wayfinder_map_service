// Deny-only paths may precede their creation; no read capability follows from a denial.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { prepareSandbox, verifyProfile, writeProfile } from './sandbox.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const attack = test.skipIf(!existsSync('/usr/bin/sandbox-exec'));
attack.each(['root', 'path'] as const)('canonicalizes a missing deny-only %s through an existing symlink', kind => {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-deny-only-')); dirs.push(root);
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  const home = join(scratch, 'home'); mkdirSync(home);
  const work = join(scratch, 'work'); mkdirSync(work);
  const alias = join(work, 'alias'); symlinkSync(home, alias);
  const denied = join(alias, 'future', 'locked');
  const layout = prepareSandbox(scratch);
  const profile = writeProfile(layout.controlDir, { home }, work, '/bin/sh',
    kind === 'root' ? { denyWriteRoots: [denied] } : { denyWritePaths: [denied] });
  // Trusted setup creates a path after policy preparation, as the Dedicated launcher does.
  const actual = join(home, 'future', 'locked'); mkdirSync(join(home, 'future'));
  const shell = (command: string) => spawnSync('/usr/bin/sandbox-exec', ['-f', profile.path, '/bin/sh', '-c', command], { encoding: 'utf8' });
  const deniedCommand = (command: string) => {
    const result = shell(command); expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/Operation not permitted|Permission denied/);
  };
  // On case-insensitive filesystems the target's alternate spelling is denied before creation too.
  const caseInsensitive = existsSync(join(scratch, 'HOME'));
  if (caseInsensitive) deniedCommand(kind === 'root' ? `mkdir '${join(home, 'future', 'LOCKED')}'` : `echo forged > '${join(home, 'future', 'LOCKED')}'`);
  if (kind === 'root') mkdirSync(actual); else writeFileSync(actual, 'original');
  expect(verifyProfile(profile)).toBeNull();
  const target = kind === 'root' ? join(actual, 'child') : actual;
  const inner = join(home, 'inner'); mkdirSync(inner);
  const deeperAlias = join(work, 'deeper-alias'); symlinkSync(inner, deeperAlias);
  const spellings = [target, kind === 'root' ? join(denied, 'child') : denied,
    `${inner}/../future/locked${kind === 'root' ? '/child' : ''}`,
    `${deeperAlias}/../future/locked${kind === 'root' ? '/child' : ''}`,
    ...(caseInsensitive ? [target.replace('/locked', '/LOCKED')] : [])];
  for (const path of spellings) deniedCommand(`echo forged > '${path}'`);
  const protectedFile = kind === 'root' ? join(actual, 'protected-file') : actual;
  if (kind === 'root') writeFileSync(protectedFile, 'trusted');
  deniedCommand(`ln '${protectedFile}' '${join(work, 'writable-hardlink')}'`);
  expect(existsSync(join(work, 'writable-hardlink'))).toBe(false);
  expect(verifyProfile(profile)).toBeNull();
  const sibling = spawnSync('/usr/bin/sandbox-exec', ['-f', profile.path, '/bin/sh', '-c', `echo allowed > '${join(home, 'sibling')}'`]);
  expect(sibling.status).toBe(0);
});
