// Seatbelt policy for a prepared Attempt. Grants are capabilities of this layout, never exceptions to a
// blacklist of personal paths. Control/staging directories are minted here; callers cannot nominate one.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { proxyRouting } from '../proxy.ts';
import { localNetworkDenials } from './network-policy.ts';
import { reserveProxyPorts, reservedPorts } from './network-ports.ts';

import type { ProxyPermit } from './network-ports.ts';

export class IsolationError extends Error {
  constructor(message: string) { super(`isolation failure: ${message}`); this.name = 'IsolationError'; }
}
export interface SandboxAccess {
  readOnlyRoots?: string[];
  mutableReadOnlyFiles?: string[];
  denyWriteRoots?: string[];
  denyWritePaths?: string[];
  localPorts?: number[];
  /** Explicit proxy input; never load personal settings inside the sandbox API. */
  proxyEnv?: NodeJS.ProcessEnv;
  /** Opaque capability for this controller-owned forwarding listener; reviewers never use it. */
  proxyPermit?: ProxyPermit;
  /** Additional protected endpoints known to a caller in another controller process. */
  protectedPorts?: readonly number[];
}
export interface SandboxLayout { readonly scratch: string; readonly controlDir: string; readonly readOnlyDir: string }
const layouts = new Map<string, SandboxLayout>();
const contains = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('../')); };
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
const parents = (path: string): string[] => { const out: string[] = []; for (let p = dirname(path);; p = dirname(p)) { out.push(p); if (dirname(p) === p) return out; } };
const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const resolveBin = (bin: string) => realpathSync(bin.includes('/') ? bin : spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim());
const nodeDirectory = realpathSync(dirname(realpathSync(process.execPath)));
// Only the actual installed Codex is an external client installation. Custom stand-ins are staged below.
let installedCodex: string | undefined;
try { installedCodex = resolveBin('codex'); } catch { /* A fake driver needs no Codex installation. */ }
const installationRoots = [nodeDirectory];
if (installedCodex) {
  let clientRoot = dirname(installedCodex);
  // npm's launcher lives in bin/, but its verified package root is the installation (not node_modules/).
  const candidate = dirname(clientRoot);
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
    if (manifest.name === '@openai/codex' && resolveBin(join(candidate, manifest.bin.codex)) === installedCodex) {
      clientRoot = realpathSync(candidate);
      const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
      if (manifest.optionalDependencies?.[platformPackage]) {
        const dependency = createRequire(installedCodex).resolve(`${platformPackage}/package.json`);
        installationRoots.push(realpathSync(dirname(dependency)));
      }
    }
  } catch { /* A native executable needs only its actual directory; no speculative parent grant. */ }
  installationRoots.push(clientRoot);
}
// OS executables, libraries and TLS/DNS data; no generic /System, /Library, /usr, /var or /etc grant.
const systemDirectories = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/System/Library',
  '/System/Volumes/Preboot/Cryptexes/OS/usr/lib', '/System/Volumes/Preboot/Cryptexes/OS/System/Library', '/private/etc/ssl'];
