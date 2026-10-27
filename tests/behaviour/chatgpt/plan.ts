import { clientProfiles } from '../clients.ts';
import { library } from '../library.ts';
import { readiness, validateScenario } from '../scenario.ts';
import type { Scenario } from '../scenario.ts';
import { asScenario, upgradeChecks } from '../upgrade-checks.ts';

export const initialFive = ['S0b', 'S1', 'S5', 'S9', 'F11'];
export const impacts = [
  'Kun must approve the Batch, model quota, app/window takeover and tunnel use before run.',
  'The operator occupies the selected ChatGPT window, refreshes tools and opens fresh chats outside projects.',
  'Kun may take over operating the interface at any time.',
  'opencode is exclusive: daily ChatGPT routing is unavailable during this Batch; any existing connector must be stopped by its operator first.',
  'The daily local service and database stay running and untouched. This command never attaches to ports 18765 or 18766.',
  'Anyone who reaches the public hostname can read or mutate test Maps during an active turn; a stranger’s call could be attributed to that turn. Do not leave this endpoint unattended.',
  'Every other hostname routed through opencode is unavailable too; list the configured ingress hostnames with the operator before approval.',
  'The original tunnel config, credential files and DNS are unchanged. Exit removes this connector and its temporary config; no daily connector is started automatically.',
  'Do not start another opencode connector during the run. Ownership is checked before each forwarded request and every second; a competing external process is not locked by this command.',
  'Scripted replies require the proposal they answer. Real human verdicts and final acceptance remain Kun’s.',
  'App, web and mobile are separate Batches; untested surfaces remain untested.',
];

function upgradeScenario(id: string): Scenario | undefined {
  const check = upgradeChecks.find(u => u.id === id && u.harness === 'chatgpt');
  if (!check) return;
  return asScenario(check);
}

export function selectScenarios(ids: string[]): Scenario[] {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Choose a nonempty list of distinct Scenarios');
  return ids.map(id => {
    const scenario = library.find(s => s.id === id) ?? upgradeScenario(id);
    if (!scenario) throw new Error(`Unknown Scenario or ChatGPT upgrade check: ${id}`);
    const reasons = readiness(scenario);
    const upgrade = upgradeChecks.find(u => u.id === id);
    if (!upgrade) reasons.push(...validateScenario(scenario));
    if (!scenario.applies.entries.includes('chatgpt')) reasons.push('not applicable to ChatGPT');
    for (const capability of scenario.applies.needs) if (clientProfiles.chatgpt.supports[capability] === false) reasons.push(`unsupported capability ${capability}`);
    if (scenario.controller.length || scenario.seed.restores === 'history' || scenario.seed.fixtures.length
      || (!upgrade && scenario.turns.some(t => t.session !== 'A' || t.concurrent || t.freshProcess)))
      reasons.push('this manual driver does not yet support these Controller actions, history, fixtures or sessions');
    if (reasons.length) throw new Error(`${id}: ${reasons.join('; ')}`);
    return scenario;
  });
}

