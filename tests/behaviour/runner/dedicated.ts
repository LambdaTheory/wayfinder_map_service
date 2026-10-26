// The real Dedicated launcher is trusted setup. Everything it executes or uses as policy is runner-owned.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { clientSkills, executeTurn, findRollout, loginSecrets } from './codex.ts';
import type { CodexOptions, CodexSession, TurnRequest } from './codex.ts';
import { readRollout, shown } from './normalize.ts';
import { checkoutRoot, newToken, reservedPorts } from './service.ts';
import { entryIdentity, hashContents, IsolationError, readPinnedFile, readRegularFile, verifyProfile, writeProfile } from './sandbox.ts';
import type { ControlProfile, SandboxLayout } from './sandbox.ts';
import type { Credential, IsolatedService } from './service.ts';

export const dedicatedLauncher = join(checkoutRoot, 'scripts/wayfinder-agent/wayfinder');
export const dedicatedLauncherSource = relative(checkoutRoot, dedicatedLauncher);
const python = '/usr/bin/python3';

export function dedicatedServiceDirectory(): string {
  const root = join(homedir(), 'Library/Caches/wayfinder-behaviour-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(root, 'dedicated-')));
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
  profile: ControlProfile;
  launcher: string;
  checkout: string;
  shimDir: string;
  codexHome: string;
  sourceAuth: string;
  probeToken: string;
  verify(): void;
  /** Runtime-independent copies survive failures and cleanup; never contain tokens. */
  controlEvidence: { profile: string; shim: string; manifest: string };
}

export function prepareDedicated(session: CodexSession, service: IsolatedService,
  controller: Credential, options: CodexOptions, layout: SandboxLayout, workdir: string, proxyEnv: NodeJS.ProcessEnv = {}): DedicatedSetup {
  if (!options.sandbox) throw new IsolationError('Dedicated Entry requires the allowlist sandbox');
  if (reservedPorts.includes(service.port)) throw new IsolationError('Dedicated Entry refuses an everyday port');
  const serviceDir = dirname(service.protocolReport);
  const control = layout.controlDir;
  const launcherHome = join(layout.readOnlyDir, 'launcher-home');
  const sourceAuth = join(launcherHome, '.codex/auth.json');
  mkdirSync(dirname(sourceAuth), { recursive: true, mode: 0o700 });
  // Opaque injected bytes only; never resolve a personal login path here.
  writeFileSync(sourceAuth, existsSync(join(session.codexHome, 'auth.json')) ? readFileSync(join(session.codexHome, 'auth.json')) : '', { mode: 0o600, flag: 'wx' });
  const root = join(session.home, 'dedicated');
  const state = join(root, '.codex-wayfinder');
  const stateHome = join(state, 'home');
  const skills = join(stateHome, '.agents/skills');
  mkdirSync(skills, { recursive: true, mode: 0o700 });
  const checkout = join(layout.readOnlyDir, 'launcher-checkout');
  const skill = join(checkout, '.agents/skills/wayfinder');
  const outputs = join(workdir, 'outputs');
  for (const method of ['mcp', 'matt']) mkdirSync(join(outputs, method), { recursive: true, mode: 0o700 });
  // The projection has no dist/, and the client cannot add one. Lost service => refusal, never a daemon.
  cpSync(join(checkoutRoot, '.agents/skills/wayfinder'), skill, { recursive: true, dereference: true });
  // The launcher gets a separate probe identity; the Controller token stays in runner memory.
  const probeToken = newToken();
  writeFileSync(join(serviceDir, 'wayfinder-token'), probeToken + '\n', { mode: 0o600 });
  // The shared service stores every credential in its reloadable file, including the Controller.
  // Register these runner-owned lifetimes so the real launcher's pruning preserves them on resume.
  const existing = JSON.parse(readFileSync(join(serviceDir, 'credentials.json'), 'utf8')) as {
    credentials: { clientId: string; tokenSha256: string }[];
  };
  existing.credentials.push({ clientId: 'Behaviour-LauncherProbe', tokenSha256: hashContents(probeToken) });
  writeFileSync(join(serviceDir, 'credentials.json'), JSON.stringify(existing), { mode: 0o600 });
  writeFileSync(join(serviceDir, 'credential-owners.json'), JSON.stringify(Object.fromEntries(
    existing.credentials.map(c => [c.tokenSha256, { clientId: c.clientId, pid: process.pid }]))), { mode: 0o600, flag: 'wx' });
  const capturePath = join(serviceDir, 'codex-launch.json');
  const launcherDir = join(layout.readOnlyDir, 'launcher');
  mkdirSync(launcherDir, { mode: 0o700 });
  for (const name of ['wayfinder', 'config.toml', 'agent-instructions.md'])
    copyFileSync(join(dirname(dedicatedLauncher), name), join(launcherDir, name));
  const launcher = join(launcherDir, 'wayfinder');
  const shimDir = join(layout.readOnlyDir, 'launcher-bin');
  mkdirSync(shimDir, { mode: 0o700 });
  const binary = realpathSync(options.bin);
  const protectedTrees = [serviceDir, launcherHome, join(state, 'AGENTS.md'), join(state, 'config.toml'), join(stateHome, '.agents')];
  // writeProfile owns policy and pinning. The exclusive path depends only on this session HOME.
  const profilePath = join(control, `${session.home.split('/').at(-1)}.sb`);
  const command = ['/usr/bin/sandbox-exec', '-f', profilePath, binary];
  const expected = { home: stateHome, codexHome: state, url: `mcp_servers.wayfinder.url="http://127.0.0.1:${service.port}/mcp"` };
  const constants = JSON.stringify({ command, capturePath, serviceDir, expected, primaryHashes: [hashContents(controller.token), hashContents(probeToken)], path: process.env.PATH ?? '/usr/bin:/bin' });
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
    if sha in settings["primaryHashes"] or sha not in owners:
        sys.exit("isolation failure: Dedicated Entry refused a fallback primary credential")
    record = {"token": token, "clientId": owners[sha]["clientId"], "argv": sys.argv[1:],
              "home": env["HOME"], "codexHome": env["CODEX_HOME"],
              "overrides": {k: v for k, v in env.items() if k.startswith("WAYFINDER_AGENT_")}}
    fd = os.open(settings["capturePath"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(record, handle)
env = {k: v for k, v in env.items() if not k.startswith("WAYFINDER_AGENT_")}
proxies = json.loads(env.pop("WAYFINDER_NATIVE_PROXY_ENV", "{}"))
for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"):
    env.pop(key, None)
env.update(proxies)
env["PATH"] = settings["path"]
command = settings["command"] + sys.argv[1:]
os.execvpe(command[0], command, env)
`;
  writeFileSync(join(shimDir, 'codex'), shim, { mode: 0o700 });
  const profile = writeProfile(control, session, workdir, binary, {
    readOnlyRoots: [checkout, launcherDir, shimDir], mutableReadOnlyFiles: [sourceAuth],
    denyWriteRoots: protectedTrees, denyWritePaths: [join(outputs, 'mcp'), join(outputs, 'matt')], localPorts: [service.port],
    proxyEnv,
  });
  const installedFiles = new Map<string, string>();
  const expectedFiles: Record<string, string> = {
    'AGENTS.md': readFileSync(join(launcherDir, 'agent-instructions.md'), 'utf8')
      .replaceAll('@WORK@', join(outputs, 'mcp')).replaceAll('@RELAUNCH@', 'wayfinder'),
    'config.toml': readFileSync(join(launcherDir, 'config.toml'), 'utf8').replaceAll('@WORK@', join(outputs, 'mcp')),
  };
  const verify = () => {
    const failure = verifyProfile(profile);
    if (failure) throw new IsolationError(failure.replace(/^isolation failure: /, ''));
    // The launcher writes through these paths outside the sandbox. No substituted links or hardlinks.
    for (const file of ['AGENTS.md', 'config.toml']) {
      const path = join(state, file);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        const current = entryIdentity(path, 'file');
        if (readRegularFile(path).toString('utf8') !== expectedFiles[file]! || (installedFiles.has(file) && installedFiles.get(file) !== current))
          throw new IsolationError('changed launcher-installed context');
        installedFiles.set(file, current);
      } else if (installedFiles.has(file)) throw new IsolationError('removed launcher-installed context');
    }
    entryIdentity(skills, 'directory'); // The launcher writes through this nested directory.
    const ownAuth = join(state, 'auth.json');
    const info = lstatSync(ownAuth, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      if (readlinkSync(ownAuth) !== sourceAuth) throw new IsolationError('changed native auth link target');
    } else if (info) entryIdentity(ownAuth, 'file'); // A native atomic refresh may replace the link with a regular file.
  };
  return { state, skill, outputs, capturePath, control, launcherHome, profile, launcher, checkout, shimDir, codexHome: state, sourceAuth, probeToken, verify,
    controlEvidence: { profile: readFileSync(profile.path, 'utf8'), shim, manifest: JSON.stringify(profile) }, env: {
      PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: launcherHome, TMPDIR: join(session.home, 'tmp'), LANG: 'en_US.UTF-8',
      // Trusted loopback probes must never follow HTTP/system proxies. The shim restores the exact native route.
      NO_PROXY: '*', no_proxy: '*', WAYFINDER_NATIVE_PROXY_ENV: JSON.stringify(profile.proxyEnvironment),
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
  request.onLaunch?.();
  const result = await executeTurn(request, python,
    ['-I', setup.launcher, '--harness', 'codex', '--method', 'mcp', '--model', o.model, '--effort', o.effort, '--', ...exec], setup.env);
  try { setup.verify(); } // Includes mutable auth and newly installed context.
  catch (error) { return { ...result, postIsolationFailure: String(error) }; }
  return result;
}

export function dedicatedLaunch(setup: DedicatedSetup): LaunchEvidence | null {
  return existsSync(setup.capturePath) ? JSON.parse(readPinnedFile(setup.capturePath, setup.profile.identities).toString('utf8')) as LaunchEvidence : null;
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
  entryIdentity(sessions, 'directory');
  const path = findRollout(session);
  if (!path) return null;
  entryIdentity(path, 'file');
  return readRollout(path);
}
export function dedicatedClientSkills(setup: DedicatedSetup, session: CodexSession): string[] {
  setup.verify();
  const root = join(session.codexHome, 'skills');
  if (lstatSync(root, { throwIfNoEntry: false })) entryIdentity(root, 'directory');
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
      else content = readRegularFile(path as string).toString('utf8');
    } catch { reason = 'installation cannot be read safely after an isolation failure'; }
    return { source: source as string, content, sha256: content === null ? null : hashContents(content), installed: content !== null,
      reason, shownToModel: content !== null && rollout ? shown(rollout, content) : null };
  });
}
