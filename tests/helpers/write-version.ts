import { workflowContract } from '../../src/workflow.generated.js';

// Writes name the release whose rules they follow. Tests about other rules write as a current caller would.
export const versioned = (name: string, args: Record<string, unknown>): Record<string, unknown> =>
  (name === 'map_create' || name === 'map_apply') && !Object.hasOwn(args, 'version') ? { version: workflowContract.version, ...args } : args;
