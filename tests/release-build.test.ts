import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
// @ts-expect-error plain ESM build helper, outside the TypeScript source graph
import { buildReleaseVersion } from '../scripts/release-version.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'wayfinder-release-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  writeFileSync(join(root, 'rules.md'), 'Original rules\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  git('add', '.'); git('commit', '-m', 'Synthetic release'); git('tag', 'v5.0.0');
  return { root, git, build: () => buildReleaseVersion(root, '5.0.0') as string };
}

test('R03: only the clean matching release tag reports the published version', () => {
  const f = repository();
  expect(f.build()).toBe('5.0.0');
  // Generated artifacts never make an otherwise clean release dirty.
  mkdirSync(join(f.root, 'dist')); writeFileSync(join(f.root, 'dist/generated.js'), 'generated');
  expect(f.build()).toBe('5.0.0');
  f.git('commit', '--allow-empty', '-m', 'Next commit');
  expect(f.build()).toBe(`5.0.0+dev.${f.git('rev-parse', 'HEAD').slice(0, 22)}`);
  f.git('tag', 'v4.9.0');
  expect(f.build()).toContain('+dev.');
  f.git('checkout', '--detach', 'v5.0.0');
  expect(f.build()).toBe('5.0.0');
});

test('R04: unstaged, staged and untracked edits at a tag are distinct development builds', () => {
  const f = repository();
  writeFileSync(join(f.root, 'rules.md'), 'New rules\n');
  const first = f.build();
  expect(first).toMatch(/^5\.0\.0\+dev\.d[a-f0-9]{21}$/);
  expect(first.length).toBeLessThanOrEqual(32);
  expect(f.build()).toBe(first);
  writeFileSync(join(f.root, 'rules.md'), 'Other rules\n');
  expect(f.build()).not.toBe(first);
  f.git('add', 'rules.md'); expect(f.build()).toContain('+dev.d');
  f.git('reset', '--hard', 'HEAD'); expect(f.build()).toBe('5.0.0');
  writeFileSync(join(f.root, 'new-tool.ts'), 'first');
  const untracked = f.build(); expect(untracked).toContain('+dev.d');
  writeFileSync(join(f.root, 'new-tool.ts'), 'second'); expect(f.build()).not.toBe(untracked);
});

test('R05: missing Git provenance and invalid package versions never fall back to a release', () => {
  const root = mkdtempSync(join(tmpdir(), 'wayfinder-no-git-')); roots.push(root);
  expect(() => buildReleaseVersion(root, '5.0.0')).toThrow(/cannot establish Git/);
  expect(() => buildReleaseVersion(root, '5.0.0+dev.fake')).toThrow(/valid release SemVer/);
});
