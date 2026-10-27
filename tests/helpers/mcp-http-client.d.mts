import type { Client } from '@modelcontextprotocol/client';
export function createHttpTestClient(port: number, token: string, protocol?: '2025-11-25' | '2026-07-28'): Promise<{
  client: Client;
  streamProbe: Promise<{ status: number }>;
  negotiatedProtocol: string;
  requests: { method: string | undefined; headers: Record<string, string>; body: Record<string, unknown> | null }[];
  initializeResult: { instructions?: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> };
  transport: { readonly sessionId: string | undefined; terminateSession(): Promise<void> };
}>;
