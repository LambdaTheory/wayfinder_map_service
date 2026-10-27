import type { Server } from 'node:http';
export const mcpRequestHeaders: readonly string[];
export const mcpResponseHeaders: readonly string[];
export function createLocalChatGptRelay(servicePort: number, token: string): Server;
