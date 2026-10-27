// Operator entry point, deliberately not re-exported by the pure domain module.
import { openSQLite } from './sqlite-storage.js';
import { captureConfiguration, LocalServiceFailure, serveLocalMcp } from './mcp-http-internal.js';
import type { LocalServiceConfiguration, LocalMcpService } from './mcp-http-internal.js';
export { LocalServiceFailure } from './mcp-http-internal.js';
export type { LocalServiceConfiguration, LocalMcpService } from './mcp-http-internal.js';

export async function startLocalMcpService(input: LocalServiceConfiguration): Promise<LocalMcpService> {
  const configuration = captureConfiguration(input);
  let storage;
  try { storage = openSQLite(configuration.databasePath, { migrate: true }); }
  catch { throw new LocalServiceFailure('storage_not_ready'); }
  try { return await serveLocalMcp(storage, configuration); }
  catch (error) { storage.close(); throw error; }
}
