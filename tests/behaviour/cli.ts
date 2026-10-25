// node tests/behaviour/cli.ts <list|matrix|upgrade|validate|check <attempt.json>…>
// Lists the library, its applicability matrix and the upgrade checks. Starts no service and no model.
import { library } from './library.ts';
import { cell } from './clients.ts';
import { readFileSync } from 'node:fs';
import type { AttemptRecord, Entry, Harness } from './evidence.ts';
import { itemsOf, readiness, validateScenario } from './scenario.ts';
import { judgeAttempt } from './verdict.ts';
import type { ItemResult } from './verdict.ts';
import { asScenario, upgradeChecks } from './upgrade-checks.ts';

const columns: [Harness, Entry][] = [['codex', 'mcp-only'], ['codex', 'dedicated'], ['claude', 'mcp-only'], ['claude', 'dedicated'],
  ['chatgpt', 'chatgpt'], ['pi', 'mcp-only'], ['grok', 'mcp-only']];
const mark = { applicable: '✓', unverified: '?', 'not-applicable': '–', 'not-ready': '✗' } as const;

function list() {
  for (const s of library) {
    const items = itemsOf(s);
    const script = items.filter(i => i.judge === 'script').length;
    const notReady = readiness(s);
    console.log([s.id.padEnd(4), `v${s.version}`, s.source.kind.padEnd(13), notReady.length ? `not ready (${notReady.join('; ')})` : 'ready',
      `must-not ${s.mustNot.length}`, `groups ${s.expect.length}`, `items ${script} script / ${items.length - script} model or human`, s.title].join('  '));
  }
  const ready = library.filter(s => !readiness(s).length).length;
  console.log(`\n${library.length} candidates, ${ready} ready, ${library.length - ready} not ready`);
}

function matrix() {
  console.log(['    ', ...columns.map(([h, e]) => `${h}/${e}`.padEnd(17))].join(' '));
  for (const s of library) {
    console.log([s.id.padEnd(4), ...columns.map(([h, e]) => { const c = cell(s, h, e);
      return `${mark[c.state]} ${'reasons' in c ? c.reasons.join(',') : ''}`.slice(0, 17).padEnd(17); })].join(' '));
  }
  console.log('\n✓ applicable  ? Driver not onboarded or capability not yet proven  – not applicable  ✗ not ready');
}

function upgrade() {
  for (const u of upgradeChecks) console.log(`${u.id.padEnd(18)} ${`${u.harness}/${u.entry}`.padEnd(16)} rules from ${u.rulesSource.padEnd(14)} ${u.issue.padEnd(12)} ${u.situation}`);
}

function validate() {
  const errors = library.flatMap(validateScenario);
  for (const e of errors) console.error(e);
  console.log(errors.length ? `${errors.length} errors` : `${library.length} Scenarios valid`);
  if (errors.length) process.exitCode = 1;
}

/** The verdict of each Attempt record, item by item; model and human items stay pending until reviewed (B03b). */
function check() {
  for (const path of process.argv.slice(3)) {
    const record = JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord;
    const s = record.subject.kind === 'upgrade-check' ? (u => u && asScenario(u))(upgradeChecks.find(x => x.id === record.subject.id)) : library.find(x => x.id === record.subject.id);
    if (!s) { console.log(`${record.attemptId}  unknown Scenario ${record.subject.id}`); continue; }
    const v = judgeAttempt(s, record);
    console.log(`${record.attemptId}  run ${v.completeness}  verdict ${v.outcome}${v.reasons.length ? `: ${v.reasons.join('; ')}` : ''}`);
    const show = (kind: string, items: ItemResult[]) => items.forEach(i => console.log(`  ${kind.padEnd(8)} ${i.id.padEnd(30)} ${i.status.padEnd(14)} ${i.reason}`));
    show('required', v.required); show('must-not', v.mustNot);
    v.expect.forEach(g => show('expect', g.items.map(i => ({ ...i, id: `${g.id}/${i.id}` }))));
    show('quality', v.quality);
  }
}

const commands: Record<string, () => void> = { list, matrix, upgrade, validate, check };
const command = commands[process.argv[2] ?? 'list'];
if (!command) { console.error('usage: node tests/behaviour/cli.ts <list|matrix|upgrade|validate|check <attempt.json>…>'); process.exitCode = 2; } else command();
