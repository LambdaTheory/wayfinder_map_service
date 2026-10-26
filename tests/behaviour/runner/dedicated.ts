// The real Dedicated launcher is trusted setup. Everything it executes or uses as policy is runner-owned.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { clientSkills, executeTurn, findRollout, loginSecrets } from './codex.ts';
import type { CodexOptions, CodexSession, TurnRequest } from './codex.ts';
import { readRollout, shown } from './normalize.ts';
import { checkoutRoot, reservedPorts } from './service.ts';
import type { Credential, IsolatedService } from './service.ts';

export const dedicatedLauncher = join(checkoutRoot, 'scripts/wayfinder-agent/wayfinder');
export const dedicatedLauncherSource = relative(checkoutRoot, dedicatedLauncher);
const python = '/usr/bin/python3';
export class IsolationFailure extends Error {
  constructor(reason: string) { super(`isolation failure: ${reason}`); }
}

export function dedicatedServiceDirectory(): string {
  const root = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(root, 'dedicated-')));
}

const hash = (text: Buffer | string) => createHash('sha256').update(text).digest('hex');
/** lstat before reading: a substituted symlink must never disclose its target through evidence collection. */
function identity(path: string, kind: 'file' | 'directory', content = false): string {
  const info = lstatSync(path);
  if ((kind === 'file' ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) || info.isSymbolicLink())
    throw new IsolationFailure(`unexpected ${kind} type`);
  return JSON.stringify([info.dev, info.ino, info.mode, content ? hash(readFileSync(path)) : null]);
}
function pin(path: string, kind: 'file' | 'directory', content = false): () => void {
  const before = identity(path, kind, content);
  return () => {
    try { if (identity(path, kind, content) === before) return; } catch { /* same safe refusal */ }
    throw new IsolationFailure(`changed runner-owned ${kind}`);
  };
}
function tree(root: string): string {
  const visit = (path: string): unknown => {
    const info = lstatSync(path);
    if (info.isDirectory()) return [identity(path, 'directory'), readdirSync(path).sort().map(name => [name, visit(join(path, name))])];
    return identity(path, 'file', true);
  };
  return JSON.stringify(visit(root));
}

interface LaunchEvidence {
  token: string;
  clientId: string;
  argv: string[];
  home: string;
  codexHome: string;
  overrides: Record<string, string>;
}
export interface DedicatedSetup {
  env: NodeJS.ProcessEnv;
  capturePath: string;
  state: string;
  skill: string;
  outputs: string;
  control: string;
  launcherHome: string;
  profile: string;
  codexHome: string;
  sourceAuth: string;
  verify(): void;
  /** Runtime-independent copies survive failures and cleanup; never contain tokens. */
  controlEvidence: { profile: string; shim: string; manifest: string };
}

