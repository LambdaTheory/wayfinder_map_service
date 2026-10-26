// Seatbelt policy for a prepared Attempt. Grants are capabilities of this layout, never exceptions to a
// blacklist of personal paths. Control/staging directories are minted here; callers cannot nominate one.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { proxyRouting } from '../proxy.ts';
import { localNetworkDenials } from './network-policy.ts';
import { reservedPorts } from './service.ts';

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
function fileHash(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new IsolationError('immutable file must be regular with one link');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  for (const file of mutableFiles) {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new IsolationError('mutable read-only file must be regular with one link');
  }
  for (const path of new Set([...roots, ...mutableFiles].flatMap(p => [p, ...parents(p)]))) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() && !stat.isFile()) throw new IsolationError('protected entry replaced or linked');
    out[path] = `${stat.isDirectory() ? 'directory' : 'file'}:${stat.dev}:${stat.ino}`;
  }
  return out;
}
const hashes = (p: Pick<ControlProfile, 'path' | 'readOnlyRoots'>) => ({ ...treeHashes(p.readOnlyRoots), [p.path]: fileHash(p.path) });

interface Policy {
  home: string; workdir: string; readRoots: string[]; readFiles: string[];
  denyRoots: string[]; denyEntries: string[]; localPorts: number[]; proxyRules: string[]; controlDirectories: string[];
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
    ...localNetworkDenials,
    ...p.proxyRules,
    ...p.localPorts.map(port => `(allow network-outbound (remote tcp4 "localhost:${port}"))`),
    ...reservedPorts.map(port => `(deny network-outbound (remote ip "localhost:${port}"))`), ''].join('\n');
}

/** All grants, including Node and the client, go through the same canonical allowlist. */
export function writeProfile(controlDir: string, session: { home: string }, workdir: string, bin: string, access: SandboxAccess = {}): ControlProfile {
  try {
    const proxies = proxyRouting(access.proxyEnv ?? {});
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
    const denyRoots = [...readRoots, ...(access.denyWriteRoots ?? []).map(p => realpathSync(p)), ...controls];
    const entries = [home, workdir, executable, ...readRoots, ...mutable, ...(access.denyWritePaths ?? []).map(p => realpathSync(p)), ...denyRoots];
    const pinnedRoots = [...new Set(entries)];
    const expectedIdentities = Object.freeze(identities(pinnedRoots, mutable));
    const immutableHashes = treeHashes(readOnlyRoots); // Validate before reserving the exclusive profile path.
    const path = join(layout.controlDir, `${basename(home)}.sb`);
    writeFileSync(path, sandboxProfile({ home, workdir, readRoots, readFiles: [executable, ...mutable], denyRoots,
      denyEntries: Object.keys(expectedIdentities), controlDirectories: controls, localPorts: access.localPorts ?? [], proxyRules: proxies.rules }), { flag: 'wx', mode: 0o600 });
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
