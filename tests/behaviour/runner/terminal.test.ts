// Real terminal boundary tests; all shells, ptys and files belong to these fixtures.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { prepareSandbox, writeProfile } from './sandbox.ts';
import { launcher } from '../interactive/host.ts';

const available = existsSync('/usr/bin/sandbox-exec');
const attack = test.skipIf(!available);
const nativeAttack = test.skipIf(!available || spawnSync('/usr/bin/xcode-select', ['-p']).status !== 0);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-terminal-')); dirs.push(root);
  const scratch = join(root, 'scratch'); mkdirSync(scratch);
  const home = join(scratch, 'home'); mkdirSync(home);
  const work = join(scratch, 'work'); mkdirSync(work);
  const layout = prepareSandbox(scratch);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
  return { root, home, work, env, ...layout };
}
function compile(source: string, output: string) {
  const compiled = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', fileURLToPath(new URL(source, import.meta.url)), '-o', output], { encoding: 'utf8' });
  expect(compiled.status, compiled.stderr).toBe(0);
}

attack.each([
  { command: 'echo hi > /dev/stderr', stdout: '', stderr: 'hi\n' },
  { command: 'echo hi > /dev/stdout', stdout: 'hi\n', stderr: '' },
  { command: 'echo hi > /dev/fd/1', stdout: 'hi\n', stderr: '' },
  { command: 'tee /dev/stderr', stdout: 'hi\n', stderr: 'hi\n' },
  { command: 'cat /dev/stdin', stdout: 'hi\n', stderr: '' },
  { command: 'cat <(echo hi)', stdout: 'hi\n', stderr: '' },
])('descriptor aliases work: $command', ({ command, stdout, stderr }) => {
  const f = fixture(); const profile = writeProfile(f.controlDir, f, f.work, '/bin/bash');
  for (const sandboxed of [false, true]) {
    const args = ['/bin/bash', '--noprofile', '--norc', '-c', command];
    const result = spawnSync(sandboxed ? '/usr/bin/sandbox-exec' : args.shift()!, sandboxed ? ['-f', profile.path, ...args] : args,
      { cwd: f.work, env: f.env, input: 'hi\n', encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(stdout); expect(result.stderr).toBe(stderr);
  }
});

nativeAttack.each(['stdin', 'tty'])('TIOCSTI through %s cannot inject a command into the outside operator shell', mode => {
  const root = realpathSync(mkdtempSync('/private/tmp/wf-injection-')); dirs.push(root);
  const scratch = join(root, 'attempt'); mkdirSync(scratch);
  const subscriptionHome = join(root, 'subscription'); mkdirSync(join(subscriptionHome, '.codex'), { recursive: true });
  writeFileSync(join(subscriptionHome, '.codex/auth.json'), 'synthetic-login');
  const driver = join(root, 'fake-client'); compile('./terminal-injection-probe.c', driver);
  const prepared = launcher({ scratch, client: 'codex', bin: driver, port: 23456, model: 'fake', effort: 'low', subscriptionHome });
  const work = join(scratch, 'work'); const marker = join(root, 'escaped-marker');
  writeFileSync(join(work, 'injection-input'), `${marker}\n${mode}\n`);
  // Bash is outside Seatbelt and consumes queued input only after launch.ts exits. No user input is inherited.
  const command = `${prepared.command}; status=$?; if IFS= read -r -t 1 injected; then eval "$injected"; fi; exit "$status"`;
  const result = spawnSync(driver, ['--operator', command], { cwd: work, env: { PATH: process.env.PATH, HOME: scratch }, encoding: 'utf8', timeout: 12000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(work, 'injection-result.json'), 'utf8')).directError).toBe(1);
  expect(existsSync(marker), 'the operator shell executed the injected command outside Seatbelt').toBe(false);
  expect(JSON.parse(readFileSync(join(work, 'injection-result.json'), 'utf8'))).toEqual({ directError: 1, accepted: 0, injectionError: 1 });
});

nativeAttack('openpty works only for terminals owned by this sandbox instance', async () => {
  const f = fixture(); const driverDir = join(f.readOnlyDir, 'client'); mkdirSync(driverDir);
  const driver = join(driverDir, 'pty-probe'); compile('./pty-scope-probe.c', driver);
  const profile = writeProfile(f.controlDir, f, f.work, driver);
  const inspect = (peers: string[]) => {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile.path, driver, ...peers], { cwd: f.work, env: f.env, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ opened: 1, reopened: 1, readable: 1, writable: 1, peers: peers.map(() => ({ readError: 1, writeError: 1 })) });
  };
  inspect([]);
  const peerHome = join(f.scratch, 'peer-home'); mkdirSync(peerHome);
  const peerProfile = writeProfile(f.controlDir, { home: peerHome }, f.work, driver);
  const holders: ReturnType<typeof spawn>[] = [];
  try {
    const peers: string[] = [];
    for (const path of [null, profile.path, peerProfile.path]) {
      const holder = spawn(path ? '/usr/bin/sandbox-exec' : driver, path ? ['-f', path, driver, '--hold'] : ['--hold'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      holders.push(holder);
      const name = await new Promise<string>((resolve, reject) => {
        let text = ''; const timer = setTimeout(() => reject(new Error('pty holder did not report readiness')), 5000);
        holder.once('error', reject); holder.once('exit', () => { clearTimeout(timer); reject(new Error('pty holder exited')); });
        holder.stdout!.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(text.trim()); } });
      });
      expect(name).toMatch(/^\/dev\/ttys[0-9]+$/); peers.push(name);
    }
    inspect(peers);
  } finally {
    await Promise.all(holders.map(holder => new Promise<void>(resolve => { if (holder.exitCode !== null || holder.signalCode !== null) return resolve(); holder.once('exit', () => resolve()); holder.stdin!.end(); })));
  }
});

nativeAttack('script can run a tool in a newly allocated pty', () => {
  const f = fixture(); const profile = writeProfile(f.controlDir, f, f.work, '/usr/bin/script');
  const harness = join(f.root, 'operator'); compile('./terminal-injection-probe.c', harness);
  for (const prefix of ['', `/usr/bin/sandbox-exec -f '${profile.path}' `]) {
    const command = `${prefix}/usr/bin/script -q /dev/null /bin/echo synthetic-pty-output`;
    const result = spawnSync(harness, ['--operator', command], { cwd: f.work, env: f.env, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr + result.stdout).toBe(0); expect(result.stdout).toContain('synthetic-pty-output');
  }
});
