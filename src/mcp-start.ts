import { LocalServiceFailure, startLocalMcpService } from './mcp-service.js';
import { workflowContract } from './workflow.generated.js';

async function main() {
  const port = process.env.WAYFINDER_PORT;
  if (process.argv.length !== 2 || !port || !/^[1-9][0-9]{0,4}$/.test(port)) throw new LocalServiceFailure('invalid_configuration');
  let allowedOrigins: unknown;
  try { allowedOrigins = JSON.parse(process.env.WAYFINDER_ALLOWED_ORIGINS ?? '[]'); }
  catch { throw new LocalServiceFailure('invalid_configuration'); }
  const service = await startLocalMcpService({ databasePath: process.env.WAYFINDER_DATABASE_PATH!, port: Number(port),
    token: process.env.WAYFINDER_TOKEN!, actorId: process.env.WAYFINDER_ACTOR_ID!, clientId: process.env.WAYFINDER_CLIENT_ID!,
    allowedOrigins: allowedOrigins as string[],
    ...(process.env.WAYFINDER_CREDENTIALS_FILE === undefined ? {} : { credentialsPath: process.env.WAYFINDER_CREDENTIALS_FILE }),
  });
  console.log(`Wayfinder local MCP ready workflowVersion=${workflowContract.workflowVersion}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('Wayfinder local MCP stopping');
    void service.stop().then(() => { console.log('Wayfinder local MCP stopped'); }, () => {
      console.error('Wayfinder local MCP stop failed; restart required'); process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
void main().catch(error => {
  console.error(`Wayfinder local MCP startup failed: ${error instanceof LocalServiceFailure ? error.code : 'service_failure'}`);
  process.exitCode = 1;
});
