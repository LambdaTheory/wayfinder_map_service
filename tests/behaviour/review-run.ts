// node tests/behaviour/review-run.ts <attempt directory>... [--execute --batch <approved review batch> --ceiling N]
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attemptSchema } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { library } from './library.ts';
import { CliReviewDriver } from './review-cli.ts';
import { reviewAttempt, reviewersFor, reviewItems } from './review.ts';
import type { ReviewDriver } from './review.ts';
import { evidenceHash } from './reviews.ts';
import { asScenario, upgradeChecks } from './upgrade-checks.ts';

function load(dir: string) {
  const text = readFileSync(join(dir, 'attempt.json'), 'utf8');
  const attempt = JSON.parse(text) as AttemptRecord;
  if (attempt.schema !== attemptSchema) throw new Error(`Unsupported Attempt schema in ${dir}`);
  const scenario = [...library, ...upgradeChecks.map(asScenario)].find(s => s.id === attempt.subject.id);
  if (!scenario) throw new Error(`Unknown Scenario ${attempt.subject.id}`);
  return { text, attempt, scenario };
}

export function reviewPlan(dirs: string[]) {
  if (!dirs.length) throw new Error('Provide at least one Attempt directory');
  if (new Set(dirs.map(d => resolve(d))).size !== dirs.length) throw new Error('Duplicate Attempt directories');
  return dirs.map(dir => {
    const { attempt, scenario } = load(dir);
    const items = reviewItems(scenario, attempt);
    return { directory: resolve(dir), attemptId: attempt.attemptId, evidenceHash: evidenceHash(attempt), items: items.map(i => i.id), ...reviewersFor(attempt),
      availabilityCalls: items.length ? 2 : 0, reviewCalls: items.length ? 2 : 0, arbitrationCeiling: items.length ? 1 : 0,
      callCeiling: items.length ? 5 : 0 };
  });
}

/** One lock per Attempt, append-only raw rounds, and an atomic update that preserves Driver fields. */
export async function reviewDirectories(dirs: string[], driver: ReviewDriver, batch: string, ceiling: number) {
  const plan = reviewPlan(dirs);
  const maximum = plan.reduce((n, p) => n + p.callCeiling, 0);
  if (!batch.trim() || !Number.isSafeInteger(ceiling) || ceiling < maximum) throw new Error(`Approved review batch and a ceiling of at least ${maximum} are required`);
  const summaries = [];
  for (const p of plan) {
    const lock = join(p.directory, '.model-review.lock');
    const handle = openSync(lock, 'wx', 0o600);
    try {
      const { text, attempt, scenario } = load(p.directory);
      if (evidenceHash(attempt) !== p.evidenceHash) throw new Error('Attempt changed since the budget plan; re-plan before spending quota');
      const summary = await reviewAttempt(scenario, attempt, driver, p.directory);
      writeFileSync(join(p.directory, summary.path.replace('result.json', 'batch.json')), JSON.stringify({ batch, ceiling, plan }, null, 2), { flag: 'wx', mode: 0o600 });
      if (readFileSync(join(p.directory, 'attempt.json'), 'utf8') !== text) throw new Error('Attempt changed while reviewing; result preserved but not attached');
      attempt.modelReviews = [...(attempt.modelReviews ?? []), summary];
      const tmp = join(p.directory, `.attempt-${summary.roundId}.json`);
      writeFileSync(tmp, JSON.stringify(attempt, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(tmp, join(p.directory, 'attempt.json'));
      summaries.push(summary);
    } finally { closeSync(handle); rmSync(lock); }
  }
  return summaries;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      execute: { type: 'boolean', default: false }, batch: { type: 'string' }, ceiling: { type: 'string' },
    } });
    const plan = reviewPlan(positionals);
    console.log(JSON.stringify({ plan, callCeiling: plan.reduce((n, p) => n + p.callCeiling, 0),
      note: 'No generation in plan mode. Exact model access is unverified until approved availability probes run; there is no fallback.' }, null, 2));
    if (values.execute) {
      const results = await reviewDirectories(positionals, new CliReviewDriver(), values.batch ?? '', Number(values.ceiling));
      console.log(JSON.stringify(results, null, 2));
      if (results.some(r => r.pending.length)) process.exitCode = 2;
    }
  } catch (e) { console.error(String(e)); process.exitCode = 1; }
}