const systemFiles = ['/', '/dev/tty', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/etc/localtime'];

export function prepareSandbox(scratch: string): SandboxLayout {
  scratch = realpathSync(scratch);
  if ([...layouts.values()].filter(s => existsSync(s.controlDir)).some(s => contains(s.controlDir, scratch) || contains(s.readOnlyDir, scratch)
    || (s.scratch !== scratch && overlaps(s.scratch, scratch))))
    throw new IsolationError('Attempt scratch overlaps a prepared control or staging directory');
  const controlDir = mkdtempSync(join(dirname(scratch), 'wf-behave-control-'));
  const readOnlyDir = mkdtempSync(join(scratch, 'read-only-'));
  const layout = Object.freeze({ scratch, controlDir, readOnlyDir });
  layouts.set(controlDir, layout);
  return layout;
}
function layoutFor(controlDir: string): SandboxLayout {
  const layout = layouts.get(realpathSync(controlDir));
  if (!layout) throw new IsolationError('control directory was not prepared for an Attempt');
  return layout;
}

/** A custom executable is copied alone, never with its parent directory or unrelated neighboring files. */
export function prepareClient(controlDir: string, bin: string): string {
  const layout = layoutFor(controlDir);
  const source = resolveBin(bin);
  if (source === installedCodex || systemDirectories.slice(0, 4).some(p => contains(p, source))
    || (contains(layout.readOnlyDir, source) && dirname(source) !== layout.readOnlyDir)) return source;
  if (!lstatSync(source).isFile()) throw new IsolationError('client executable is not a regular file');
  const dir = join(layout.readOnlyDir, 'client'); mkdirSync(dir, { mode: 0o700 });
  const target = join(dir, basename(source)); copyFileSync(source, target); chmodSync(target, 0o700);
  return target;
}

export interface ControlProfile {
  path: string;
  hashes: Readonly<Record<string, string>>;
  readOnlyRoots: string[];
  mutableReadOnlyFiles: string[];
  identities: Readonly<Record<string, string>>;
  pinnedRoots: string[];
  proxyEnvironment: Readonly<Record<string, string>>;
}
/** One filesystem boundary for policy verification and safe native-evidence collection. */
export function entryIdentity(path: string, kind?: 'file' | 'directory'): string {
  const stat = lstatSync(path, { bigint: true });
  if ((!stat.isDirectory() && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())
    || (kind === 'file' && (!stat.isFile() || stat.nlink !== 1n)))
    throw new IsolationError('protected entry must have its expected type; regular files require one link');
  return `${stat.isDirectory() ? 'directory' : 'file'}:${stat.dev}:${stat.ino}:${stat.mode}`;
}
export function readRegularFile(path: string): Buffer {
  entryIdentity(path, 'file');
  return readFileSync(path);
}
/** Read a runner-written file only after validating its previously pinned containing directories. */
export function readPinnedFile(path: string, pinned: Readonly<Record<string, string>>): Buffer {
  for (const parent of parents(path)) {
    if (pinned[parent] !== entryIdentity(parent, 'directory')) throw new IsolationError('runner evidence parent changed or unpinned');
  }
  return readRegularFile(path);
}
export const hashContents = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function fileHash(path: string): string {
  return hashContents(readRegularFile(path));
}
function treeHashes(roots: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new IsolationError('immutable roots must not contain symlinks');
    if (stat.isDirectory()) { result[path] = 'directory'; for (const name of readdirSync(path).sort()) visit(join(path, name)); }
    else result[path] = fileHash(path);
  };
  roots.forEach(visit);
  return result;
}
function identities(roots: string[], mutableFiles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of mutableFiles) entryIdentity(file, 'file');
  for (const path of new Set([...roots, ...mutableFiles].flatMap(p => [p, ...parents(p)]))) {
    out[path] = entryIdentity(path);
  }
  return out;
}
const hashes = (p: Pick<ControlProfile, 'path' | 'readOnlyRoots'>) => ({ ...treeHashes(p.readOnlyRoots), [p.path]: fileHash(p.path) });

/** Resolve existing symlinks before appending absent components. Denials never grant read access. */
function canonicalDenial(path: string): string {
  if (!isAbsolute(path)) throw new IsolationError('deny-only path must be absolute');
  let current = '/'; let links = 0;
  const pending = path.split('/');
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    const stat = lstatSync(next, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      if (++links > 40) throw new IsolationError('deny-only path contains a symlink loop');
      const target = readlinkSync(next);
      if (isAbsolute(target)) current = '/';
      pending.unshift(...target.split('/'));
    } else {
      if (stat && !stat.isDirectory() && pending.some(p => p !== '' && p !== '.'))
        throw new IsolationError('deny-only ancestor is not a directory');
      current = next;
    }
  }
  return current;
}

interface Policy {
  home: string; workdir: string; readRoots: string[]; readFiles: string[];
  denyRoots: string[]; denyEntries: string[]; localPorts: number[]; proxyRules: string[]; controlDirectories: string[]; proxyOnly: boolean;
}
function sandboxProfile(p: Policy): string {
  const q = JSON.stringify;
  return ['(version 1)', '(allow default)', '(deny file-read*)', '(allow file-read-metadata)',
    ...[...systemDirectories, ...p.readRoots, p.home, p.workdir].map(root => `(allow file-read* (subpath ${q(root)}))`),
    ...[...systemFiles, ...p.readFiles].map(file => `(allow file-read* (literal ${q(file)}))`),
    '(deny file-write*)', `(allow file-write* (subpath ${q(p.home)}) (subpath ${q(p.workdir)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    // Descriptor aliases duplicate only descriptors the client already holds.
    '(allow file-read* file-write* (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
    // Seatbelt issues a per-sandbox extension for newly allocated slave ptys, never for arbitrary peers.
    '(allow pseudo-tty)', '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    '(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))',
    // Do not let the client queue commands for its unsandboxed operator shell (including inherited fd 0).
    '(deny file-ioctl (ioctl-command TIOCSTI))',
    ...p.denyRoots.map(root => `(deny file-write* (subpath ${q(root)}))`),
    ...p.denyEntries.map(path => `(deny file-write* (literal ${q(path)}))`),
    ...p.controlDirectories.map(root => `(deny file-read* (subpath ${q(root)}))`),
    // A deny filtered by "others" leaves same-session processes accessible in an attached launch.
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))', '(deny process-info*)', '(allow process-info* (target self) (target same-sandbox))',
    '(deny mach-task-name)', '(allow mach-task-name (target self) (target same-sandbox))',
    '(deny signal)', '(allow signal (target self) (target same-sandbox))',
    ...(p.proxyOnly ? ['(deny network-outbound)'] : []),
    ...localNetworkDenials,
    ...p.proxyRules,
    ...p.localPorts.map(port => `(allow network-outbound (remote tcp4 "localhost:${port}"))`),
    ...reservedPorts.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`), ''].join('\n');
}

