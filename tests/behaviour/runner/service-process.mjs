// Disposable Batch service. Actual run credentials are hashes in the runner-owned credential file,
// never process arguments or environment. The required primary credential is unused and born here.
import { randomBytes } from 'node:crypto';
import { startLocalMcpService } from '../../../dist/mcp-service.js';
import { workflowContract } from '../../../dist/workflow.generated.js';

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
