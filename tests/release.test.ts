import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// One SemVer covers the service and its workflow (ADR 0004); each release is tagged v<version> on main.
const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const shipped = ['src', 'web', 'scripts', 'docs/agents/exploration-mcp.md', 'package-lock.json'];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lastRelease = (() => {
  try { return git('tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname').split('\n')[0] || undefined; }
  catch { return undefined; }
})();
const compare = (left: string, right: string) => {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
};

test('R00: package-lock.json and CHANGELOG follow the package.json version', () => {
  expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  expect([lock.version, lock.packages[''].version]).toEqual([version, version]);
  expect(readFileSync('CHANGELOG.md', 'utf8')).toMatch(new RegExp(`^## ${version.replaceAll('.', '\\.')} \\(`, 'm'));
});

test.skipIf(lastRelease === undefined)('R01: a shipped change since the last release tag carries a higher version', () => {
  const released = lastRelease!.slice(1);
  expect(compare(version, released), `package.json ${version} is below release ${lastRelease}`).toBeGreaterThanOrEqual(0);
  const changed = git('diff', '--name-only', lastRelease!, '--', ...shipped);
  if (changed) expect(compare(version, released), `changed since ${lastRelease} without a version increase:\n${changed}`).toBeGreaterThan(0);
});
