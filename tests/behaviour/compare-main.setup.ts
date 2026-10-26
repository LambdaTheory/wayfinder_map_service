// Manual comparison instrumentation only; npm test does not load this setup file.
// Reuse every existing verdict fixture, without copying or weakening its assertions.
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, vi } from 'vitest';
import type { Scenario } from './scenario.ts';
import type { AttemptRecord } from './evidence.ts';
import type { AttemptVerdict, JudgeOptions } from './verdict.ts';

const counterparts = vi.hoisted(() => new WeakMap<Function, Function>());
vi.mock('./checks.ts', async importOriginal => {
  const current = await importOriginal<typeof import('./checks.ts')>();
  const baseline = await import(`${process.env.WF_VERDICT_BASELINE!}/tests/behaviour/checks.ts`);
  return Object.fromEntries(Object.entries(current).map(([name, value]) => {
    const old = baseline[name];
    if (typeof value !== 'function' || typeof old !== 'function') return [name, value];
    const wrapped = (...args: unknown[]) => {
      const result = (value as Function)(...args);
      // Factory-generated checks retain their captured parameters; compound checks use old child checks too.
      if (typeof result === 'function') counterparts.set(result, old(...args.map(a => typeof a === 'function' ? counterparts.get(a) ?? a : a)));
      return result;
    };
    counterparts.set(wrapped, old);
    return [name, wrapped];
  }));
});

vi.mock('./verdict.ts', async importOriginal => {
  const current = await importOriginal<typeof import('./verdict.ts')>();
  const root = process.env.WF_VERDICT_BASELINE!;
  const baseline = await import(`${root}/tests/behaviour/verdict.ts`) as typeof current;
  const oldLibrary = (await import(`${root}/tests/behaviour/library.ts`)).library as Scenario[];
  const oldUpgrades = await import(`${root}/tests/behaviour/upgrade-checks.ts`) as typeof import('./upgrade-checks.ts');
  const { library } = await import('./library.ts');
  const save = (s: Scenario, before: AttemptVerdict, after: AttemptVerdict, mode: string) => {
    const state = expect.getState();
    appendFileSync(process.env.WF_VERDICT_RESULTS!, JSON.stringify({
      file: relative(process.cwd(), state.testPath ?? ''), test: state.currentTestName ?? '(module initialization)',
      scenario: s.id, mode, before: before.outcome, after: after.outcome,
      baselineVersion: before.scenario.version, branchVersion: after.scenario.version,
    }) + '\n');
  };
  return { ...current, judgeAttempt(s: Scenario, a: AttemptRecord | null, opts: JudgeOptions = {}) {
    const after = current.judgeAttempt(s, a, opts);
    // Run main's engine/common checks on the exact same supplied definition/evidence, including custom fixtures.
    save(s, baseline.judgeAttempt(s, a, opts), after, 'engine');
    // Also compare the real main library/check helpers for every stock Scenario and all upgrade definitions.
    const old = library.includes(s) ? oldLibrary.find(x => x.id === s.id)
      : s.id.startsWith('U-') ? oldUpgrades.upgradeChecks.find(x => x.id === s.id) : undefined;
    if (old) {
      const definition = 'harness' in old ? oldUpgrades.asScenario(old) : old;
      // This is an explicit definition comparison, never a relabelled historical Attempt.
      const record = a && definition.version !== s.version && a.subject.version === s.version
        ? { ...a, subject: { ...a.subject, version: definition.version } } : a;
      save(s, baseline.judgeAttempt(definition, record, opts), after, 'definition');
    } else {
      let changed = false;
      const rebase = (item: import('./scenario.ts').Item): import('./scenario.ts').Item => {
        if (item.judge !== 'script' || !counterparts.has(item.check)) return item;
        changed = true;
        return { ...item, check: counterparts.get(item.check) as typeof item.check };
      };
      const definition = { ...s, requiredEvents: s.requiredEvents.map(rebase), mustNot: s.mustNot.map(rebase),
        expect: s.expect.map(g => ({ ...g, anyOf: g.anyOf.map(rebase) })) };
      if (changed) save(s, baseline.judgeAttempt(definition, a, opts), after, 'helpers');
    }
    return after;
  } };
});
