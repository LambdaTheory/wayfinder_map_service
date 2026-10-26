import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { cacheRoot } from './host.ts';

const attack = test.skipIf(process.platform !== 'darwin');
attack.each(['codex', 'claude'].flatMap(client => ['clean', 'before', 'detached', 'immediate', 'delayed', 'delayed-signal', 'ambient', 'early'].map(mode => ({ client, mode }))))(
  '$client interactive proxy lifecycle: $mode', async ({ client, mode }) => {
    const attempt = `proxy-${client}-${mode}-${process.pid}-${Date.now()}`;
    const dir = join(cacheRoot(), `B118-${attempt}`);
    try {
      const child = spawn(process.execPath, [...(mode === 'ambient' ? ['--use-env-proxy'] : []),
        fileURLToPath(new URL('../fixtures/interactive/proxy-host.mjs', import.meta.url)), attempt, mode, client], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        let output = ''; let answered = false;
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(output)); }, 20_000);
        child.stdout.on('data', data => {
          output += data;
          if (!answered && output.includes('Client exited; enter')) { answered = true; child.stdin.write('complete\n'); }
        });
        child.stderr.on('data', data => { output += data; });
        child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
      });
      expect(result.code, result.output).toBe(0);
      const capture = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
      const isolation = JSON.parse(readFileSync(join(dir, 'isolation.json'), 'utf8'));
      const channel = JSON.parse(readFileSync(join(dir, 'raw/proxy-channel.json'), 'utf8'));
      const proof = JSON.parse(readFileSync(join(dir, 'proof.json'), 'utf8'));
      const leftover = ['before', 'detached', 'immediate', 'delayed', 'delayed-signal', 'early'].includes(mode);
      expect(capture.run.completeness).toBe(leftover || mode === 'early' ? 'driver-failed' : 'complete');
      expect(channel).toMatchObject({ enabled: true, closed: true });
      if (leftover) expect(channel.blockedConnections + (channel.postExitConnections ?? 0)).toBeGreaterThan(0);
      else expect(channel.blockedConnections).toBe(0);
      expect(isolation).toMatchObject({ proxyChannel: channel, launcherHandshake: { started: true, exited: mode !== 'early', failures: [] },
        scratchRemoved: mode !== 'early', controlDirectoryRemoved: mode !== 'early', credentialsRemoved: true });
      expect(proof).toMatchObject({ ...(mode === 'early' ? {} : { afterWrapper: proof.final }), afterHost: proof.final, authenticated: 0 });
      if (['detached', 'immediate', 'delayed', 'delayed-signal'].includes(mode)) expect(proof.childResult).toMatchObject({ direct: 'EPERM' });
      if (mode === 'delayed') expect(proof.childResult.outcome).not.toBe('forwarded');
      if (mode === 'delayed-signal') {
        expect(channel).toMatchObject({ blockedConnections: 0, postExitConnections: 1 });
        expect(proof.childResult.outcome).toBe('forwarded');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 25_000,
);
