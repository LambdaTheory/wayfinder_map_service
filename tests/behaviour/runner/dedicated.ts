// Codex Dedicated Entry: invoke the repository's everyday launcher with only run-owned paths.
// The launcher is trusted setup; a codex shim applies the same allowlist sandbox to the actual client.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeTurn } from './codex.ts';
import type { CodexOptions, CodexSession, TurnRequest } from './codex.ts';
import { shown } from './normalize.ts';
import { checkoutRoot, reservedPorts } from './service.ts';
import type { Credential, IsolatedService } from './service.ts';

export const dedicatedLauncher = join(checkoutRoot, 'scripts/wayfinder-agent/wayfinder');

/** Database and launcher credentials are outside the agent's readable scratch, inside the approved cache. */
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
}

export function prepareDedicated(scratch: string, session: CodexSession, service: IsolatedService,
  controller: Credential, options: CodexOptions, profile: string): DedicatedSetup {
  if (reservedPorts.includes(service.port)) throw new Error('Dedicated Entry refuses an everyday port');
  const serviceDir = dirname(service.protocolReport);
  const root = join(session.home, 'dedicated');
  const state = join(root, '.codex-wayfinder');
  const checkout = join(scratch, 'launcher-checkout');
  const skill = join(checkout, '.agents/skills/wayfinder');
  const outputs = join(scratch, 'outputs');
  cpSync(join(checkoutRoot, '.agents/skills/wayfinder'), skill, { recursive: true, dereference: true });
  // Only the unchanged skill is projected. No dist/: a lost service makes the launcher fail closed,
  // instead of starting a detached service the Controller does not own.
  writeFileSync(join(serviceDir, 'wayfinder-token'), controller.token + '\n', { mode: 0o600 });
  const capturePath = join(serviceDir, 'codex-launch.json');
  const shimDir = join(session.home, 'launcher-bin');
  mkdirSync(shimDir, { mode: 0o700 });
  const resolved = options.bin.includes('/') ? options.bin : spawnSync('which', [options.bin], { encoding: 'utf8' }).stdout.trim();
  const binary = realpathSync(resolved);
  const command = options.sandbox ? ['/usr/bin/sandbox-exec', '-f', profile, binary] : [binary];
  // Python literals are decoded from JSON, not interpolated into executable shell text. The shim records
  // the launch credential privately before entering the sandbox; the runner redacts it from all evidence.
  const constants = JSON.stringify({ command, capturePath, serviceDir, path: process.env.PATH ?? '/usr/bin:/bin' });
  writeFileSync(join(shimDir, 'codex'), `#!/usr/bin/env python3
import hashlib, json, os, sys
from pathlib import Path
settings = json.loads(${JSON.stringify(constants)})
env = dict(os.environ)
token = env.get("WAYFINDER_TOKEN")
if token:
    sha = hashlib.sha256(token.encode()).hexdigest()
    owners = json.loads((Path(settings["serviceDir"]) / "credential-owners.json").read_text())
    if sha not in owners:
        sys.exit("Dedicated Entry refused a fallback primary credential")
    record = {"token": token, "clientId": owners[sha]["clientId"], "argv": sys.argv[1:],
              "home": env["HOME"], "codexHome": env["CODEX_HOME"],
              "overrides": {k: v for k, v in env.items() if k.startswith("WAYFINDER_AGENT_")}}
    fd = os.open(settings["capturePath"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(record, handle)
# Bootstrap paths and service controls do not belong in the model's environment.
env = {k: v for k, v in env.items() if not k.startswith("WAYFINDER_AGENT_")}
env["PATH"] = settings["path"]
command = settings["command"] + sys.argv[1:]
os.execvpe(command[0], command, env)
`, { mode: 0o700 });
  session.codexHome = state;
  return { state, skill, outputs, capturePath, env: {
    PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: session.home, TMPDIR: join(session.home, 'tmp'), LANG: 'en_US.UTF-8',
    WAYFINDER_AGENT_STATE_ROOT: root, WAYFINDER_AGENT_SERVICE_DIR: serviceDir, WAYFINDER_AGENT_OUTPUTS: outputs,
    WAYFINDER_AGENT_PORT: String(service.port), WAYFINDER_AGENT_DATABASE: service.databasePath,
    WAYFINDER_AGENT_CHECKOUT: checkout, WAYFINDER_AGENT_USAGE: 'test',
  } };
}

/** Same everyday noninteractive entry, including the launcher's configuration; no --ignore-user-config. */
export function runDedicatedTurn(request: TurnRequest, setup: DedicatedSetup) {
  rmSync(setup.capturePath, { force: true });
  const { options: o, session: s } = request;
  const exec = s.thread ? ['exec', 'resume', '--json', '--skip-git-repo-check', s.thread, '-']
    : ['exec', '--json', '--skip-git-repo-check', '-'];
  return executeTurn(request, dedicatedLauncher,
    ['--harness', 'codex', '--method', 'mcp', '--model', o.model, '--effort', o.effort, '--', ...exec], setup.env);
}

export function dedicatedLaunch(setup: DedicatedSetup): LaunchEvidence | null {
  return existsSync(setup.capturePath) ? JSON.parse(readFileSync(setup.capturePath, 'utf8')) as LaunchEvidence : null;
}

/** Installation and model exposure are distinct: availability never claims the model read the Skill. */
export function dedicatedContext(setup: DedicatedSetup, rollout: string | undefined) {
  return [
    ['scripts/wayfinder-agent/agent-instructions.md', join(setup.state, 'AGENTS.md')],
    ['.agents/skills/wayfinder/SKILL.md', join(setup.skill, 'SKILL.md')],
    ['scripts/wayfinder-agent/config.toml', join(setup.state, 'config.toml')],
    ['.agents/skills/wayfinder/agents/openai.yaml', join(setup.skill, 'agents/openai.yaml')],
  ].map(([source, path]) => {
    const content = existsSync(path!) ? readFileSync(path!, 'utf8') : null;
    return { source: source!, content, sha256: content === null ? null : createHash('sha256').update(content).digest('hex'),
      installed: content !== null, shownToModel: content !== null && rollout ? shown(rollout, content) : null };
  });
}

/** Preserve artifacts, including binary files, but remove literal credentials and never follow symlinks. */
export function captureDedicatedArtifacts(source: string, target: string, secrets: Record<string, string>): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const from = join(source, entry.name); const to = join(target, entry.name);
    if (entry.isDirectory()) captureDedicatedArtifacts(from, to, secrets);
    else if (entry.isFile()) {
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
