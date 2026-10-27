#!/usr/bin/env node
// Manual, model-free comparison of all behaviour test verdict inputs with a pinned main checkout.
// Run after build: node tests/behaviour/compare-main.mjs --out /tmp/wayfinder-verdict-comparison.json
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const approved = JSON.parse(readFileSync(new URL('./compare-main-allowed.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: compare-main.mjs --out <report.json>');
const out = resolve(args[1]);
const scratch = mkdtempSync(join(tmpdir(), 'wayfinder-verdict-main-'));
const raw = join(scratch, 'comparisons.jsonl');
const base = execFileSync('git', ['rev-parse', approved.main], { cwd: repo, encoding: 'utf8' }).trim();
try {
  execFileSync('tar', ['-x', '-C', scratch], { input: execFileSync('git', ['archive', base, 'tests/behaviour', 'tests/helpers', 'src'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
  symlinkSync(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  writeFileSync(raw, '');
  const config = join(scratch, 'compare.config.mjs');
  writeFileSync(config, `export default ${JSON.stringify({ root: repo, test: { environment: 'node', include: ['tests/behaviour/**/*.test.ts'],
    setupFiles: [join(repo, 'tests/behaviour/compare-main.setup.ts')] } })};\n`);
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, WF_VERDICT_BASELINE: scratch, WF_VERDICT_RESULTS: raw },
  });
  const rows = readFileSync(raw, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const key = r => [r.file, r.test, r.scenario, r.mode, r.before, r.after].join(' | ');
  const changes = new Map();
  for (const row of rows.filter(r => r.before !== r.after)) {
    const id = key(row);
    const found = changes.get(id) ?? { ...row, count: 0, reason: approved.changes.find(c => c.key === id)?.reason ?? null };
    found.count++; changes.set(id, found);
  }
  const covered = [...new Set(rows.filter(r => r.mode === 'definition').map(r => r.scenario))].sort();
  const expected = [...approved.scenarios].sort();
  const unexpected = [...changes.values()].filter(r => !r.reason);
  const stale = approved.changes.filter(c => !changes.has(c.key));
  const countMismatches = approved.changes.filter(c => changes.has(c.key) && changes.get(c.key).count !== c.count).map(c => c.key);
  const report = { main: base, branch: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    comparisons: rows.length, unchanged: rows.filter(r => r.before === r.after).length, covered,
    changes: [...changes.values()].sort((a, b) => key(a).localeCompare(key(b))), unexpected: unexpected.length, stale: stale.map(c => c.key),
    countMismatches, testsPassed: result.status === 0 };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Main comparison: ${rows.length} verdicts, ${changes.size} changed groups, ${unexpected.length} unapproved, ${stale.length} stale approvals; ${out}`);
  if (result.status !== 0 || unexpected.length || stale.length || countMismatches.length || JSON.stringify(covered) !== JSON.stringify(expected)) process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
