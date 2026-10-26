// Offline import only: this command never starts a model or discovers any client home.
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attemptSchema } from '../evidence.ts';
import type { AttemptRecord } from '../evidence.ts';
import { checkoutRoot } from '../runner/service.ts';
import { receiptsFrom } from '../runner/normalize.ts';
import { abilities, assess, structure } from './acceptance.ts';
import { digest, reviewInput, verifyReviews } from './reviews.ts';
import type { ReviewArtifact } from './reviews.ts';
import type { Assessment } from './acceptance.ts';
import { normalizeNative } from './native.ts';
import { privateText, writePrivate } from './privacy.ts';

/** Inputs are explicit files inside this private run, never paths into another run or a personal log directory. */
export function localFile(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('input must be relative to the private run');
  const path = join(root, name); const rel = relative(realpathSync(root), realpathSync(path));
  if (lstatSync(path).isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('input escapes the private run');
  return path;
}

export function importAttempt(root: string, nativeFile: string, assessment: Assessment, reviewManifest?: string) {
  if (assessment.schema !== 'wayfinder-interactive-assessment/1' || !['W1', 'W7'].includes(assessment.scenario)
    || !Number.isInteger(assessment.verdictVersion) || assessment.verdictVersion < 1
    || !assessment.selection || !Array.isArray(assessment.reviews) || assessment.reviews.length !== 0 || !abilities.every(a => assessment.confirmations?.[a])) throw new Error('invalid interactive assessment');
  const capture = JSON.parse(readFileSync(localFile(root, 'capture.json'), 'utf8')) as AttemptRecord & { requestedEffort?: string };
  if (capture.schema !== attemptSchema || !['codex', 'claude'].includes(capture.combination.harness) || capture.entry !== 'mcp-only'
    || !capture.batchId || capture.sessions.length !== 1) throw new Error('expected one isolated MCP-only Codex or Claude interactive capture');
  if (capture.subject.id !== assessment.scenario) throw new Error('capture and assessment Scenario differ');
  if (nativeFile === '-') {
    if (!abilities.every(a => assessment.confirmations[a].status === 'unsupported')) throw new Error('a native record is required unless every capability is unsupported');
    // An all-unsupported preflight needs no model session. capture.json carries the observed --version and surface.
    return { record: capture, locations: {}, assessment, reviewArtifacts: [], ...assess(capture, assessment, new Set<string>()) };
  }
  const native = normalizeNative(capture.combination.harness as 'codex' | 'claude', readFileSync(localFile(root, nativeFile), 'utf8'), nativeFile, capture.sessions[0]!.clientId);
  const probes = new Set<string>();
  const nativeHash = digest(readFileSync(localFile(root, nativeFile), 'utf8'));
  for (const ability of abilities) {
    const c = assessment.confirmations[ability];
    if (c.status !== 'supported') continue;
    if (!c.probe) continue; // The verdict records the missing confirmation, never promotes it.
    const path = localFile(root, c.probe.path); const text = readFileSync(path, 'utf8'); const hash = digest(text);
    if (hash !== c.probe.sha256) throw new Error('minimal probe hash mismatch');
    if (hash === nativeHash || realpathSync(path) === realpathSync(localFile(root, nativeFile))) throw new Error('probe must be separate from acceptance evidence, not an alias or copy');
    const probe = normalizeNative(capture.combination.harness as 'codex' | 'claude', text, c.probe.path, 'probe');
    if (!c.probe.capturePath) throw new Error('probe needs its Controller capture');
    const pc = JSON.parse(readFileSync(localFile(root, c.probe.capturePath), 'utf8')) as AttemptRecord & { requestedEffort?: string };
    if (!native.model.known || !native.effort.known || !native.version.known || !native.session.nativeId.known) continue;
    if (native.model.value !== capture.combination.requestedModel || native.effort.value !== capture.requestedEffort) continue;
    if (pc.schema !== attemptSchema || pc.sessions.length !== 1 || !probe.session.nativeId.known || probe.session.nativeId.value === native.session.nativeId.value) {
      throw new Error('probe must have its own B01 capture and a distinct native session');
    }
    if (!probe.version.known || probe.version.value !== native.version.value || probe.version.value !== c.clientVersion) throw new Error('probe client version does not match the acceptance run and confirmation');
    if (!probe.model.known || probe.model.value !== native.model.value || !probe.effort.known || probe.effort.value !== native.effort.value
      || pc.requestedEffort !== capture.requestedEffort || probe.effort.value !== capture.requestedEffort
      || pc.combination.harness !== capture.combination.harness || pc.combination.requestedModel !== capture.combination.requestedModel || pc.entry !== capture.entry) {
      throw new Error('probe Combination or Entry does not match the acceptance run');
    }
    if (!pc.client.surface.known || !capture.client.surface.known || pc.client.surface.value !== capture.client.surface.value || pc.client.surface.value !== c.surface) throw new Error('probe surface does not match the acceptance run and confirmation');
    const times = [c.probe.endedAt, c.checkedAt, pc.run.startedAt, pc.run.endedAt, capture.run.startedAt];
    if (!probe.range.known || times.some(time => !Number.isFinite(Date.parse(time)))
      || Date.parse(probe.range.value.endedAt) > Date.parse(c.probe.endedAt)
      || Date.parse(c.probe.endedAt) >= Date.parse(capture.run.startedAt) || Date.parse(probe.range.value.endedAt) > Date.parse(c.checkedAt)
      || Date.parse(pc.run.endedAt) >= Date.parse(capture.run.startedAt)
      || Date.parse(probe.range.value.startedAt) < Date.parse(pc.run.startedAt) || Date.parse(probe.range.value.endedAt) > Date.parse(pc.run.endedAt)) {
      throw new Error('probe timestamps must fit its earlier Controller capture and precede confirmation and acceptance');
    }
    if (!c.probe.locations.length || c.probe.locations.some(location => {
      const match = /^(.*):(\d+)$/.exec(location);
      return !match || realpathSync(localFile(root, match[1]!)) !== realpathSync(path) || Number(match[2]) < 1 || Number(match[2]) > text.trimEnd().split('\n').length;
    })) throw new Error('probe source locations are invalid');
    const evidence: AttemptRecord = { ...pc, events: probe.events, sessions: [probe.session], missing: probe.missing,
      combination: { ...pc.combination, visibleModel: probe.model, effort: probe.effort } };
    if (!c.probe.selection || structure(evidence, ability, c.probe.selection).status !== 'holds') throw new Error('probe lacks the native capability evidence it claims');
    probes.add(hash);
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
  if (!capture.requestedEffort || (native.effort.known && native.effort.value !== capture.requestedEffort)) record.missing.push('combination.effort');
  for (const receipt of record.receipts) {
    if (receipt.outcome.kind !== 'committed') continue;
    const revision = receipt.outcome.revision;
    const rev = record.maps.find(m => m.mapId === receipt.mapId)?.history.find(r => r.revision === revision);
    if (rev?.author.clientId !== native.session.clientId) {
      receipt.outcome = { kind: 'unknown', reason: 'native receipt does not match a Revision authored by this session credential' };
      record.missing.push('receipts');
    }
  }
  const artifacts = reviewManifest ? readReviewArtifacts(root, reviewManifest) : [];
  const reviews = verifyReviews(record, assessment, artifacts);
  return { record, locations: native.locations, assessment, reviewArtifacts: artifacts, ...assess(record, assessment, probes, reviews),
    reviewInput: reviewInput(record, assessment) };

}

interface ReviewSource extends Omit<ReviewArtifact, 'input' | 'output' | 'basis'> {
  input: { path: string; sha256: string }; output: { path: string; sha256: string }; basis?: { path: string; sha256: string }[];
}
export function readReviewArtifacts(root: string, file: string): ReviewArtifact[] {
  const manifest = JSON.parse(readFileSync(localFile(root, file), 'utf8')) as { schema: string; records: ReviewSource[] };
  if (manifest.schema !== 'wayfinder-interactive-reviews/1' || !Array.isArray(manifest.records)) throw new Error('invalid separate review manifest');
  const read = (source: { path: string; sha256: string }) => {
    const text = readFileSync(localFile(root, source.path), 'utf8');
    if (digest(text) !== source.sha256) throw new Error('review artifact hash mismatch');
    return text;
  };
  return manifest.records.map(({ input, output, basis, ...identity }) => ({ ...identity, input: read(input), output: read(output), ...(basis ? { basis: basis.map(read) } : {}) }));
}

export function main(args: string[]) {
  const [rootArg, native, assessmentFile, output, reviews] = args;
  if ((args.length !== 4 && args.length !== 5) || !rootArg || !native || !assessmentFile || !output) throw new Error('usage: node tests/behaviour/interactive/cli.ts <private-run> <relative-native.jsonl> <relative-assessment.json> <fresh-output-directory> [relative-review-manifest.json]');
  const root = realpathSync(resolve(rootArg));
  const checkout = realpathSync(checkoutRoot);
  const fromCheckout = relative(checkout, root);
  if (!fromCheckout || (!fromCheckout.startsWith('..') && !isAbsolute(fromCheckout))) throw new Error('private run records must remain outside the repository');
  const assessment = JSON.parse(readFileSync(localFile(root, assessmentFile), 'utf8')) as Assessment;
  const result = importAttempt(root, native, assessment, reviews);
  const out = isAbsolute(output) ? resolve(output) : resolve(root, output);
  const parent = realpathSync(dirname(out));
  const rel = relative(root, join(parent, basename(out)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('output must be a fresh child of the private run');
  if (parent !== root) throw new Error('output parent must be the private run');
  mkdirSync(out, { mode: 0o700 }); // Never replace an earlier assessment or verdict.
  writePrivate(join(out, 'result.json'), result, {});
  writePrivate(join(out, 'attempt.json'), result.record, {});
  if ('reviewInput' in result) writePrivate(join(out, 'review-input.json'), result.reviewInput, {});
  for (const { ability, attempt, verdict } of result.verdicts) {
    writePrivate(join(out, `${ability}.attempt.json`), attempt, {});
    console.log(privateText(`${ability}: ${verdict.outcome}${verdict.reasons.length ? ` — ${verdict.reasons.join('; ')}` : ''}${verdict.gaps.length ? ` — ${verdict.gaps.join('; ')}` : ''}`, {}));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
