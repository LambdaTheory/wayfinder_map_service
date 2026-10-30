// Local operator handoff. The browser receives its capability over inherited
// anonymous pipes, never argv, environment, stdout, clipboard or an HTML file.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { assertPrivateFileParent, makePrivateDirectory } from './private-paths.js';

export function windowsBrowserExecutable(): string {
  const paths = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData/Local'), 'Google/Chrome/Application/chrome.exe'),
  ];
  const path = paths.find(existsSync);
  if (!path) throw Error('Install Chrome for the Windows Answer Desk');
  return path;
}

export async function openWindowsDesk(input: { port: number; mapId: string; keyPath: string; profile: string; headless?: boolean }) {
  if (process.platform !== 'win32' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.mapId)) throw Error('Invalid local desk configuration');
  assertPrivateFileParent(input.keyPath);
  const key = readFileSync(input.keyPath, 'utf8');
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error('Answer Desk key unavailable; start the service first');
  makePrivateDirectory(input.profile);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('WAYFINDER_')));
  // A normal Chrome window may initially be covered by the invoking app.
  // Keep its active tab visible to Chromium so the viewer can consume and
  // strip the capability immediately, without waiting for native focus.
  const args = ['--remote-debugging-pipe', `--user-data-dir=${input.profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-features=Translate,MediaRouter', '--disable-backgrounding-occluded-windows',
    '--no-startup-window', ...(input.headless ? ['--headless=new'] : [])];
  // The helper stays hidden, but the interactive browser must be shown. A
  // hidden startup window leaves document.hidden true and pauses viewer polls.
  const child = spawn(windowsBrowserExecutable(), args, { env, windowsHide: input.headless === true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writer = child.stdio[3] as Duplex; const reader = child.stdio[4] as Duplex;
  let counter = 0; let buffer = ''; let closed = false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const closedPromise = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  function fail() {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Local browser pipe closed')); }
    pending.clear();
  }
  child.on('error', fail); child.on('close', fail); writer.on('error', fail); reader.on('error', fail);
  reader.on('data', data => {
    buffer += data.toString('utf8');
    for (let end; (end = buffer.indexOf('\0')) !== -1;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line); const p = pending.get(reply.id);
        if (!p) continue;
        pending.delete(reply.id); clearTimeout(p.timer);
        if (reply.error) p.reject(Error('Local browser refused the desk handoff')); else p.resolve(reply.result);
      } catch { fail(); }
    }
  });
  const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    if (closed) { reject(Error('Local browser closed')); return; }
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Local browser handoff timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  try {
    const target = await call('Target.createTarget', { url: `http://127.0.0.1:${input.port}/maps/${input.mapId}#key=${key}`, newWindow: true });
    await call('Target.activateTarget', { targetId: target.targetId });
    return { child, args, targetId: target.targetId as string, call, closed: closedPromise,
      async close() { if (!closed) { try { await call('Browser.close'); } catch { child.kill(); } } await closedPromise; } };
  } catch { child.kill(); await closedPromise; throw Error('Windows browser handoff failed; no key was printed'); }
}
