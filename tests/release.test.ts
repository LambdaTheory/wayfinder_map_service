import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// PRs accumulate Unreleased entries; only a release commit changes package.json (spec §14.3).
const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const shipped = ['src', 'web', 'scripts', 'docs/agents/exploration-mcp.md', 'package-lock.json'];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const compare = (left: string, right: string) => {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
};
function section(changelog: string, heading: string) {
  const sections = [...changelog.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  return sections.filter(match => match[1] === heading || match[1]!.startsWith(`${heading} (`));
}
function releaseErrors(current: string, released: string, changelog: string, changed: boolean, tagged = false): string[] {
  const errors: string[] = [];
  const unreleased = section(changelog, 'Unreleased');
  if (unreleased.length !== 1) errors.push('exactly one Unreleased section is required');
  const body = (unreleased[0]?.[2] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (compare(current, released) < 0) errors.push('version cannot decrease');
  if (compare(current, released) > 0 || tagged) {
    if (section(changelog, current).length !== 1) errors.push('release needs its new version section');
    if (body) errors.push('release must empty Unreleased');
  } else if (changed && !/^-\s+\S.+/m.test(body)) errors.push('shipped changes need a nonempty Unreleased entry');
  return errors;
}

test('R00: package-lock.json and CHANGELOG follow the package.json version', () => {
  expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  expect([lock.version, lock.packages[''].version]).toEqual([version, version]);
  expect(section(readFileSync('CHANGELOG.md', 'utf8'), version)).toHaveLength(1);
});

test('R01: shipped changes accumulate entries; release commits move them into a new section', () => {
  const lastRelease = git('tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname').split('\n')
    .find(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag));
  expect(lastRelease, 'fetch release tags before running the release gate').toBeDefined();
  const changed = git('diff', '--name-only', lastRelease!, '--', ...shipped)
    || git('ls-files', '--others', '--exclude-standard', '--', ...shipped);
  const tagged = !git('status', '--porcelain', '--untracked-files=all') && git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`);
  expect(releaseErrors(version, lastRelease!.slice(1), readFileSync('CHANGELOG.md', 'utf8'), !!changed, tagged),
    `release gate against ${lastRelease}; shipped changes:\n${changed}`).toEqual([]);
});

const history = '\n## 5.0.0 (2026-10-27)\n\n- Previous release.\n';
const pending = `## Unreleased\n\n- Minor: next rule change.\n${history}`;
const empty = `## Unreleased\n${history}`;
const released = `## Unreleased\n\n## 5.1.0 (2026-10-28)\n\n- Minor: next rule change.\n${history}`;
test.each([
  ['unreleased shipped change', '5.0.0', pending, true, false, []],
  ['empty Unreleased', '5.0.0', empty, true, false, ['shipped changes need a nonempty Unreleased entry']],
  ['placeholder comment', '5.0.0', empty.replace('## Unreleased', '## Unreleased\n<!-- - pending -->'), true, false, ['shipped changes need a nonempty Unreleased entry']],
  ['docs only', '5.0.0', empty, false, false, []],
  ['release commit', '5.1.0', released, true, false, []],
  ['missing release section', '5.1.0', empty, true, false, ['release needs its new version section']],
  ['unmoved release entries', '5.1.0', released.replace('## Unreleased', '## Unreleased\n- Still pending'), true, false, ['release must empty Unreleased']],
  ['version decrease', '4.9.0', empty, false, false, ['version cannot decrease']],
  ['tagged release', '5.0.0', empty, false, true, []],
  ['tagged with pending entries', '5.0.0', pending, false, true, ['release must empty Unreleased']],
  ['missing Unreleased', '5.0.0', history, false, false, ['exactly one Unreleased section is required']],
] as const)('R02: %s', (_name, current, changelog, changed, tagged, errors) => {
  expect(releaseErrors(current, '5.0.0', changelog, changed, tagged)).toEqual(errors);
});
