// Upgrade compatibility checks (spec §3). They sit outside the 26 candidates and have their own Batches.
// Each one restarts the isolated service onto a canary build whose rules a model can only follow if it read them
// (`tests/helpers/canary-release.mjs`); `tests/helpers/upgrade-live.mjs` is the earlier runner they may reuse.
import type { Entry, Harness } from './evidence.ts';

export interface UpgradeCheck {
  id: string;
  harness: Harness;
  entry: Entry;
  situation: string;
  /** Where the agent must learn the new `version`; the runner never supplies it (ADR 0005). */
  rulesSource: 'instructions' | 'tool-parameter';
  controller: string[];
  mustNot: string[];
  expect: string[];
  /** AttemptRecord fields that carry the proof. */
  evidence: string[];
  /** Implementation Issue that runs it. */
  issue: string;
}

const restart = ['Create a Map at the old release in the first turn.', 'Restart the isolated service onto the canary build while the session is open.'];
const writeProof = ['receipts', 'maps.*.history', 'given.instructions', 'given.toolDescriptions', 'events (resource-read, tool-call)'];
const common = {
  mustNot: ['A write committed under the old release.', 'The same change written twice.', 'A guessed version.', 'version_mismatch treated as a tool outage.'],
};

export const upgradeChecks: UpgradeCheck[] = [
  { id: 'U-codex-process', harness: 'codex', entry: 'mcp-only', situation: 'Same Codex process across the restart (exec waits).', rulesSource: 'instructions',
    controller: restart, ...common, evidence: writeProof, issue: 'B02c (#67)',
    expect: ['The old-version write is refused with nothing written.', 'The agent reads wayfinder://workflow/exploration, rereads the Map and writes once with the new version.', 'The write follows the canary rule.'] },
  { id: 'U-codex-resume', harness: 'codex', entry: 'mcp-only', situation: 'Conversation resumed in a new Codex process.', rulesSource: 'instructions',
    controller: [...restart, 'Resume the conversation in a new process.'], ...common, evidence: writeProof, issue: 'B02c (#67)',
    expect: ['The first write carries the new version.', 'The write follows the canary rule.'] },
  { id: 'U-claude-process', harness: 'claude', entry: 'mcp-only', situation: 'Same Claude Code process across the restart (tool search on).', rulesSource: 'instructions',
    controller: restart, ...common, evidence: writeProof, issue: 'B06a (#74)',
    expect: ['The old-version write is refused with nothing written.', 'The agent reads the Resource and writes once with the new version.', 'The write follows the canary rule, including one that lives only in the new map_apply description.'] },
  { id: 'U-claude-resume', harness: 'claude', entry: 'mcp-only', situation: 'Conversation resumed with --resume (new tools, old instructions).', rulesSource: 'instructions',
    controller: [...restart, 'Resume with --resume.'], ...common, evidence: writeProof, issue: 'B06a (#74)',
    expect: ['The old-version write is refused with nothing written.', 'The agent reads the Resource and writes once with the new version.', 'The write follows the canary rule.'] },
  { id: 'U-chatgpt-old-chat', harness: 'chatgpt', entry: 'chatgpt', situation: 'The open ChatGPT chat after the restart (compatibility mode, toolsOnly).', rulesSource: 'tool-parameter',
    controller: [...restart, 'Refresh tools in the app; keep the old chat.'], ...common, evidence: [...writeProof, 'controller events (app actions)'], issue: 'B09a (#80)',
    expect: ['The write is refused with nothing written.', 'The agent says it cannot read the rules and asks the human to refresh and open a new chat; it does not retry with guessed versions.'] },
  { id: 'U-chatgpt-new-chat', harness: 'chatgpt', entry: 'chatgpt', situation: 'A new ChatGPT chat after Refresh tools.', rulesSource: 'tool-parameter',
    controller: [...restart, 'Refresh tools, then open a new chat.'], ...common, evidence: [...writeProof, 'controller events (app actions)'], issue: 'B09a (#80)',
    expect: ['The write carries the version stated in the write tool parameter.', 'The write follows the canary rule that lives only in the new map_apply description.'] },
];
