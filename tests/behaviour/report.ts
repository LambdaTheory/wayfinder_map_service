// node tests/behaviour/report.ts <batch dir>… [--baseline report.json] [--json out.json] [--md out.md]
// Turns Batch records into the comparison report of spec R5: new regressions, flaky results and uncovered cells first,
// then every cell. Compares a cell with a baseline only under compatible conditions.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { clientProfiles } from './clients.ts';
import type { AttemptRecord, Completeness, Harness } from './evidence.ts';
import { library } from './library.ts';
import type { Scenario } from './scenario.ts';
import { asScenario, upgradeChecks } from './upgrade-checks.ts';
import { judgeAttempt, judgeCell } from './verdict.ts';
import type { AttemptVerdict, CellVerdict, Outcome, Review } from './verdict.ts';

export interface CellKey { scenario: string; scenarioVersion: number; entry: string; combination: string; series: string; release: string }
export interface Comparison {
  baseline: { release: string; outcome: Outcome } | null;
  status: 'new' | 'same' | 'regression' | 'improved' | 'changed' | 'not-comparable';
  reasons: string[];
}
export interface ReportCell {
  key: CellKey;
  visibleModels: string[];
  planned: number;
  notRun: number;
  verdict: CellVerdict;
  /** Another Combination than the main one needs one more Attempt after an anomaly or a result unlike the main Combination's (§4). */
  retryDue: string | null;
  comparison: Comparison | null;
}
export interface Report { cells: ReportCell[]; batches: string[] }

interface BatchFile { batchId: string; combination: string; entry: string; outcomes: { attemptId: string; scenario: string; completeness: Completeness | 'not-run'; detail?: string; record?: string }[] }

const subjects = (): Scenario[] => [...library, ...upgradeChecks.map(asScenario)];
const cellId = (k: CellKey) => `${k.scenario}@v${k.scenarioVersion}|${k.entry}|${k.combination}|${k.series}:${k.release}`;
const sameSlot = (a: CellKey, b: CellKey) => a.scenario === b.scenario && a.entry === b.entry && a.combination === b.combination;
/** The run matrix of spec §4: the main Combination needs two Attempts, every other one. */
export const mainCombination = 'codex:gpt-6-astra:';
export const requiredAttempts = (combination: string) => combination.startsWith(mainCombination) ? 2 : 1;
const semver = (v: string) => v.split('.').map(n => Number(n) || 0);
const newer = (a: string, b: string) => { const x = semver(a); const y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0); return false; };

