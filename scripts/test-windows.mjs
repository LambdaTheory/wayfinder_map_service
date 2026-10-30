// The POSIX dedicated-agent/behaviour harness is outside this Windows slice.
// Run core + real adapters in a newly private scratch root, never the OS-wide
// Temp directory (which can be writable by other local groups).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { makePrivateDirectory } from '../dist/private-paths.js';
if (process.platform !== 'win32') throw Error('Windows test entry point required');
const root = join(homedir(), '.wayfinder-windows-tests', randomUUID());
makePrivateDirectory(root);
const files = ['create-map', 'claims', 'atomic-revisions', 'tickets-frontier', 'frontier-enumeration', 'settlements', 'map-content',
  'mcp-tools', 'mcp-response', 'viewer-projection', 'workflow-build', 'release', 'release-build', 'sqlite-storage', 'answer-desk', 'map-wait', 'windows-security'];
const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...files.map(name => `tests/${name}.test.ts`),
  '--maxWorkers=2', '--testTimeout=60000'], { env: { ...process.env, TEMP: root, TMP: root }, stdio: 'inherit', windowsHide: true });
try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
finally {
  if (!root.startsWith(join(homedir(), '.wayfinder-windows-tests') + '\\')) throw Error('Unsafe cleanup');
  rmSync(root, { recursive: true, force: true });
}
