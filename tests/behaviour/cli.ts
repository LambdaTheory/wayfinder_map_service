// node tests/behaviour/cli.ts <list|matrix|upgrade|validate|check <attempt.json>…>
// Lists the library, its applicability matrix and the upgrade checks. Starts no service and no model.
import { library } from './library.ts';
import { cell } from './clients.ts';
import { readFileSync } from 'node:fs';
import { common } from './common.ts';
import type { AttemptRecord } from './evidence.ts';
import { itemsOf, readiness, validateScenario } from './scenario.ts';
import type { Entry, Harness } from './evidence.ts';
import { upgradeChecks } from './upgrade-checks.ts';

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

/** Script items of an Attempt's Scenario against its record. Model and human items stay open until B03. */
function check() {
  for (const path of process.argv.slice(3)) {
    const record = JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord;
    const s = library.find(x => x.id === record.subject.id);
    console.log(`${record.attemptId}  ${record.run.completeness}${record.run.detail ? ` (${record.run.detail})` : ''}`);
    if (!s) { console.log('  unknown Scenario'); continue; }
    const kind = (id: string) => s.common.includes(id as never) ? 'common' : s.requiredEvents.some(i => i.id === id) ? 'required' : s.mustNot.some(i => i.id === id) ? 'must-not' : 'expect';
    for (const item of [...itemsOf(s), ...s.common.map(c => common[c])]) {
      const result = item.judge === 'script' ? item.check(record) : { status: `${item.judge} review`, reason: '' };
      console.log(`  ${kind(item.id).padEnd(8)} ${item.id.padEnd(30)} ${result.status.padEnd(12)} ${result.reason}`);
    }
  }
}

const commands: Record<string, () => void> = { list, matrix, upgrade, validate, check };
const command = commands[process.argv[2] ?? 'list'];
if (!command) { console.error('usage: node tests/behaviour/cli.ts <list|matrix|upgrade|validate|check <attempt.json>…>'); process.exitCode = 2; } else command();