export function checklist(scenarios: Scenario[], surface: string, count: number, model: string): string {
  const refresh = surface === 'app' ? 'Plugins → Wayfinder-Save → Manage → Refresh tools'
    : surface === 'web' ? 'ChatGPT Web developer-mode connector management → refresh/rescan tools'
      : 'the mobile client’s available connector refresh control; if absent, stop and record that capability gap';
  const lines = ['# ChatGPT Batch operating checklist', '', `Surface: ${surface}; requested model: ${model}; repetitions: ${count}; total Attempts: ${scenarios.length * count}.`,
    'Each Attempt has a new database and chat. ChatGPT onboarding is still unverified until the real run proves it. No model reviews or arbitration are included in this count; approve those separately.', '',
    '## Impacts to present before approval', '', ...impacts.map(x => `- ${x}`), '', '## For every Attempt', '',
    '1. After the command prints ready, record the visible model and client version; preserve native UI evidence in the private raw directory.',
    `2. Refresh the Wayfinder tools using ${refresh}. Enter did refresh-tools.`,
    '3. Open a fresh chat in Chat mode outside any project, with no Skill, AGENTS.md or copied rules. Enter `did new-chat`.',
    '4. Mention the Wayfinder plugin in every message. Enter `did plugin-mentioned`, then `begin` (or `begin confirmed` for a reply whose actual proposal was checked).',
    '5. Send exactly the printed Scenario line with the plugin mention. Never paste this checklist, a version, controller-tools.json or expected outcomes into the chat.',
    '6. Collect all native assistant messages and other relevant activity. The relay captures actual Wayfinder calls in raw/wire.json; position messages using those rpc-N call IDs.',
    '7. Write a capture JSON in the private raw directory (format in tests/behaviour/chatgpt/README.md), then `end /absolute/path/capture.json`. Repeat turns in order.',
    '8. Preserve the actual client tool snapshot and native version-source evidence. toolsShown needs toolsShownSource (raw/wire.json#rpc-N), matching this MCP session’s last tools/list before its first begin in the phase; missing/mismatched records stay unknown. Never use Controller definitions.',
    '9. Enter `next` after all turns. Ctrl-C, stdin EOF or `stop` preserves unfinished Attempts and closes only owned resources.',
    '10. If the operator stopped the daily ChatGPT connector, restore it under approval, refresh its normal tool snapshot and record both actions with the Batch evidence. The command does not restore it automatically.',
    '', '## Scenario messages (operator only)', ''];
  for (const s of scenarios) {
    const upgrade = upgradeChecks.find(u => u.id === s.id)?.chatgpt;
    lines.push(`### ${s.id} v${s.version}: ${s.title}`, '', `Seed: ${s.seed.restores}; Maps: ${s.seed.maps.map(m => m.mapId).join(', ') || 'none'}.`, '');
    s.turns.forEach((t, i) => {
      if (i === 1 && upgrade) lines.push('After capturing turn 0: `upgrade` restarts this database on the canary build. Refresh tools and record `did refresh-tools`.',
        upgrade.recovery === 'old-chat' ? 'Keep the OLD chat. Do not start a new chat for turn 1. Preserve the refusal, unchanged history and request to refresh; do not help it guess or retry.'
          : 'Open a NEW chat, record `did new-chat`, mention the plugin and record `did plugin-mentioned`. Preserve new definitions and the committed canary Ticket title.', '');
      lines.push(`Turn ${i}, session ${t.session}, ${t.kind}:`, '', '```text', t.say, '```', '');
      if (t.desk) lines.push(`Before this input, begin requires Pending desk questions on ${t.desk.mapId}: ${t.desk.ticketIds.join(', ')}. ${t.desk.submit?.length ? 'The Controller submits the specified displayed answers through the keyed route and waits for the Quiet Window.' : 'No desk answer is submitted; keep this conversation input unchanged.'}`, '');
      if (t.answers) lines.push(`Before this reply, verify: ${t.answers.proposal}. If absent, do not send it: stop precondition-not-met. A matching word alone is insufficient.`, '');
    });
    lines.push('Collect: native messages, exact calls/results, receipts, before/after Map history, client tool snapshot, version-source evidence and preparation actions. Required verdict items:',
      ...[...s.requiredEvents, ...s.mustNot, ...s.expect.flatMap(g => g.anyOf)].map(i => `- ${i.id}: ${i.text}`), '');
  }
  lines.push('## Results', '', 'The command uses verdict.ts through report.ts. Model items remain undecided until approved independent reviews; human items and final acceptance remain with Kun.',
    'Keep failed Attempts, unrun items, client visibility gaps, the two upgrade checks and untested surfaces in the report. This command does not complete the separate cross-client human journey (B09c).', '');
  return lines.join('\n');
}
