// Manual regression check for independent gate runs in the same checkout. Build first; fake tunnels only.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.version !== 'v26.3.0') throw new Error('Node 26.3.0 is required');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
if (process.argv.slice(2).some(arg => arg !== '--full')) throw new Error('Usage: node verify-parallel.mjs [--full]');
const full = process.argv.includes('--full');
const results = await Promise.all([1, 2].map(copy => new Promise(resolve => {
  const child = spawn(full ? 'npm' : process.execPath, full ? ['test'] : [vitest, 'run', 'tests/behaviour/chatgpt/chatgpt.test.ts'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-1_048_576); });
  child.once('error', error => { console.error(`Copy ${copy}: ${error.message}`); resolve(false); });
  child.once('exit', (code, signal) => {
    console.log(`Copy ${copy}: exit=${code}, signal=${signal}\n${output}`);
    resolve(code === 0);
  });
})));
if (results.some(ok => !ok)) process.exitCode = 1;
