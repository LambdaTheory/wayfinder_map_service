import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
export function createHttpTestClient(port: number, token: string): Promise<{
  client: Client;
  streamProbe: Promise<{ status: number }>;
  negotiatedProtocol: string;
  initializeResult: { instructions?: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> };
  transport: { readonly sessionId: string | undefined; terminateSession(): Promise<void> };
}>;
