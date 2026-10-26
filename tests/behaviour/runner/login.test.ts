// Import the runner before any fixture helper: login isolation must not depend on module order or fs mocks.
import { prepareSandbox, prepareSession, writeProfile } from './codex.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test.skipIf(spawnSync('which', ['sandbox-exec']).status !== 0)('login injection writes supplied bytes and the client cannot read the synthetic source HOME', () => {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-behave-login-'));
  const source = join(root, 'personal'); mkdirSync(source);
  const secret = join(source, 'auth.json'); writeFileSync(secret, 'synthetic-source-secret');
  const scratch = join(root, 'attempt'); mkdirSync(scratch);
  try {
    const contents = '{"OPENAI_API_KEY":"synthetic-injected-only"}';
    const session = prepareSession(scratch, 'A', 'synthetic', { contents });
    expect(readFileSync(join(session.codexHome, 'auth.json'), 'utf8')).toBe(contents);
    const { controlDir } = prepareSandbox(scratch);
    const work = join(scratch, 'work'); mkdirSync(work);
    const profile = writeProfile(controlDir, session, work, '/bin/sh');
    const attack = spawnSync('sandbox-exec', ['-f', profile.path, '/bin/cat', secret], { encoding: 'utf8' });
    expect(attack.status).not.toBe(0);
    expect(attack.stdout).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