/** All grants, including Node and the client, go through the same canonical allowlist. */
export function writeProfile(controlDir: string, session: { home: string }, workdir: string, bin: string, access: SandboxAccess = {}): ControlProfile {
  try {
    const proxies = proxyRouting(access.proxyEnv ?? {}, [...(access.localPorts ?? []), ...(access.protectedPorts ?? [])], access.proxyPermit);
    const layout = layoutFor(controlDir);
    if (!lstatSync(session.home).isDirectory()) throw new IsolationError('session HOME must be a real directory');
    if (!lstatSync(workdir).isDirectory()) throw new IsolationError('workdir must be a real directory inside this Attempt');
    const home = realpathSync(session.home); workdir = realpathSync(workdir);
    if (!contains(layout.scratch, home) || workdir !== join(layout.scratch, 'work') || overlaps(home, workdir)
      || overlaps(home, layout.readOnlyDir) || overlaps(workdir, layout.readOnlyDir)) throw new IsolationError('HOME/workdir do not belong to this Attempt');
    const controls = [...layouts.keys()].filter(p => existsSync(p));
    for (const root of installationRoots) {
      if ([...layouts.values()].filter(s => existsSync(s.controlDir)).some(s => [s.scratch, s.controlDir].some(p => overlaps(root, p))))
        throw new IsolationError('installation directory overlaps an Attempt');
    }
    const allowed = [home, workdir, layout.readOnlyDir, ...installationRoots];
    const grant = (path: string) => {
      const canonical = realpathSync(path);
      if (canonical === layout.readOnlyDir || !allowed.some(root => contains(root, canonical)) || controls.some(root => overlaps(root, canonical)))
        throw new IsolationError('read grant is outside this Attempt or its exact installations');
      return canonical;
    };
    const executable = resolveBin(bin);
    const systemBinary = systemDirectories.slice(0, 4).some(p => contains(p, executable));
    if (!systemBinary) grant(executable);
    // A staged program may load only its staged neighbors; a program in HOME/work needs no new grant.
    const clientRoot = contains(layout.readOnlyDir, executable) ? dirname(executable) : undefined;
    const immutable = (access.readOnlyRoots ?? []).map(grant);
    const mutable = (access.mutableReadOnlyFiles ?? []).map(grant);
    if (mutable.some(file => [...immutable, ...(clientRoot ? [clientRoot] : [])].some(root => contains(root, file))))
      throw new IsolationError('mutable files must be outside immutable trees');
    const readRoots = [...new Set([...installationRoots, ...immutable, ...(clientRoot ? [clientRoot] : [])].map(grant))];
    const readOnlyRoots = [...new Set([...immutable, ...(clientRoot ? [clientRoot] : []), ...(!systemBinary && executable !== installedCodex ? [executable] : [])])];
    const denyRoots = [...readRoots, ...(access.denyWriteRoots ?? []).map(canonicalDenial), ...controls];
    const entries = [home, workdir, executable, ...readRoots, ...mutable, ...(access.denyWritePaths ?? []).map(canonicalDenial), ...denyRoots];
    // Absent entries remain in the policy. Pin their existing ancestors; creation by trusted setup
    // is valid, while the client cannot replace any directory entry along the future denied path.
    const denyEntries = [...new Set(entries.flatMap(p => [p, ...parents(p)]))];
    const pinnedRoots = denyEntries.filter(p => lstatSync(p, { throwIfNoEntry: false }));
    const expectedIdentities = Object.freeze(identities(pinnedRoots, mutable));
    const immutableHashes = treeHashes(readOnlyRoots); // Validate before reserving the exclusive profile path.
    reserveProxyPorts(layout.controlDir, proxies.ports, access.proxyPermit);
    const path = join(layout.controlDir, `${basename(home)}.sb`);
    writeFileSync(path, sandboxProfile({ home, workdir, readRoots, readFiles: [executable, ...mutable], denyRoots,
      denyEntries, controlDirectories: controls, localPorts: access.localPorts ?? [], proxyRules: proxies.rules, proxyOnly: !!access.proxyPermit && proxies.ports.length > 0 }), { flag: 'wx', mode: 0o600 });
    const profile = { path, readOnlyRoots, mutableReadOnlyFiles: mutable, pinnedRoots, identities: expectedIdentities, proxyEnvironment: Object.freeze(proxies.environment) };
    return { ...profile, hashes: Object.freeze({ ...immutableHashes, [path]: fileHash(path) }) };
  } catch (error) { if (error instanceof IsolationError) throw error; throw new IsolationError(`cannot prepare sandbox: ${String(error)}`); }
}

export function verifyProfile(profile: ControlProfile): string | null {
  try {
    if (!same(identities(profile.pinnedRoots, profile.mutableReadOnlyFiles), profile.identities)) throw new IsolationError('protected file or parent replaced');
    if (!same(hashes(profile), profile.hashes)) throw new IsolationError('runner control files changed');
    return null;
  } catch (error) { return error instanceof IsolationError ? error.message : new IsolationError('runner control files missing or replaced').message; }
}
