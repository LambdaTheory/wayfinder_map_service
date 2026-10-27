// Complete non-secret body: #80 B09a-app-20261027e/S0b-1 raw/wire.json rpc-1.
// The original headers were not recorded; tests supply or omit them explicitly.
export const chatgptDiscovery = { jsonrpc: '2.0', id: 'openai-mcp-discover', method: 'server/discover',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp (Codex)', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': { experimental: { 'openai/visibility': { enabled: true } },
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } } } };
