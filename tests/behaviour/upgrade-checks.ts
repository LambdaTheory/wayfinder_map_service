// Upgrade compatibility checks (spec §3). They sit outside the 26 candidates and have their own Batches.
// Each one restarts the isolated service onto a canary build whose rules a model can only follow if it read them
// (`tests/helpers/canary-release.mjs`); `tests/helpers/upgrade-live.mjs` is the earlier runner they may reuse.
// An Attempt of one names it as `subject: { kind: 'upgrade-check', id, version }`.
import type { Entry, Harness, RulesSource } from './evidence.ts';

export interface UpgradeItem {
  id: string;
  text: string;
  /** AttemptRecord fields that prove or refute it. */
  evidence: string[];
}

export interface UpgradeCheck {
  id: string;
  version: number;
  harness: Harness;
  entry: Entry;
  situation: string;
  /** Where the agent must learn the new `version`; the runner never supplies it (ADR 0005). */
  rulesSource: RulesSource['kind'];
  /** Controller steps, recorded as controller events apart from the agent's. */
  controller: string[];
  mustNot: UpgradeItem[];
  expect: UpgradeItem[];
  /** Implementation Issue that runs it. */
  issue: string;
}

const restart = ['Create a Map at the old release in the first turn.', 'Restart the isolated service onto the canary build while the session is open.'];

const writeRisks: UpgradeItem[] = [
  { id: 'old-rules-write', text: 'A write committed under the old release.', evidence: ['receipts', 'maps.*.history', 'given[phase=after-restart]'] },
  { id: 'double-write', text: 'The same change written twice.', evidence: ['receipts', 'maps.*.history'] },
  { id: 'guessed-version', text: 'A write whose version matches neither rules source the client was given.', evidence: ['events[kind=tool-call].arguments.version', 'given'] },
  { id: 'mismatch-as-outage', text: 'A version_mismatch treated as the tool outage W5 tests.', evidence: ['events[kind=message]', 'events[kind=tool-call].result'] },
];

const refused: UpgradeItem = { id: 'refused-unwritten', text: 'The first write after the restart is refused with version_mismatch and nothing is written.',
  evidence: ['events[kind=tool-call].result', 'receipts', 'maps.*.history'] };
const readsRules: UpgradeItem = { id: 'reads-new-rules', text: 'The agent reads wayfinder://workflow/exploration and rereads the Map before writing again.',
  evidence: ['events[kind=resource-read]', 'events[kind=tool-call,tool=map_read]'] };
const newVersion: UpgradeItem = { id: 'writes-new-version', text: 'The next write carries the new release and commits once.', evidence: ['events[kind=tool-call].arguments.version', 'receipts'] };
const canaryRule: UpgradeItem = { id: 'follows-canary-rule', text: 'The committed write follows the canary rule, including one that lives only in the new map_apply description.',
  evidence: ['maps.*.history', 'given[phase=after-restart].toolDescriptions'] };

export const upgradeChecks: UpgradeCheck[] = [
  { id: 'U-codex-process', version: 1, harness: 'codex', entry: 'mcp-only', situation: 'Same Codex process across the restart (exec waits).',
    rulesSource: 'instructions', controller: restart, mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B02c (#67)' },
  { id: 'U-codex-resume', version: 1, harness: 'codex', entry: 'mcp-only', situation: 'Conversation resumed in a new Codex process.',
    rulesSource: 'instructions', controller: [...restart, 'Resume the conversation in a new process.'], mustNot: writeRisks, expect: [newVersion, canaryRule], issue: 'B02c (#67)' },
  { id: 'U-claude-process', version: 1, harness: 'claude', entry: 'mcp-only', situation: 'Same Claude Code process across the restart (tool search on).',
    rulesSource: 'instructions', controller: restart, mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-claude-resume', version: 1, harness: 'claude', entry: 'mcp-only', situation: 'Conversation resumed with --resume (new tools, old instructions).',
    rulesSource: 'instructions', controller: [...restart, 'Resume with --resume.'], mustNot: writeRisks, expect: [refused, readsRules, newVersion, canaryRule], issue: 'B06a (#74)' },
  { id: 'U-chatgpt-old-chat', version: 1, harness: 'chatgpt', entry: 'chatgpt', situation: 'The open ChatGPT chat after the restart (compatibility mode, toolsOnly).',
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools in the app; keep the old chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [refused, { id: 'asks-refresh', text: 'The agent says it cannot read the rules and asks the human to refresh and open a new chat, without retrying.',
      evidence: ['events[kind=message]', 'events[kind=tool-call]', 'events[kind=controller]'] }] },
  { id: 'U-chatgpt-new-chat', version: 1, harness: 'chatgpt', entry: 'chatgpt', situation: 'A new ChatGPT chat after Refresh tools.',
    rulesSource: 'tool-parameter', controller: [...restart, 'Refresh tools, then open a new chat.'], mustNot: writeRisks, issue: 'B09a (#80)',
    expect: [{ ...newVersion, text: 'The write carries the release stated in the write tool parameter and commits once.' }, canaryRule] },
];
