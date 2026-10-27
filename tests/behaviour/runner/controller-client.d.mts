import type { Client } from '@modelcontextprotocol/client';
export function createControllerClient(port: number, token: string): Promise<{
  client: Client;
  close(): Promise<void>;
}>;
