// Real host and sandbox launcher with a synthetic client and explicit synthetic subscription state.
import { spawnSync } from 'node:child_process';
import { host } from '../../interactive/host.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
const driver = join(subscriptionHome, 'fake-client.mjs');
writeFileSync(driver, `#!${process.execPath}\n${mode === 'exit-nonzero' ? 'process.exit(7);' : mode === 'exit-signal' ? "process.kill(process.pid, 'SIGTERM');" : ''}\n`, { mode: 0o700 });
let observed = 0;
let scratch;
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = (text, ...args) => {
  if (mode === 'claude-proxy' && String(text).includes('Client command')) {
    const native = join(scratch, 'home/.claude/projects'); mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'synthetic.jsonl'), JSON.stringify({ text: 'http://127.0.0.1:23456/mcp http://localhost:23456/mcp http://synthetic-user:synthetic-password@proxy.invalid' }));
  }
  if (mode === 'native-link' && String(text).includes('Client command')) {
    const privateLogs = join(subscriptionHome, 'private-logs'); mkdirSync(privateLogs);
    writeFileSync(join(privateLogs, 'secret.jsonl'), 'synthetic-private-native-marker');
    symlinkSync(privateLogs, join(scratch, 'home/.codex/sessions'));
  }
  if (!mode?.startsWith('no-start') && String(text).includes('Client command')) {
    const command = String(text).match(/Client command \(approved Batch only\): ([^\n]+)/)[1];
    const launched = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, ...(mode === 'claude-proxy' ? { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' } : {}) } });
    if (mode === 'repeat-launch') spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } });
    if (!['exit-nonzero', 'exit-signal', 'launch-failure'].includes(mode) && launched.status !== 0)
      throw new Error('Synthetic launcher failed: ' + launched.stderr);
  }
  return output(text, ...args);
};
try {
  await host([...process.argv.slice(2, -1), driver], { subscriptionHome,
    inheritedEnv: mode === 'claude-proxy' ? { NO_PROXY: '127.0.0.1', no_proxy: 'localhost', HTTPS_PROXY: 'http://synthetic-user:synthetic-password@proxy.invalid' } : {},
    observe: paths => {
      ++observed;
      if (observed === 1) scratch = paths[1];
      if (observed === 2 && ['exit-without-start', 'missing-exit'].includes(mode)) {
        const log = join(paths[2], 'launch.jsonl');
        const rows = readFileSync(log, 'utf8').trim().split('\n').filter(line => JSON.parse(line).phase !== (mode === 'missing-exit' ? 'exited' : 'started'));
        writeFileSync(log, rows.join('\n') + '\n');
      }
      if (observed === 2 && mode === 'duplicate-start') {
        const log = join(paths[2], 'launch.jsonl'); const text = readFileSync(log, 'utf8');
        writeFileSync(log, text + text.split('\n')[0] + '\n');
      }
      if (observed === 2 && mode === 'control-tamper') writeFileSync(join(paths[2], 'launch.json'), 'forged');
      if (observed === 2 && ['refresh', 'failure', 'cancel'].includes(mode)) {
        const own = join(paths[1], 'home/.codex/auth.json');
        unlinkSync(own); writeFileSync(own, 'synthetic-refreshed-login'); utimesSync(own, 2, 2);
        if (mode === 'failure') unlinkSync(daily);
      }
      return { configs: {}, everyday: { known: false, reason: 'synthetic observer has no daily service access' } };
    } });
  if (mode === 'refresh' && readFileSync(daily, 'utf8') !== 'synthetic-refreshed-login') throw new Error('Synthetic refresh was lost');
} finally { rmSync(subscriptionHome, { recursive: true, force: true }); }
