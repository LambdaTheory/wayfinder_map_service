// A service-only integration test: the client launcher is never invoked and no personal configuration is read.
import { host } from '../../interactive/host.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const subscriptionHome = mkdtempSync('/private/tmp/wayfinder-fake-login-');
const mode = process.env.B09_SYNTHETIC_REFRESH;
if (mode === 'no-open-files') {
  const bin = join(subscriptionHome, 'bin'); mkdirSync(bin);
  // lsof exits 1 with no output when no matching files can be reported. Never consult daily files.
  writeFileSync(join(bin, 'lsof'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}
const daily = join(subscriptionHome, '.codex/auth.json');
mkdirSync(join(subscriptionHome, '.codex'));
writeFileSync(daily, 'synthetic-old-login'); utimesSync(daily, 1, 1);
let observed = 0;
try {
  await host(process.argv.slice(2), { subscriptionHome,
    inheritedEnv: mode === 'claude-proxy' ? { NO_PROXY: '127.0.0.1', no_proxy: 'localhost', HTTPS_PROXY: 'http://synthetic-user:synthetic-password@proxy.invalid' } : {},
    observe: paths => {
      ++observed;
      if (observed === 1 && mode === 'claude-proxy') {
        const native = join(paths[1], 'home/.claude/projects'); mkdirSync(native, { recursive: true });
        writeFileSync(join(native, 'synthetic.jsonl'), JSON.stringify({ text: 'http://127.0.0.1:23456/mcp http://localhost:23456/mcp http://synthetic-user:synthetic-password@proxy.invalid' }));
      }
      if (observed === 2 && ['refresh', 'failure', 'cancel'].includes(mode)) {
        const own = join(paths[1], 'home/.codex/auth.json');
        unlinkSync(own); writeFileSync(own, 'synthetic-refreshed-login'); utimesSync(own, 2, 2);
        if (mode === 'failure') unlinkSync(daily);
      }
      return { configs: {}, everyday: { known: false, reason: 'synthetic observer has no daily service access' } };
    } });
  if (mode === 'refresh' && readFileSync(daily, 'utf8') !== 'synthetic-refreshed-login') throw new Error('Synthetic refresh was lost');
} finally { rmSync(subscriptionHome, { recursive: true, force: true }); }
