// Trusted outer launcher. The operator's command pins the manifest before any launch data is read.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, lstatSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Writable } from 'node:stream';
import { IsolationError, verifyProfile } from '../runner/codex.ts';
import type { ControlProfile } from '../runner/codex.ts';
import { digest } from './reviews.ts';
import type { InteractiveClient } from './native.ts';

export interface LaunchManifest {
  client: InteractiveClient;
  bin: string;
  args: string[];
  workdir: string;
  env: Record<string, string>;
  profile: ControlProfile;
  codexLogin?: { source: string; copy: string };
}
export function readManifest(path: string, expected: string): LaunchManifest {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new IsolationError('launcher manifest is not a regular single-link file');
  const text = readFileSync(path, 'utf8');
  if (digest(text) !== expected) throw new IsolationError('launcher manifest changed');
  return JSON.parse(text) as LaunchManifest;
}

export async function launch(path: string, expected: string, inherited: NodeJS.ProcessEnv = process.env): Promise<number> {
  const record = (value: object) => appendFileSync(join(dirname(path), 'launch.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
  let launched = false; let duplicateLaunch = false;
  try {
    // Reserve before reading login bytes or spawning. A refusal consumes this Attempt too.
    try { writeFileSync(join(dirname(path), 'launch.once'), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      duplicateLaunch = true;
      throw new Error('Client launch already attempted; create a fresh Attempt');
    }
    const manifest = readManifest(path, expected);
    const failure = verifyProfile(manifest.profile);
    if (failure) throw new IsolationError(failure);
    if (manifest.codexLogin) {
      const { source, copy } = manifest.codexLogin;
      if (manifest.client !== 'codex' || !manifest.profile.mutableReadOnlyFiles.includes(copy))
        throw new IsolationError('login copy is outside the pinned mutable files');
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Subscription login must be a regular single-link file');
      // Preserve the pinned destination inode; do not parse, log or expose the original login path.
      copyFileSync(source, copy); chmodSync(copy, 0o600); utimesSync(copy, stat.atime, stat.mtime);
      const failure = verifyProfile(manifest.profile);
      if (failure) throw new IsolationError(failure);
    }
    // The operator supplies the setup-token result only to this trusted outer process. The client gets
    // a pipe descriptor, never token bytes in argv/environment or a copied keychain/login format.
    const oauth = manifest.client === 'claude' ? inherited.CLAUDE_CODE_OAUTH_TOKEN : undefined;
    if (manifest.client === 'claude' && !oauth) throw new Error('Kun must approve claude setup-token and supply its subscription token before launch');
    const env = { ...manifest.env, ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' } : {}) };
    const child = spawn('/usr/bin/sandbox-exec', ['-f', manifest.profile.path, manifest.bin, ...manifest.args], {
      cwd: manifest.workdir, env, stdio: oauth ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
    });
    const interrupt = () => { /* The foreground group delivers SIGINT to the interactive client too. */ };
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
        child.once('error', reject);
        child.once('spawn', () => {
          launched = true; record({ phase: 'started', launched: true });
          if (oauth) {
            const pipe = child.stdio[3] as Writable;
            pipe.on('error', () => { /* Early client exit closes its descriptor; the exit result remains authoritative. */ });
            pipe.end(oauth);
          }
        });
        child.once('exit', (code, signal) => accept({ code, signal }));
      });
      const failure = verifyProfile(manifest.profile);
      record({ phase: 'exited', launched, ...exit, ...(failure ? { isolationFailure: failure } : {}) });
      return failure ? 1 : exit.code ?? 1;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  } catch (error) {
    record({ phase: 'refused', launched, ...(duplicateLaunch ? { duplicateLaunch: true } : error instanceof IsolationError ? { isolationFailure: error.message } : { launchFailure: 'client launch failed' }) });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launch(process.argv[2]!, process.argv[3]!).then(code => { process.exitCode = code; }, error => { console.error(String(error)); process.exitCode = 1; });
}
