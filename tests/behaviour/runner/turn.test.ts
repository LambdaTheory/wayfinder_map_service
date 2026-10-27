// Real child pipes, controlled deadline delivery; no service, model or personal state.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as processes from 'node:child_process';
import { afterAll, expect, test, vi } from 'vitest';
import { executeTurn, prepareClient, prepareSandbox, prepareSession, writeProfile } from './codex.ts';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

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
  let exited = false;
  const notifications: (() => void)[] = [];
  const spawning = vi.mocked(processes.spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    const pipes = [child.stdout!, child.stderr!];
    const deliver = () => {
      if (expired || !exited || notifications.length !== 2) return;
      expired = true;
      // Both real pipes have drained. Hold just their close notifications so the
      // parent's close handler cannot cancel the watchdog before we deliver it.
      queueMicrotask(() => {
        vi.advanceTimersByTime(251);
        setImmediate(() => notifications.forEach(notify => notify()));
      });
    };
    for (const pipe of pipes) {
      const emit = pipe.emit.bind(pipe);
      vi.spyOn(pipe, 'emit').mockImplementation((event, ...values) => {
        if (event !== 'close') return emit(event, ...values);
        notifications.push(() => emit(event, ...values));
        deliver();
        return true;
      });
    }
    child.once('exit', () => { exited = true; deliver(); });
    return child;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = await executeTurn({ options: { model: 'fake', effort: 'low', bin, sandbox: false, timeoutMs: 10_000 },
      session, workdir, profile, prompt: '' }, bin, ['-e', `console.log(JSON.stringify({type:'turn.started'})); process.stdout.write('x'.repeat(${size}));`],
    { PATH: process.env.PATH, HOME: session.home });
    expect(expired).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('{"type":"turn.started"}\n' + 'x'.repeat(size));
    expect(result.postIsolationFailure).toBeUndefined();
  } finally { spawning.mockRestore(); vi.useRealTimers(); }
}, 10_000);