export function prepareDedicated(scratch: string, session: CodexSession, service: IsolatedService,
  controller: Credential, options: CodexOptions, baseProfile: string): DedicatedSetup {
  if (!options.sandbox) throw new IsolationFailure('Dedicated Entry requires the allowlist sandbox');
  if (reservedPorts.includes(service.port)) throw new IsolationFailure('Dedicated Entry refuses an everyday port');
  const serviceDir = dirname(service.protocolReport);
  const control = join(serviceDir, 'control');
  const launcherHome = join(serviceDir, 'launcher-home');
  const sourceAuth = join(launcherHome, '.codex/auth.json');
  mkdirSync(dirname(sourceAuth), { recursive: true, mode: 0o700 });
  copyFileSync(join(session.codexHome, 'auth.json'), sourceAuth);
  const root = join(session.home, 'dedicated');
  const state = join(root, '.codex-wayfinder');
  const stateHome = join(state, 'home');
  const skills = join(stateHome, '.agents/skills');
  mkdirSync(skills, { recursive: true, mode: 0o700 });
  const checkout = join(control, 'launcher-checkout');
  const skill = join(checkout, '.agents/skills/wayfinder');
  const outputs = join(scratch, 'outputs');
  for (const method of ['mcp', 'matt']) mkdirSync(join(outputs, method), { recursive: true, mode: 0o700 });
  // The projection has no dist/, and the client cannot add one. Lost service => refusal, never a daemon.
  cpSync(join(checkoutRoot, '.agents/skills/wayfinder'), skill, { recursive: true, dereference: true });
  writeFileSync(join(serviceDir, 'wayfinder-token'), controller.token + '\n', { mode: 0o600 });
  const capturePath = join(serviceDir, 'codex-launch.json');
  const shimDir = join(control, 'launcher-bin');
  mkdirSync(shimDir, { mode: 0o700 });
  const resolved = options.bin.includes('/') ? options.bin : spawnSync('which', [options.bin], { encoding: 'utf8' }).stdout.trim();
  const binary = realpathSync(resolved);
  const profile = join(control, 'sandbox.sb');
  const protectedDirectories = [scratch, session.home, root, state, stateHome, join(stateHome, '.agents'), skills, outputs, join(outputs, 'mcp'), join(outputs, 'matt')];
  const protectedTrees = [serviceDir, join(state, 'AGENTS.md'), join(state, 'config.toml'), join(stateHome, '.agents')];
  // This extends the shared profile; #94's shared per-session writer will own these options after integration.
  writeFileSync(profile, readFileSync(baseProfile, 'utf8') + `\n(allow file-read* (subpath ${JSON.stringify(skill)}) (literal ${JSON.stringify(sourceAuth)}))\n`
    + `(deny file-write* ${protectedTrees.map(p => `(subpath ${JSON.stringify(p)})`).join(' ')}\n`
    + `${[...protectedDirectories, binary].map(p => `(literal ${JSON.stringify(p)})`).join(' ')})\n`, { mode: 0o600 });
  rmSync(baseProfile, { force: true });
  const command = ['/usr/bin/sandbox-exec', '-f', profile, binary];
  const expected = { home: stateHome, codexHome: state, url: `mcp_servers.wayfinder.url="http://127.0.0.1:${service.port}/mcp"` };
  const constants = JSON.stringify({ command, capturePath, serviceDir, expected, path: process.env.PATH ?? '/usr/bin:/bin' });
  const shim = `#!${python} -I
import hashlib, json, os, sys
from pathlib import Path
settings = json.loads(${JSON.stringify(constants)})
env = dict(os.environ)
token = env.get("WAYFINDER_TOKEN")
if token:
    expected = settings["expected"]
    if env.get("HOME") != expected["home"] or env.get("CODEX_HOME") != expected["codexHome"] or expected["url"] not in sys.argv:
        sys.exit("isolation failure: unexpected launcher HOME, CODEX_HOME or MCP URL")
    sha = hashlib.sha256(token.encode()).hexdigest()
    owners = json.loads((Path(settings["serviceDir"]) / "credential-owners.json").read_text())
    if sha not in owners:
        sys.exit("isolation failure: Dedicated Entry refused a fallback primary credential")
    record = {"token": token, "clientId": owners[sha]["clientId"], "argv": sys.argv[1:],
              "home": env["HOME"], "codexHome": env["CODEX_HOME"],
              "overrides": {k: v for k, v in env.items() if k.startswith("WAYFINDER_AGENT_")}}
    fd = os.open(settings["capturePath"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(record, handle)
env = {k: v for k, v in env.items() if not k.startswith("WAYFINDER_AGENT_")}
env["PATH"] = settings["path"]
command = settings["command"] + sys.argv[1:]
os.execvpe(command[0], command, env)
`;
  writeFileSync(join(shimDir, 'codex'), shim, { mode: 0o700 });
  const manifest = tree(control);
  const guards = [pin(serviceDir, 'directory'), pin(control, 'directory'), pin(launcherHome, 'directory'),
    pin(dirname(sourceAuth), 'directory'), pin(sourceAuth, 'file'),
    ...protectedDirectories.map(p => pin(p, 'directory')),
    ...[dedicatedLauncher, join(dirname(dedicatedLauncher), 'config.toml'), join(dirname(dedicatedLauncher), 'agent-instructions.md'), binary]
      .map(p => pin(p, 'file', true))];
  const installedFiles = new Map<string, string>();
  const expectedFiles: Record<string, string> = {
    'AGENTS.md': readFileSync(join(dirname(dedicatedLauncher), 'agent-instructions.md'), 'utf8')
      .replaceAll('@WORK@', join(outputs, 'mcp')).replaceAll('@RELAUNCH@', 'wayfinder'),
    'config.toml': readFileSync(join(dirname(dedicatedLauncher), 'config.toml'), 'utf8').replaceAll('@WORK@', join(outputs, 'mcp')),
  };
  const verify = () => {
    guards.forEach(check => check());
    if (tree(control) !== manifest) throw new IsolationFailure('changed launcher control tree');
    // The launcher writes through these paths outside the sandbox. No substituted links or hardlinks.
    for (const file of ['AGENTS.md', 'config.toml']) {
      const path = join(state, file);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        const current = identity(path, 'file', true);
        if (hash(readFileSync(path)) !== hash(expectedFiles[file]!) || (installedFiles.has(file) && installedFiles.get(file) !== current))
          throw new IsolationFailure('changed launcher-installed context');
        installedFiles.set(file, current);
      } else if (installedFiles.has(file)) throw new IsolationFailure('removed launcher-installed context');
    }
    for (const dir of [join(stateHome, '.agents'), skills]) identity(dir, 'directory');
    const ownAuth = join(state, 'auth.json');
    const info = lstatSync(ownAuth, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      if (readlinkSync(ownAuth) !== sourceAuth) throw new IsolationFailure('changed native auth link target');
    } else if (info) identity(ownAuth, 'file'); // A native atomic refresh may replace the link with a regular file.
  };
  return { state, skill, outputs, capturePath, control, launcherHome, profile, codexHome: state, sourceAuth, verify,
    controlEvidence: { profile: readFileSync(profile, 'utf8'), shim, manifest }, env: {
      PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: launcherHome, TMPDIR: join(session.home, 'tmp'), LANG: 'en_US.UTF-8',
      WAYFINDER_AGENT_STATE_ROOT: root, WAYFINDER_AGENT_SERVICE_DIR: serviceDir, WAYFINDER_AGENT_OUTPUTS: outputs,
      WAYFINDER_AGENT_PORT: String(service.port), WAYFINDER_AGENT_DATABASE: service.databasePath,
      WAYFINDER_AGENT_CHECKOUT: checkout, WAYFINDER_AGENT_USAGE: 'test',
    } };
}

