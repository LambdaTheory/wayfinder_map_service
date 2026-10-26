// Real child pipes, controlled deadline delivery; no service, model or personal state.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, test, vi } from 'vitest';
import { executeTurn, prepareClient, prepareSandbox, prepareSession, writeProfile } from './codex.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-turn-drain-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.each([0, 256 * 1024])('an overdue drain timer cannot misclassify normal exit (%i bytes)', async size => {
  const scratch = mkdtempSync(join(root, 'attempt-'));
  const session = prepareSession(scratch, 'A', 'synthetic', null);
  const workdir = join(scratch, 'work'); mkdirSync(workdir);
  const { controlDir } = prepareSandbox(scratch);
  const bin = prepareClient(controlDir, process.execPath);
  const profile = writeProfile(controlDir, session, workdir, bin);
  let expired = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = await executeTurn({ options: { model: 'fake', effort: 'low', bin, sandbox: false, timeoutMs: 10_000 },
      session, workdir, profile, prompt: '', onExit: () => {
        if (expired) return; expired = true;
        // A busy parent can deliver an expired timer before queued pipe EOF/close callbacks.
        queueMicrotask(() => vi.advanceTimersByTime(251));
      } }, bin, ['-e', `console.log(JSON.stringify({type:'turn.started'})); process.stdout.write('x'.repeat(${size}));`],
    { PATH: process.env.PATH, HOME: session.home });
    expect(expired).toBe(true);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"type":"turn.started"}\n' + 'x'.repeat(size));
    expect(result.postIsolationFailure).toBeUndefined();
  } finally { vi.useRealTimers(); }
}, 10_000);
