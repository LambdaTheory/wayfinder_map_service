// Manual only: never starts a model or drives ChatGPT. `plan` is safe before approval; `run` owns a live tunnel.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { completeness } from '../evidence.ts';
import type { Completeness } from '../evidence.ts';
import type { AttemptRecord } from '../evidence.ts';
import { buildReport, renderMarkdown } from '../report.ts';
import { checkoutRoot } from '../runner/service.ts';
import { ChatGPTAttempt } from './attempt.ts';
import type { Capture } from './attempt.ts';
import { checklist, initialFive, selectScenarios } from './plan.ts';
import { acquireTunnel } from './tunnel.ts';
import type { TunnelLease } from './tunnel.ts';
import { everydayListener, unchangedListener } from './isolation.ts';

export const runRoot = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
type ChatGPTSurface = 'app' | 'web' | 'mobile';
interface Options { batch: string; scenarios: string[]; count: number; ceiling: number; surface: ChatGPTSurface; model: string; approval: string; hostname: string; configPath: string; fake: boolean }

export function clientVisibility(record: AttemptRecord | null) {
  return record ? record.given.map(g => ({ phase: g.phase, instructions: g.instructions, compatibilityMode: g.compatibilityMode, rulesSource: g.rulesSource }))
    : { known: false, reason: 'Attempt not recorded' };
}

