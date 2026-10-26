// node tests/behaviour/capture/cli.ts <database> <capture-input.json> <fresh-output-directory>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureProblem } from './capture.ts';
import type { CaptureInput } from './capture.ts';
import { CaptureError } from './errors.ts';

const [database, inputFile, output, ...extra] = process.argv.slice(2);
try {
  if (!database || !inputFile || !output || extra.length) throw new Error('Expected database, capture input JSON and fresh output directory');
  if (process.versions.node !== '26.3.0') throw new Error('Capture requires Node 26.3.0');
  const input = JSON.parse(readFileSync(inputFile, 'utf8')) as CaptureInput;
  const bundle = captureProblem(database, input);
  // Reserve a new directory only after capture succeeds; never overwrite any artifact or source.
  mkdirSync(output, { mode: 0o700 });
  for (const [file, value] of Object.entries({ 'seed.json': bundle.seed, 'scenario.json': bundle.scenario, 'capture.json': bundle.record })) {
    writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ scenario: input.id, verdict: bundle.record.verdict.status, reproduction: bundle.record.reproduction.status }));
} catch (error) {
  // Exceptions from fs/SQLite/JSON may embed private paths or source text. API callers can inspect errors privately.
  console.error(error instanceof CaptureError ? `Capture failed: ${error.message}`
    : 'Capture failed; no successful capture is asserted. Check the input, source format and fresh output directory locally.');
  process.exitCode = 1;
}
