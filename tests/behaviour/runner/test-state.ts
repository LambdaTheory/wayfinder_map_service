// Every fake-driver test uses this synthetic state. A filesystem tripwire fails even if a runner catches
// the access error, so accidental reads/copies of everyday credentials cannot silently pass npm test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';

const accesses = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const { homedir } = await import('node:os');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const forbidden = ['.codex', '.claude', '.codex-wayfinder', '.wayfinder-service'].map(p => resolve(homedir(), p));
  const guard = (path: unknown) => {
    const p = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    if (forbidden.some(root => p === root || p.startsWith(root + '/'))) {
      accesses.push(p);
      throw new Error('test attempted to access real personal configuration or credentials');
    }
  };
  return { ...fs,
    existsSync: (...args: Parameters<typeof fs.existsSync>) => { guard(args[0]); return fs.existsSync(...args); },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => { guard(args[0]); return fs.readFileSync(...args); },
    openSync: (...args: Parameters<typeof fs.openSync>) => { guard(args[0]); return fs.openSync(...args); },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { guard(args[0]); return fs.writeFileSync(...args); },
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => { guard(args[0]); guard(args[1]); return fs.copyFileSync(...args); },
  };
});
afterEach(() => { const attempted = accesses.splice(0); expect(attempted, 'tests must never touch real personal state').toEqual([]); });

export function syntheticClientState(root: string) {
  const personalConfigRoot = join(root, 'synthetic-personal-home');
  const loginSource = join(personalConfigRoot, '.codex/auth.json');
  mkdirSync(join(personalConfigRoot, '.codex'), { recursive: true });
  writeFileSync(loginSource, JSON.stringify({ OPENAI_API_KEY: 'synthetic-login-for-tests-only' }));
  writeFileSync(join(personalConfigRoot, '.codex/config.toml'), '# synthetic personal configuration\n');
  return { loginSource, personalConfigRoot };
}
