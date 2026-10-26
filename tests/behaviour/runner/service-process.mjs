// Disposable Batch service. Actual run credentials are hashes in the runner-owned credential file,
// never process arguments or environment. The required primary credential is unused and born here.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
// Only the owning runner selects this build; it is never supplied by the agent or a CLI target flag.
const build = process.env.WAYFINDER_TEST_BUILD;
const { startLocalMcpService } = await import(build ? pathToFileURL(join(build, 'dist/mcp-service.js')).href : '../../../dist/mcp-service.js');
const { workflowContract } = await import(build ? pathToFileURL(join(build, 'dist/workflow.generated.js')).href : '../../../dist/workflow.generated.js');

const service = await startLocalMcpService({
  databasePath: process.env.WAYFINDER_DATABASE_PATH,
  port: Number(process.env.WAYFINDER_PORT),
  token: randomBytes(32).toString('hex'),
  actorId: process.env.WAYFINDER_ACTOR_ID,
  clientId: process.env.WAYFINDER_CLIENT_ID,
  allowedOrigins: [],
  credentialsPath: process.env.WAYFINDER_CREDENTIALS_FILE,
});
console.log(`Wayfinder local MCP ready version=${workflowContract.version}`);
const stop = () => { void service.stop().then(() => process.exit(0)); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
