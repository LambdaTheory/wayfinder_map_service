// Offline import only: this command never starts a model or discovers any client home.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attemptSchema } from '../evidence.ts';
import type { AttemptRecord } from '../evidence.ts';
import { receiptsFrom } from '../runner/normalize.ts';
import { abilities, assess } from './acceptance.ts';
import type { Assessment } from './acceptance.ts';
import { normalizeNative } from './native.ts';

/** Inputs are explicit files inside this private run, never paths into another run or a personal log directory. */
export function localFile(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('input must be relative to the private run');
  const path = join(root, name); const rel = relative(realpathSync(root), realpathSync(path));
  if (lstatSync(path).isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('input escapes the private run');
  return path;
}

export function importAttempt(root: string, nativeFile: string, assessment: Assessment) {
  if (assessment.schema !== 'wayfinder-interactive-assessment/1' || !['W1', 'W7'].includes(assessment.scenario)
    || !Number.isInteger(assessment.verdictVersion) || assessment.verdictVersion < 1
    || !assessment.selection || !Array.isArray(assessment.reviews) || !abilities.every(a => assessment.confirmations?.[a])) throw new Error('invalid interactive assessment');
  const capture = JSON.parse(readFileSync(localFile(root, 'capture.json'), 'utf8')) as AttemptRecord;
  if (capture.schema !== attemptSchema || !['codex', 'claude'].includes(capture.combination.harness) || capture.entry !== 'mcp-only'
    || !capture.batchId || capture.sessions.length !== 1) throw new Error('expected one isolated MCP-only Codex or Claude interactive capture');
  if (capture.subject.id !== assessment.scenario) throw new Error('capture and assessment Scenario differ');
  if (nativeFile === '-') {
    if (!abilities.every(a => assessment.confirmations[a].status === 'unsupported')) throw new Error('a native record is required unless every capability is unsupported');
    // An all-unsupported preflight needs no model session. capture.json carries the observed --version and surface.
    return { record: capture, locations: {}, ...assess(capture, assessment, new Set<string>()) };
  }
  const native = normalizeNative(capture.combination.harness as 'codex' | 'claude', readFileSync(localFile(root, nativeFile), 'utf8'), nativeFile, capture.sessions[0]!.clientId);
  const probes = new Set<string>();
  for (const c of Object.values(assessment.confirmations)) {
    if (c.probe) {
      const hash = createHash('sha256').update(readFileSync(localFile(root, c.probe.path))).digest('hex');
      if (hash !== c.probe.sha256) throw new Error('minimal probe hash mismatch');
      if (c.probe.path === nativeFile) throw new Error('capability probe must precede, and be separate from, the acceptance record');
      probes.add(hash);
    }
  }
  const record: AttemptRecord = { ...capture,
    combination: { ...capture.combination, visibleModel: native.model, effort: native.effort },
    client: { ...capture.client, version: native.version },
    sessions: [native.session], events: native.events, receipts: receiptsFrom(native.events),
    missing: [...new Set([...capture.missing, ...native.missing])],
    raw: { ...capture.raw, files: [...new Set([...capture.raw.files, nativeFile])] },
  };
  if (!Number.isFinite(Date.parse(record.run.startedAt)) || !Number.isFinite(Date.parse(record.run.endedAt))
    || native.events.some(e => Date.parse(e.at) < Date.parse(record.run.startedAt) || Date.parse(e.at) > Date.parse(record.run.endedAt))) {
    record.missing.push('native.integrity');
  }
  if (native.model.known && native.model.value !== capture.combination.requestedModel) {
    record.missing.push('combination.model-mismatch');
  }
  for (const receipt of record.receipts) {
    if (receipt.outcome.kind !== 'committed') continue;
    const revision = receipt.outcome.revision;
    const rev = record.maps.find(m => m.mapId === receipt.mapId)?.history.find(r => r.revision === revision);
    if (rev?.author.clientId !== native.session.clientId) {
      receipt.outcome = { kind: 'unknown', reason: 'native receipt does not match a Revision authored by this session credential' };
      record.missing.push('receipts');
    }
  }
  return { record, locations: native.locations, ...assess(record, assessment, probes) };
}

export function main(args: string[]) {
  const [rootArg, native, assessmentFile, output] = args;
  if (args.length !== 4 || !rootArg || !native || !assessmentFile || !output) throw new Error('usage: node tests/behaviour/interactive/cli.ts <private-run> <relative-native.jsonl> <relative-assessment.json> <fresh-output-directory>');
  const root = realpathSync(resolve(rootArg));
  const checkout = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
  const fromCheckout = relative(checkout, root);
  if (!fromCheckout || (!fromCheckout.startsWith('..') && !isAbsolute(fromCheckout))) throw new Error('private run records must remain outside the repository');
  const assessment = JSON.parse(readFileSync(localFile(root, assessmentFile), 'utf8')) as Assessment;
  const result = importAttempt(root, native, assessment);
  const out = isAbsolute(output) ? resolve(output) : resolve(root, output);
  const parent = realpathSync(dirname(out));
  const rel = relative(root, join(parent, basename(out)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('output must be a fresh child of the private run');
  if (parent !== root) throw new Error('output parent must be the private run');
  mkdirSync(out, { mode: 0o700 }); // Never replace an earlier assessment or verdict.
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  writeFileSync(join(out, 'attempt.json'), JSON.stringify(result.record, null, 2), { mode: 0o600 });
  for (const { ability, attempt, verdict } of result.verdicts) {
    writeFileSync(join(out, `${ability}.attempt.json`), JSON.stringify(attempt, null, 2), { mode: 0o600 });
    console.log(`${ability}: ${verdict.outcome}${verdict.gaps.length ? ` — ${verdict.gaps.join('; ')}` : ''}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
