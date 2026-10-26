import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Load the same built domain used by the service, only when conversion needs it (Node 26 supports require(ESM)). */
export function captureDomain() {
  return {
    ...require('../../../dist/index.js') as typeof import('../../../src/index.ts'),
    ...require('../../../dist/commands.js') as typeof import('../../../src/commands.ts'),
    ...require('../../../dist/revision-record.js') as typeof import('../../../src/revision-record.ts'),
  };
}
