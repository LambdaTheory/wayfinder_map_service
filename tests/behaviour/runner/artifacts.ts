// Both Entries retain artifacts through this one filename/content redaction boundary.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactBytes } from '../evidence.ts';
import { entryIdentity, IsolationError, readRegularFile } from './sandbox.ts';

export function captureArtifacts(source: string, target: string, secrets: Record<string, string>): void {
  entryIdentity(source, 'directory');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  entryIdentity(target, 'directory');
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
    const basename = redact(entry.name, secrets);
    if (!basename || basename === '.' || basename === '..' || basename.includes('/')) throw new IsolationError('unsafe redacted artifact name');
    let to = join(target, basename);
    // Redaction can collapse distinct names. Never merge directories or replace an earlier artifact.
    for (let suffix = 1; existsSync(to); suffix++) to = join(target, `${basename}.redacted-${suffix}`);
    const from = join(source, entry.name);
    if (entry.isDirectory()) captureArtifacts(from, to, secrets);
    else writeFileSync(to, redactBytes(readRegularFile(from), secrets), { mode: 0o600, flag: 'wx' });
  }
}