export async function runDedicatedTurn(request: TurnRequest, setup: DedicatedSetup) {
  setup.verify();
  rmSync(setup.capturePath, { force: true });
  const { options: o, session: s } = request;
  const exec = s.thread ? ['exec', 'resume', '--json', '--skip-git-repo-check', s.thread, '-']
    : ['exec', '--json', '--skip-git-repo-check', '-'];
  // -I prevents Python importing a client-planted module from cwd or HOME; neither interpreter uses PATH.
  return executeTurn(request, python,
    ['-I', dedicatedLauncher, '--harness', 'codex', '--method', 'mcp', '--model', o.model, '--effort', o.effort, '--', ...exec], setup.env);
}

export function dedicatedLaunch(setup: DedicatedSetup): LaunchEvidence | null {
  return existsSync(setup.capturePath) ? JSON.parse(readFileSync(setup.capturePath, 'utf8')) as LaunchEvidence : null;
}

export function dedicatedLoginSecrets(setup: DedicatedSetup, session: CodexSession): string[] {
  setup.verify();
  return [...loginSecrets(session), ...loginSecrets({ ...session, codexHome: dirname(setup.sourceAuth) })];
}

/** Native evidence is client-controlled data, never an authority to follow arbitrary filesystem links. */
export function dedicatedRollout(setup: DedicatedSetup, session: CodexSession) {
  setup.verify();
  const sessions = join(session.codexHome, 'sessions');
  if (!lstatSync(sessions, { throwIfNoEntry: false })) return null;
  identity(sessions, 'directory');
  const path = findRollout(session);
  if (!path) return null;
  identity(path, 'file');
  return readRollout(path);
}
export function dedicatedClientSkills(setup: DedicatedSetup, session: CodexSession): string[] {
  setup.verify();
  const root = join(session.codexHome, 'skills');
  if (lstatSync(root, { throwIfNoEntry: false })) identity(root, 'directory');
  return clientSkills(session);
}

/** Installation is observed through the actual launcher-created link, never inferred from the staged copy. */
export function dedicatedContext(setup: DedicatedSetup, rollout: string | undefined) {
  const link = join(setup.state, 'home/.agents/skills/wayfinder');
  const installedSkill = () => {
    const info = lstatSync(link, { throwIfNoEntry: false });
    return info?.isSymbolicLink() && readlinkSync(link) === setup.skill;
  };
  return [
    ['scripts/wayfinder-agent/agent-instructions.md', join(setup.state, 'AGENTS.md'), false],
    ['.agents/skills/wayfinder/SKILL.md', join(link, 'SKILL.md'), true],
    ['scripts/wayfinder-agent/config.toml', join(setup.state, 'config.toml'), false],
    ['.agents/skills/wayfinder/agents/openai.yaml', join(link, 'agents/openai.yaml'), true],
  ].map(([source, path, isSkill]) => {
    let content: string | null = null; let reason: string | null = null;
    try {
      setup.verify();
      if (isSkill && !installedSkill()) reason = 'launcher Skill link is absent or has an unexpected target';
      else if (!existsSync(path as string)) reason = 'launcher did not install this file';
      else { identity(path as string, 'file'); content = readFileSync(path as string, 'utf8'); }
    } catch { reason = 'installation cannot be read safely after an isolation failure'; }
    return { source: source as string, content, sha256: content === null ? null : hash(content), installed: content !== null,
      reason, shownToModel: content !== null && rollout ? shown(rollout, content) : null };
  });
}
/** Preserve artifacts, including binary files, but remove literal credentials and never follow symlinks. */
export function captureDedicatedArtifacts(source: string, target: string, secrets: Record<string, string>): void {
  identity(source, 'directory');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const from = join(source, entry.name); const to = join(target, entry.name);
    if (entry.isDirectory()) captureDedicatedArtifacts(from, to, secrets);
    else if (entry.isFile()) {
      identity(from, 'file');
      let data: Buffer = readFileSync(from);
      for (const [name, secret] of Object.entries(secrets)) {
        if (!secret) continue;
        const needle = Buffer.from(secret); const parts: Buffer[] = [];
        let start = 0; let index: number;
        while ((index = data.indexOf(needle, start)) !== -1) {
          parts.push(data.subarray(start, index), Buffer.from(`<${name}>`));
          start = index + needle.length;
        }
        if (parts.length) data = Buffer.concat([...parts, data.subarray(start)]);
      }
      writeFileSync(to, data, { mode: 0o600 });
    }
  }
}
