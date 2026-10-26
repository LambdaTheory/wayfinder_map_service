// node tests/behaviour/review-run.ts <attempt directory>... [--execute --batch <approved review batch> --call-ceiling N] [--retry]
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attemptSchema } from './evidence.ts';
import type { AttemptRecord } from './evidence.ts';
import { library } from './library.ts';
import { CliReviewDriver } from './review-cli.ts';
import { reviewAttempt, reviewersFor, reviewItems } from './model-review.ts';
import type { ReviewDriver } from './model-review.ts';
import { decideReviews, evidenceHash, savedReviews } from './review-verdict.ts';
import { asScenario, upgradeChecks } from './upgrade-checks.ts';

function load(dir: string) {
  const text = readFileSync(join(dir, 'attempt.json'), 'utf8');
  const attempt = JSON.parse(text) as AttemptRecord;
  if (attempt.schema !== attemptSchema) throw new Error(`Unsupported Attempt schema in ${dir}`);
  const subjects = attempt.subject.kind === 'scenario' ? library : attempt.subject.kind === 'upgrade-check' ? upgradeChecks.map(asScenario) : [];
  const scenario = subjects.find(s => s.id === attempt.subject.id);
  if (!scenario) throw new Error(`Unknown Scenario ${attempt.subject.id}`);
  return { text, attempt, scenario };
}

export function reviewPlan(dirs: string[], retry = false) {
  if (!dirs.length) throw new Error('Provide at least one Attempt directory');
  if (new Set(dirs.map(d => resolve(d))).size !== dirs.length) throw new Error('Duplicate Attempt directories');
  return dirs.map(dir => {
    const { attempt, scenario } = load(dir);
    const archive = join(dir, 'model-reviews');
    if (existsSync(archive) && readdirSync(archive).some(id => !(attempt.modelReviews ?? []).some(r => r.roundId === id)))
      throw new Error('Unattached review round present; reconcile its private evidence before another invocation');
    const previous = savedReviews(attempt);
    const repeated = (attempt.modelReviews ?? []).some(r => r.evidenceHash === evidenceHash(attempt));
    if (repeated && !retry) throw new Error('Unchanged evidence already has a review round; use --retry only for unfinished items');
    const items = reviewItems(scenario, attempt).filter(i => {
      if (!repeated) return true;
      const d = decideReviews(i.id, previous, attempt);
      return 'open' in d && d.next !== 'human';
    });
    if (repeated && !items.length) throw new Error('No retryable items: completed decisions and human verdict boundaries cannot be re-read');
    return { directory: resolve(dir), attemptId: attempt.attemptId, evidenceHash: evidenceHash(attempt), items: items.map(i => i.id), ...reviewersFor(attempt),
      availabilityCalls: items.length ? 2 : 0, reviewCalls: items.length ? 2 : 0, arbitrationCeiling: items.length ? 1 : 0,
      callCeiling: items.length ? 5 : 0 };
  });
}

/** One lock per Attempt, append-only raw rounds, and an atomic update that preserves Driver fields. */
export async function reviewDirectories(dirs: string[], driver: ReviewDriver, batch: string, ceiling: number, retry = false) {
  const plan = reviewPlan(dirs, retry);
  const maximum = plan.reduce((n, p) => n + p.callCeiling, 0);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(batch) || !Number.isSafeInteger(ceiling) || ceiling < maximum) throw new Error(`Approved review batch ID and a call ceiling of at least ${maximum} are required`);
  const summaries = [];
  for (const p of plan) {
    const lock = join(p.directory, '.model-review.lock');
    const handle = openSync(lock, 'wx', 0o600);
    try {
      // Another batch may have finished after planning but before this lock was acquired.
      const current = reviewPlan([p.directory], retry)[0]!;
      if (JSON.stringify(current.items) !== JSON.stringify(p.items)) throw new Error('Review state changed since the budget plan; re-plan before spending quota');
      const { text, attempt, scenario } = load(p.directory);
      if (evidenceHash(attempt) !== p.evidenceHash) throw new Error('Attempt changed since the budget plan; re-plan before spending quota');
      const summary = await reviewAttempt(scenario, attempt, driver, p.directory, { itemIds: p.items, approval: { batch, callCeiling: ceiling, retry, plan } });
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
      execute: { type: 'boolean', default: false }, batch: { type: 'string' }, 'call-ceiling': { type: 'string' }, retry: { type: 'boolean', default: false },
      'check-login': { type: 'boolean', default: false },
    } });
    if (values['check-login']) {
      if (values.execute) throw new Error('--check-login cannot be combined with --execute');
      const driver = new CliReviewDriver();
      for (const target of [{ cli: 'claude' as const, model: 'claude-sonnet-5-5' }, { cli: 'codex' as const, model: 'gpt-6.1-sol' }]) {
        const check = await driver.checkLogin(target); console.log(JSON.stringify(check));
        if (!check.available) process.exitCode = 1;
      }
    }
    const plan = positionals.length || !values['check-login'] ? reviewPlan(positionals, values.retry) : [];
    console.log(JSON.stringify({ plan, callCeiling: plan.reduce((n, p) => n + p.callCeiling, 0),
      note: 'No generation in plan mode. Exact model access is unverified until approved availability probes run; there is no fallback.' }, null, 2));
    if (values.execute) {
      const results = await reviewDirectories(positionals, new CliReviewDriver(), values.batch ?? '', Number(values['call-ceiling']), values.retry);
      console.log(JSON.stringify(results, null, 2));
      if (results.some(r => r.pending.length)) process.exitCode = 1;
    }
  } catch (e) { console.error(String(e)); process.exitCode = 2; }
}