export function buildReport(batchDirs: string[], reviews: Record<string, Review[]> = {}): Report {
  const all = subjects();
  const cells = new Map<string, { key: CellKey; models: Set<string>; planned: number; notRun: number; verdicts: AttemptVerdict[] }>();
  for (const dir of batchDirs) {
    const batch = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')) as BatchFile;
    const load = (o: BatchFile['outcomes'][number]) => { const path = o.record ? join(dir, o.record) : null; return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord : null; };
    const records = new Map(batch.outcomes.map(o => [o.attemptId, load(o)]));
    // An Attempt without a record still belongs to its Batch's release, so it stays in the same cell.
    const service = [...records.values()].find(r => r)?.service;
    const supports = clientProfiles[batch.combination.split(':')[0] as Harness]?.supports ?? {};
    for (const o of batch.outcomes) {
      const s = all.find(x => x.id === o.scenario);
      const record = records.get(o.attemptId) ?? null;
      const scenario: Scenario = s ?? { ...all[0]!, id: o.scenario, version: record?.subject.version ?? 0, common: [], requiredEvents: [], mustNot: [], expect: [] };
      const key: CellKey = { scenario: o.scenario, scenarioVersion: record?.subject.version ?? scenario.version, entry: batch.entry, combination: batch.combination,
        series: record?.service.series ?? service?.series ?? 'release', release: record?.service.version ?? service?.version ?? 'unknown' };
      const cell = cells.get(cellId(key)) ?? { key, models: new Set(), planned: 0, notRun: 0, verdicts: [] };
      cells.set(cellId(key), cell);
      cell.planned++;
      if (o.completeness === 'not-run') { cell.notRun++; continue; }
      const attemptId = `${batch.batchId}/${o.attemptId}`;
      const verdict = s ? judgeAttempt(s, record, { reviews: reviews[attemptId] ?? [], attemptId, supports, outcome: { completeness: o.completeness, ...(o.detail ? { detail: o.detail } : {}) } })
        : { ...judgeAttempt(scenario, null, { attemptId }), reasons: [`${o.scenario} is neither a Scenario nor an upgrade check`] };
      cell.verdicts.push(verdict);
      if (record?.combination.visibleModel.known) cell.models.add(record.combination.visibleModel.value);
    }
  }
  const built = [...cells.values()].map(c => {
    const s = all.find(x => x.id === c.key.scenario) ?? all[0]!;
    return { key: c.key, visibleModels: [...c.models].sort(), planned: c.planned, notRun: c.notRun, retryDue: null as string | null,
      verdict: judgeCell(s, c.verdicts, requiredAttempts(c.key.combination), c.key.combination), comparison: null };
  });
  for (const c of built) {
    if (c.key.combination.startsWith(mainCombination)) continue;
    const main = built.find(m => m.key.scenario === c.key.scenario && m.key.entry === c.key.entry && m.key.release === c.key.release && m.key.combination.startsWith(mainCombination));
    const anomaly = c.verdict.outcome !== 'pass' && c.verdict.outcome !== 'not-applicable';
    if (c.verdict.attempts.length < 2 && (anomaly || (main && main.verdict.outcome !== c.verdict.outcome)))
      c.retryDue = anomaly ? `one more Attempt after ${c.verdict.outcome}` : `one more Attempt: main Combination ${main!.verdict.outcome}, this one ${c.verdict.outcome}`;
  }
  return { batches: batchDirs.map(d => d.split('/').at(-1)!), cells: built };
}

/**
 * Compare each cell with the newest compatible baseline cell of the same Scenario, Entry and Combination. A new
 * Combination or model needs a two-Attempt baseline before it can pass.
 */
export function compare(current: Report, baseline: Report): Report {
  return { ...current, cells: current.cells.map(cell => {
    const slot = baseline.cells.filter(b => sameSlot(b.key, cell.key) && b.key.release !== 'unknown');
    const pick = (xs: ReportCell[]) => xs.reduce<ReportCell | undefined>((best, x) => !best || newer(x.key.release, best.key.release) ? x : best, undefined);
    const before = pick(slot.filter(b => b.key.series === cell.key.series && b.key.scenarioVersion === cell.key.scenarioVersion && b.visibleModels.join() === cell.visibleModels.join()))
      ?? pick(slot);
    if (!before) {
      const decided = cell.verdict.counts.pass + cell.verdict.counts.fail;
      if (cell.verdict.outcome === 'pass' && decided < 2) return { ...cell, verdict: { ...cell.verdict, outcome: 'incomplete', reasons: [...cell.verdict.reasons, 'a new Combination or model needs a two-Attempt baseline'] },
        comparison: { baseline: null, status: 'new', reasons: ['two-Attempt baseline required'] } };
      return { ...cell, comparison: { baseline: null, status: 'new', reasons: [] } };
    }
    const reasons: string[] = [];
    if (before.key.series !== cell.key.series) reasons.push(`numbering changed (${before.key.series} → ${cell.key.series}); the two series are never merged`);
    if (before.key.scenarioVersion !== cell.key.scenarioVersion) reasons.push(`verdict changed (Scenario v${before.key.scenarioVersion} → v${cell.key.scenarioVersion})`);
    if (before.visibleModels.join() !== cell.visibleModels.join()) reasons.push(`model changed (${before.visibleModels.join(', ') || 'unknown'} → ${cell.visibleModels.join(', ') || 'unknown'})`);
    const base = { release: `${before.key.series}:${before.key.release}`, outcome: before.verdict.outcome };
    if (reasons.length) return { ...cell, comparison: { baseline: base, status: 'not-comparable', reasons } };
    const was = before.verdict.outcome; const now = cell.verdict.outcome;
    const status = was === now ? 'same' : was === 'pass' && (now === 'fail' || now === 'flaky') ? 'regression' : now === 'pass' ? 'improved' : 'changed';
    return { ...cell, comparison: { baseline: base, status, reasons: [] } };
  }) };
}

