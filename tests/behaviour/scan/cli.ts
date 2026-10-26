// node tests/behaviour/scan/cli.ts --input <manifest.json> --out <fresh-private-directory> [--state <previous/state.json>] [--reviews <reviews.json>]
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.ts';
import { proposeBatch } from './batch.ts';
import { digest, loadInputs, validateManifest } from './read.ts';
import type { Inputs, Review, ScanState } from './types.ts';
import { ScanError, scanFailure } from './errors.ts';

/** Private output still strips declared credentials and recognizable Bearer/API token forms. Not a general secret detector. */
export function privateJson(value: unknown, secrets: string[]): string {
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const secret of [...secrets].sort((a,b) => b.length - a.length)) s = s.split(secret).join(`<secret-${digest(secret).slice(0,12)}>`);
      return s.replace(/\bBearer\s+[^\s"'\\,}]+/gi, x => `<credential-${digest(x).slice(0,12)}>`)
        .replace(/\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g, x => `<credential-${digest(x).slice(0,12)}>`);
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,v]) => [clean(k), clean(v)]));
    return v;
  };
  const text = `${JSON.stringify(clean(value), null, 2)}\n`;
  if (secrets.some(s => text.includes(s) || text.includes(JSON.stringify(s).slice(1,-1)))) throw new ScanError('redaction');
  return text;
}

export function scanCommand(argv: string[]): string {
  if (process.versions.node !== '26.3.0') throw new ScanError('node');
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { input: { type: 'string' }, out: { type: 'string' }, state: { type: 'string' }, reviews: { type: 'string' } } })); }
  catch { throw new ScanError('usage'); }
  if (!values.input || !values.out) throw new ScanError('usage');
  const manifest: unknown = JSON.parse(readFileSync(values.input, 'utf8'));
  validateManifest(manifest);
  const output = resolve(realpathSync(dirname(resolve(values.out))), values.out.split(/[\\/]/).at(-1)!);
  const checkout = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
  const within = relative(checkout, output);
  const insideCheckout = !within || (!isAbsolute(within) && within !== '..' && !within.startsWith('../'));
  if (insideCheckout) throw new ScanError('output');
  const state = values.state ? JSON.parse(readFileSync(values.state, 'utf8')) as ScanState : undefined;
  const reviews: unknown = values.reviews ? JSON.parse(readFileSync(values.reviews, 'utf8')) : [];
  if (!Array.isArray(reviews) || reviews.some(r => !r || typeof r !== 'object'
    || ['leadId', 'evidenceHash', 'disposition', 'by', 'basis', 'reason'].some(k => typeof r[k] !== 'string')
    || !Array.isArray(r.quotes) || r.quotes.some((q: unknown) => !q || typeof q !== 'object'
      || !('ref' in q) || typeof q.ref !== 'string' || !('quote' in q) || typeof q.quote !== 'string'))) throw new ScanError('reviews');
  // Hash and quote the redacted evidence, so a reviewer can cite exactly the private output they received.
  const inputs = JSON.parse(privateJson(loadInputs(manifest, dirname(resolve(values.input))), manifest.secrets ?? [])) as Inputs;
  const report = analyze(inputs, manifest, state, reviews as Review[]);
  const batch = proposeBatch(report);
  const files = { 'inventory.json': report, 'batch-proposal.json': batch, 'state.json': report.state, 'capture-input-drafts.json': report.captureDrafts };
  const buffers = Object.entries(files).map(([name,value]) => [name, privateJson(value, manifest.secrets ?? [])] as const);
  // Reserve once, never overwrite an earlier inventory or a prior reminder ledger.
  mkdirSync(output, { mode: 0o700 });
  for (const [name,content] of buffers) writeFileSync(resolve(output, name), content, { flag: 'wx', mode: 0o600 });
  return JSON.stringify({ ...report.summary, gaps: report.gaps.length, batchInvocations: batch.plan.ceiling, batchApproved: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(scanCommand(process.argv.slice(2))); }
  catch (error) { console.error(scanFailure(error)); process.exitCode = 1; }
}
