// A service-only integration test: the client launcher is never invoked and no personal configuration is read.
import { host } from '../../interactive/host.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const subscriptionHome = mkdtempSync('/private/tmp/wayfinder-fake-login-');
const mode = process.env.B09_SYNTHETIC_REFRESH;
const daily = join(subscriptionHome, '.codex/auth.json');
mkdirSync(join(subscriptionHome, '.codex'));
writeFileSync(daily, 'synthetic-old-login'); utimesSync(daily, 1, 1);
let observed = 0;
try {
  await host(process.argv.slice(2), { subscriptionHome,
    observe: paths => {
      if (++observed === 2 && mode) {
        const own = join(paths[1], 'home/.codex/auth.json');
        unlinkSync(own); writeFileSync(own, 'synthetic-refreshed-login'); utimesSync(own, 2, 2);
        if (mode === 'failure') unlinkSync(daily);
      }
      return { configs: {}, everyday: { known: false, reason: 'synthetic observer has no daily service access' } };
    } });
  if (mode === 'refresh' && readFileSync(daily, 'utf8') !== 'synthetic-refreshed-login') throw new Error('Synthetic refresh was lost');
} finally { rmSync(subscriptionHome, { recursive: true, force: true }); }