function tableRow(c: ReportCell): string {
  const n = c.verdict.counts;
  const against = c.comparison ? [c.comparison.status, c.comparison.baseline ? `vs ${c.comparison.baseline.release} ${c.comparison.baseline.outcome}` : '', c.comparison.reasons.join('; ')].filter(Boolean).join(' ') : '';
  const outcome = `**${c.verdict.outcome}**${c.verdict.reproduction ? ` (${c.verdict.reproduction})` : ''}${c.retryDue ? `; ${c.retryDue}` : ''}`;
  return `| ${c.key.scenario} v${c.key.scenarioVersion} | ${c.key.entry} | ${c.key.combination} | ${c.key.series}:${c.key.release} | ${outcome} | ${n.pass}/${n.fail}/${n.incomplete}/${n['insufficient-evidence']} | ${c.notRun} | ${against} |`;
}

/** Each anomalous cell points at its Attempts, the items that decided or still block them, their evidence and the raw files. */
function cellDetail(c: ReportCell): string {
  const head = `- **${c.key.scenario}** · ${c.key.combination} · ${c.key.series}:${c.key.release}: ${c.verdict.outcome}${c.verdict.reasons.length ? ` (${c.verdict.reasons.join('; ')})` : ''}${c.retryDue ? `; ${c.retryDue}` : ''}`;
  const attempts = c.verdict.attempts.map(a => {
    const items = [...a.required, ...a.mustNot, ...a.expect.flatMap(g => g.items)].filter(i => i.status !== 'holds' && i.evidence.length)
      .map(i => `${i.id} (${i.status}) at ${i.evidence.slice(0, 3).join(', ')}`);
    return `  - ${a.attemptId}: ${a.outcome}; ${a.reasons.join('; ') || 'no open items'}${a.gaps.length ? `; gaps: ${a.gaps.join('; ')}` : ''}${a.raw ? `; raw \`${a.raw}\`` : ''}${items.length ? `; ${items.join('; ')}` : ''}`;
  });
  return [head, ...attempts].join('\n');
}

export function renderMarkdown(r: Report): string {
  const regressions = r.cells.filter(c => c.comparison?.status === 'regression');
  const flaky = r.cells.filter(c => c.verdict.outcome === 'flaky');
  const uncovered = r.cells.filter(c => c.notRun > 0 || c.retryDue || c.verdict.outcome === 'incomplete' || c.verdict.outcome === 'insufficient-evidence'
    || c.verdict.attempts.some(a => a.gaps.length));
  const failing = r.cells.filter(c => c.verdict.outcome === 'fail' && c.comparison?.status !== 'regression');
  const section = (title: string, cells: ReportCell[]) => [`## ${title}`, '', cells.length ? cells.map(cellDetail).join('\n') : 'None.', ''];
  return ['# Behaviour report', '', `Batches: ${r.batches.join(', ')}. Counts are pass/fail/incomplete/insufficient evidence; a pass over a finite number of Attempts says only that those samples passed.`, '',
    ...section('New regressions', regressions), ...section('Flaky', flaky), ...section('Uncovered, undecided or retry due', uncovered), ...section('Failing', failing),
    '## All cells', '', '| Scenario | Entry | Combination | Release | Outcome | Attempts | Not run | Against baseline |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...r.cells].sort((a, b) => cellId(a.key).localeCompare(cellId(b.key))).map(tableRow), ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: 'string' }, json: { type: 'string' }, md: { type: 'string' } } });
  let report = buildReport(positionals);
  if (values.baseline) report = compare(report, JSON.parse(readFileSync(values.baseline, 'utf8')) as Report);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 1));
  const md = renderMarkdown(report);
  if (values.md) writeFileSync(values.md, md); else console.log(md);
}
