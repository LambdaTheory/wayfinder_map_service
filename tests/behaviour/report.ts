// node tests/behaviour/report.ts <batch dir>… [--baseline report.json] [--json out.json] [--md out.md]
// Turns Batch records into the comparison report of spec R5: new regressions, flaky results and uncovered cells first,
// then every cell. Compares a cell with a baseline only under compatible conditions.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AttemptRecord, Completeness } from './evidence.ts';
import { library } from './library.ts';
import { judgeAttempt, judgeCell } from './verdict.ts';
import type { AttemptVerdict, CellVerdict, Outcome, Review } from './verdict.ts';

export interface CellKey { scenario: string; entry: string; combination: string; series: string; release: string }
export interface Comparison {
  baseline: { release: string; outcome: Outcome } | null;
  status: 'new' | 'same' | 'regression' | 'improved' | 'changed' | 'not-comparable';
  reasons: string[];
}
export interface ReportCell {
  key: CellKey;
  scenarioVersion: number;
  visibleModels: string[];
  planned: number;
  notRun: number;
  verdict: CellVerdict;
  comparison: Comparison | null;
}
export interface Report { cells: ReportCell[]; batches: string[] }

interface BatchFile { batchId: string; combination: string; entry: string; outcomes: { attemptId: string; scenario: string; completeness: Completeness | 'not-run'; record?: string }[] }

const cellId = (k: CellKey) => `${k.scenario}|${k.entry}|${k.combination}|${k.series}:${k.release}`;
/** The pass rule of spec §4: the main Combination needs two Attempts, others one. */
export const requiredAttempts = (combination: string) => combination.startsWith('codex:gpt-6-astra:') ? 2 : 1;

export function buildReport(batchDirs: string[], reviews: Record<string, Review[]> = {}): Report {
  const cells = new Map<string, { key: CellKey; versions: Set<number>; models: Set<string>; planned: number; notRun: number; verdicts: AttemptVerdict[] }>();
  for (const dir of batchDirs) {
    const batch = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')) as BatchFile;
    for (const o of batch.outcomes) {
      const s = library.find(x => x.id === o.scenario);
      if (!s) continue;
      const path = o.record ? join(dir, o.record) : null;
      const record = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord : null;
      const key: CellKey = { scenario: s.id, entry: batch.entry, combination: batch.combination,
        series: record?.service.series ?? 'release', release: record?.service.version ?? 'unknown' };
      const cell = cells.get(cellId(key)) ?? { key, versions: new Set(), models: new Set(), planned: 0, notRun: 0, verdicts: [] };
      cells.set(cellId(key), cell);
      cell.planned++;
      if (o.completeness === 'not-run') { cell.notRun++; continue; }
      const attemptId = `${batch.batchId}/${o.attemptId}`;
      cell.verdicts.push(judgeAttempt(s, record, { reviews: reviews[attemptId] ?? [], attemptId }));
      cell.versions.add(record?.subject.version ?? s.version);
      if (record?.combination.visibleModel.known) cell.models.add(record.combination.visibleModel.value);
    }
  }
  return { batches: batchDirs.map(d => d.split('/').at(-1)!), cells: [...cells.values()].map(c => ({
    key: c.key, scenarioVersion: Math.max(0, ...c.versions), visibleModels: [...c.models].sort(), planned: c.planned, notRun: c.notRun,
    verdict: judgeCell(library.find(s => s.id === c.key.scenario)!, c.verdicts, requiredAttempts(c.key.combination)), comparison: null,
  })) };
}

