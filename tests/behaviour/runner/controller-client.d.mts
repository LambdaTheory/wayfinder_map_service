import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
export function createControllerClient(port: number, token: string): Promise<{
  client: Client;
  close(): Promise<void>;
}>;
