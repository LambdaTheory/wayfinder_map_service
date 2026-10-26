// Synthetic inputs only; no fs monkey-patching or import-order-dependent security claim.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function syntheticClientState(root: string) {
  const personalConfigRoot = join(root, 'synthetic-personal-home');
  const loginSource = { contents: JSON.stringify({ OPENAI_API_KEY: 'synthetic-login-for-tests-only' }) };
  mkdirSync(join(personalConfigRoot, '.codex'), { recursive: true });
  writeFileSync(join(personalConfigRoot, '.codex/auth.json'), loginSource.contents);
  writeFileSync(join(personalConfigRoot, '.codex/config.toml'), '# synthetic personal configuration\n');
  return { loginSource, personalConfigRoot };
}
