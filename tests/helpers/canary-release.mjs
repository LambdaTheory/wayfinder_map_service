// A canary release of a built checkout: the same code with a new version and two rules a model can only follow
// if the new definitions reached it. The reply rule lives only in the instructions and the workflow Resource;
// the Ticket rule only in the map_apply description and the Resource.
import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const canaryVersion = '9.9.9';
export const replyWord = 'LANTERN';
export const ticketTitlePrefix = 'v2: ';
export const replyRule = `Release check: begin every reply to the human with the word ${replyWord}.`;
export const ticketRule = `In this release every Ticket title begins with "${ticketTitlePrefix}".`;

export function canaryContract(contract) {
  const swap = text => text.replaceAll(contract.version, canaryVersion);
  const markdown = swap(contract.markdown)
    .replace('<!-- wayfinder:instructions-summary:end -->', `${replyRule}\n<!-- wayfinder:instructions-summary:end -->`)
    .replace('<!-- wayfinder:tool:map_apply:end -->', `${ticketRule}\n<!-- wayfinder:tool:map_apply:end -->`);
  return { ...contract, version: canaryVersion, markdown, instructions: `${swap(contract.instructions)}\n\n${replyRule}`,
    toolDescriptions: Object.fromEntries(Object.entries(contract.toolDescriptions).map(([name, text]) =>
      [name, name === 'map_apply' ? `${swap(text)} ${ticketRule}` : swap(text)])),
    prompt: swap(contract.prompt) };
}

// Copies checkout/dist into target with the canary contract; the copy runs as its own service build.
export async function writeCanaryCheckout(checkout, target) {
  mkdirSync(target, { recursive: true });
  cpSync(join(checkout, 'dist'), join(target, 'dist'), { recursive: true });
  cpSync(join(checkout, 'package.json'), join(target, 'package.json'));
  symlinkSync(realpathSync(join(checkout, 'node_modules')), join(target, 'node_modules'));
  const { workflowContract } = await import(pathToFileURL(join(checkout, 'dist/workflow.generated.js')).href);
  const canary = canaryContract(workflowContract);
  writeFileSync(join(target, 'dist/workflow.generated.js'), `export const workflowContract = Object.freeze(${JSON.stringify(canary, null, 2)});\n`);
  return { before: workflowContract, after: canary };
}