export async function runBatch(options: Options, input: AsyncIterable<string>, log: (line: string) => void = console.log) {
  const scenarios = selectScenarios(options.scenarios);
  if (!options.approval.trim()) throw new Error('run requires --approval with Kun’s Batch approval reference');
  if (process.version !== 'v26.3.0') throw new Error('Node 26.3.0 is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.batch)) throw new Error('Invalid Batch ID');
  if (!Number.isInteger(options.count) || options.count < 1 || !Number.isInteger(options.ceiling) || options.ceiling < 1) throw new Error('count and ceiling must be positive integers');
  const dir = join(runRoot, options.batch);
  if (existsSync(dir)) throw new Error('Batch directory already exists; use a fresh Batch ID (records are never overwritten)');
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const version = (JSON.parse(readFileSync(join(checkoutRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const { workflowContract } = await import(pathToFileURL(join(checkoutRoot, 'dist/workflow.generated.js')).href) as { workflowContract: { version: string } };
  if (workflowContract.version !== version) throw new Error('dist is stale: run npm run build before this Batch');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf8' }).trim();
  const before = everydayListener();
  const batch = { batchId: options.batch, combination: `chatgpt:${options.model}:${options.surface}`, entry: 'chatgpt', approval: options.approval,
    isolation: { everydayBefore: before, everydayAfter: { known: false, reason: 'Batch not stopped yet' } as typeof before,
      everydayUnchanged: { known: false, reason: 'Batch not stopped yet' } as ReturnType<typeof unchangedListener> },
    surface: options.surface, fakeTunnel: options.fake, service: { commit, version, series: 'release' },
    surfaces: Object.fromEntries(['app', 'web', 'mobile'].map(s => [s, s === options.surface ? 'planned' : 'untested'])),
    outcomes: scenarios.flatMap(s => Array.from({ length: options.count }, (_, i) => ({ attemptId: `${s.id}-${i + 1}`, scenario: s.id,
      completeness: 'not-run' as Completeness | 'not-run', detail: 'not started', record: '' }))) };
  const save = () => {
    writeFileSync(join(dir, 'batch.json'), JSON.stringify(batch, null, 2), { mode: 0o600 });
    const report = buildReport([dir]);
    const visibility = batch.outcomes.map(item => {
      const record = item.record ? JSON.parse(readFileSync(join(dir, item.record), 'utf8')) as AttemptRecord : null;
      return { attemptId: item.attemptId, missing: record ? record.missing : ['Attempt not recorded'],
        phases: clientVisibility(record), surface: options.surface };
    });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...report, chatgptAcceptance: { fakeTunnel: options.fake, surfaces: batch.surfaces, visibility, humanVerdict: 'pending' } }, null, 2), { mode: 0o600 });
    writeFileSync(join(dir, 'report.md'), renderMarkdown(report) + `\n## ChatGPT acceptance evidence\n\nSurface: ${options.surface}; all other surfaces are untested.\n\n`
      + 'For each Attempt inspect raw/capture-N.json (native client snapshot and versionSourceEvidence), raw/wire.json (write version), and given (visibility and optional surfaces). Missing client visibility is not proof that the model read the definitions.\n\n'
      + visibility.map(v => `- ${v.attemptId}: mode ${Array.isArray(v.phases) ? v.phases.map(p => `${p.phase}=${p.compatibilityMode}`).join(', ') : 'unknown'}; ${v.missing.length ? `missing ${v.missing.join(', ')}` : 'no declared evidence gaps; human review still required'}`).join('\n') + '\n\n'
      + `Fake tunnel: ${options.fake}. Fake runs never count as ChatGPT acceptance.\n\n`
      + 'These are Scenario verdicts, not final B09a acceptance. The initial five, both upgrade checks, onboarding evidence, any missing native records and Kun’s verdict remain explicit acceptance gates. The full human journey belongs to B09c.\n', { mode: 0o600 });
  };
  writeFileSync(join(dir, 'checklist.md'), checklist(scenarios, options.surface, options.count, options.model), { mode: 0o600 });
  save();
  let index = 0;
  let attempt: ChatGPTAttempt | undefined;
  let tunnel: TunnelLease | undefined;
  let finished = false;
  let cancelled = false;
  let monitoring = false;
  let fatal: Error | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let wake!: () => void;
  const stopRequested = new Promise<void>(resolve => { wake = resolve; });
  const fail = (error: unknown, action = 'driver-failure') => {
    fatal ??= error instanceof Error ? error : new Error(String(error));
    cancelled = true;
    try { attempt?.failure(action, fatal.message); } catch { /* cleanup must still run if evidence storage fails */ }
    wake();
  };
  const cancel = () => { cancelled = true; wake(); };
  const uncaught = (error: unknown) => fail(error, 'uncaught-exception');
  const rejected = (error: unknown) => fail(error, 'unhandled-rejection');
  const stopCurrent = async (outcome?: Completeness) => {
    if (timer) clearInterval(timer);
    const a = attempt; const t = tunnel;
    attempt = undefined; tunnel = undefined;
    try { await t?.stop(); }
    finally {
      if (a) {
        await a.stop(outcome);
        const item = batch.outcomes[index]!;
        item.completeness = a.record.run.completeness; item.detail = a.record.run.detail ?? ''; item.record = `${item.attemptId}/attempt.json`;
        batch.surfaces[options.surface] = 'attempted';
        save();
      }
    }
  };
  const startNext = async () => {
    const item = batch.outcomes[index];
    if (!item || cancelled || index >= options.ceiling) { finished = true; return; }
    try {
      tunnel = await acquireTunnel({ root: runRoot, dir, hostname: options.hostname, configPath: options.configPath, fake: options.fake });
      if (cancelled) return;
      attempt = await ChatGPTAttempt.start({ dir: join(dir, item.attemptId), batchId: options.batch, attemptId: item.attemptId,
        scenario: scenarios.find(s => s.id === item.scenario)!, surface: options.surface, model: options.model, commit, version });
      if (cancelled) return;
      await tunnel.start(attempt.relay.port);
      if (cancelled) return;
      const current = tunnel;
      const check = () => current.check(); // The lease shares concurrent inspections, including direct begin calls.
      attempt.relay.beforeForward = check;
      attempt.relay.onFailure = error => fail(error, 'relay-or-ownership-failure');
      timer = setInterval(() => {
        if (monitoring || tunnel !== current) return;
        monitoring = true;
        void check().catch(error => {
          if (tunnel !== current) return;
          fail(error, 'tunnel-ownership-lost');
        }).finally(() => { monitoring = false; });
      }, 1000);
      log(`Ready ${item.attemptId}; version=${attempt.record.service.version}; ${attempt.record.given[0]?.compatibilityMode}; servicePort=${attempt.servicePort}; relayPort=${attempt.relay.port}`);
      log(`Evidence: ${dir}\nRead checklist.md; commands: did <action>, begin [confirmed], end <capture.json>, upgrade, next, stop [completeness].`);
    } catch (error) {
      item.completeness = 'launch-failed'; item.detail = (error as Error).message;
      await stopCurrent('launch-failed'); save(); throw error;
    }
  };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('SIGHUP', cancel);
  process.on('uncaughtException', uncaught); process.on('unhandledRejection', rejected);
  try {
    await startNext();
    const iterator = input[Symbol.asyncIterator]();
    while (!cancelled && !finished) {
      const next = await Promise.race([iterator.next(), stopRequested.then(() => ({ done: true as const, value: '' }))]);
      if (next.done) break;
      const line = next.value;
      if (cancelled || finished) break;
      const [command, ...rest] = line.trim().split(/\s+/);
      const arg = rest.join(' ');
      try {
        if (command === 'begin') {
          try { await tunnel!.check(); } catch (error) { fail(error, 'tunnel-ownership-lost'); break; }
          log(`Send this Scenario message with the plugin mention:\n${await attempt!.begin(arg === 'confirmed')}`);
        }
        else if (command === 'end') { await attempt!.end(JSON.parse(readFileSync(resolve(arg), 'utf8')) as Capture); log('Turn captured; inspect raw/wire.json and continue the checklist.'); }
        else if (command === 'did') { attempt!.operator(arg); log(`Recorded operator action: ${arg}`); }
        else if (command === 'upgrade') { await attempt!.upgrade(); log('Canary restart complete; follow the old-chat/new-chat checklist before begin.'); }
        else if (command === 'next') { await stopCurrent(); index++; await startNext(); if (finished) break; }
        else if (command === 'stop') {
          if (arg && !(completeness as readonly string[]).includes(arg)) throw new Error('Unknown completeness');
          await stopCurrent(arg ? arg as Completeness : 'cancelled'); finished = true; break;
        } else if (command) throw new Error('Unknown command; read checklist.md');
      } catch (error) { if (!attempt) throw error; log(`Command refused: ${(error as Error).message}`); }
    }
  } finally {
    try {
      await stopCurrent(fatal ? 'driver-failed' : 'cancelled');
      batch.isolation.everydayAfter = everydayListener();
      batch.isolation.everydayUnchanged = unchangedListener(before, batch.isolation.everydayAfter);
      save();
      log(`Stopped; report: ${join(dir, 'report.md')}`);
    } finally {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); process.removeListener('SIGHUP', cancel);
      process.removeListener('uncaughtException', uncaught); process.removeListener('unhandledRejection', rejected);
    }
  }
  if (fatal) throw fatal;
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      batch: { type: 'string' }, scenarios: { type: 'string', default: initialFive.join(',') }, count: { type: 'string', default: '1' }, ceiling: { type: 'string', default: '5' },
      surface: { type: 'string', default: 'app' }, model: { type: 'string', default: 'UI-selected' }, approval: { type: 'string', default: '' },
      hostname: { type: 'string', default: '' }, config: { type: 'string', default: join(homedir(), '.cloudflared/config.yml') },
      'fake-tunnel': { type: 'boolean', default: false },
    } });
    if (positionals.length !== 1 || !['plan', 'run'].includes(positionals[0]!)) throw new Error('Usage: node tests/behaviour/chatgpt/run.ts plan|run [--batch ID --approval REF --hostname HOST]');
    if (!['app', 'web', 'mobile'].includes(values.surface!)) throw new Error('surface must be app, web or mobile');
    const scenarios = selectScenarios(values.scenarios!.split(','));
    console.log(checklist(scenarios, values.surface!, Number(values.count), values.model!));
    if (positionals[0] === 'run') {
      if (values['fake-tunnel'] && values.config === join(homedir(), '.cloudflared/config.yml')) throw new Error('Fake mode requires an explicit fixture --config');
      const rl = createInterface({ input: process.stdin, terminal: false });
      const close = () => rl.close();
      process.on('SIGINT', close); process.on('SIGTERM', close); process.on('SIGHUP', close);
      try {
        await runBatch({ batch: values.batch ?? '', scenarios: scenarios.map(s => s.id), count: Number(values.count), ceiling: Number(values.ceiling),
          surface: values.surface as ChatGPTSurface, model: values.model!, approval: values.approval!, hostname: values.hostname!, configPath: values.config!, fake: values['fake-tunnel']! }, rl);
      } finally { rl.close(); process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); process.removeListener('SIGHUP', close); }
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