/** Compare each cell with the baseline cell of the same Scenario, Entry and Combination, when conditions allow. */
export function compare(current: Report, baseline: Report): Report {
  return { ...current, cells: current.cells.map(cell => {
    const before = baseline.cells.find(b => b.key.scenario === cell.key.scenario && b.key.entry === cell.key.entry && b.key.combination === cell.key.combination);
    if (!before) return { ...cell, comparison: { baseline: null, status: 'new', reasons: [] } };
    const reasons: string[] = [];
    if (before.key.series !== cell.key.series) reasons.push(`numbering changed (${before.key.series} → ${cell.key.series}); the two series are never merged`);
    if (before.scenarioVersion !== cell.scenarioVersion) reasons.push(`verdict changed (Scenario v${before.scenarioVersion} → v${cell.scenarioVersion})`);
    if (before.visibleModels.join() !== cell.visibleModels.join()) reasons.push(`model changed (${before.visibleModels.join(', ') || 'unknown'} → ${cell.visibleModels.join(', ') || 'unknown'})`);
    const base = { release: `${before.key.series}:${before.key.release}`, outcome: before.verdict.outcome };
    if (reasons.length) return { ...cell, comparison: { baseline: base, status: 'not-comparable', reasons } };
    const was = before.verdict.outcome; const now = cell.verdict.outcome;
    const status = was === now ? 'same' : was === 'pass' && (now === 'fail' || now === 'flaky') ? 'regression' : now === 'pass' ? 'improved' : 'changed';
    return { ...cell, comparison: { baseline: base, status, reasons: [] } };
  }) };
}

const row = (c: ReportCell) => {
  const n = (o: string) => c.verdict.attempts.filter(a => a.outcome === o).length;
  return `| ${c.key.scenario} v${c.scenarioVersion} | ${c.key.entry} | ${c.key.combination} | ${c.key.series}:${c.key.release} | **${c.verdict.outcome}**${c.verdict.reproduction ? ` (${c.verdict.reproduction})` : ''} | ${n('pass')}/${n('fail')}/${n('incomplete')}/${n('insufficient-evidence')} | ${c.notRun} | ${c.comparison ? `${c.comparison.status}${c.comparison.baseline ? ` vs ${c.comparison.baseline.release} ${c.comparison.baseline.outcome}` : ''}${c.comparison.reasons.length ? `: ${c.comparison.reasons.join('; ')}` : ''}` : ''} |`;
};

/** Each anomalous cell points at its Attempts, the items that decided them, their evidence and the raw files. */
const detail = (c: ReportCell) => [`- **${c.key.scenario}** · ${c.key.combination} · ${c.key.series}:${c.key.release}: ${c.verdict.outcome}${c.verdict.reasons.length ? ` (${c.verdict.reasons.join('; ')})` : ''}`,
  ...c.verdict.attempts.map(a => `  - ${a.attemptId}: ${a.outcome}; ${a.reasons.join('; ') || 'no open items'}${a.raw ? `; raw \`${a.raw}\`` : ''}${
    [...a.mustNot, ...a.required, ...a.expect.flatMap(g => g.items)].filter(i => i.status === 'violated' && i.evidence.length).map(i => `; ${i.id} at ${i.evidence.slice(0, 3).join(', ')}`).join('')}`)].join('\n');

export function renderMarkdown(r: Report): string {
  const regressions = r.cells.filter(c => c.comparison?.status === 'regression');
  const flaky = r.cells.filter(c => c.verdict.outcome === 'flaky');
  const uncovered = r.cells.filter(c => c.notRun > 0 || c.verdict.outcome === 'incomplete' || c.verdict.outcome === 'insufficient-evidence');
  const failing = r.cells.filter(c => c.verdict.outcome === 'fail' && c.comparison?.status !== 'regression');
  const section = (title: string, cells: ReportCell[]) => [`## ${title}`, '', cells.length ? cells.map(detail).join('\n') : 'None.', ''];
  return [`# Behaviour report`, '', `Batches: ${r.batches.join(', ')}. Counts are pass/fail/incomplete/insufficient evidence; a pass over a finite number of Attempts says only that those samples passed.`, '',
    ...section('New regressions', regressions), ...section('Flaky', flaky), ...section('Uncovered or not yet decided', uncovered), ...section('Failing', failing),
    '## All cells', '', '| Scenario | Entry | Combination | Release | Outcome | Attempts | Not run | Against baseline |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.cells.sort((a, b) => cellId(a.key).localeCompare(cellId(b.key))).map(row), ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: 'string' }, json: { type: 'string' }, md: { type: 'string' } } });
  let report = buildReport(positionals);
  if (values.baseline) report = compare(report, JSON.parse(readFileSync(values.baseline, 'utf8')) as Report);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 1));
  const md = renderMarkdown(report);
  if (values.md) writeFileSync(values.md, md); else console.log(md);
}
