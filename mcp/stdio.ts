#!/usr/bin/env node
/**
 * Firebat MCP Server — stdio 진입점
 *
 * Claude Code, Cursor 등 로컬 AI 도구에서 사용.
 * 실행: npx tsx mcp/stdio.ts
 *
 * claude_desktop_config.json 예시:
 * {
 *   "mcpServers": {
 *     "firebat": {
 *       "command": "npx",
 *       "args": ["tsx", "mcp/stdio.ts"],
 *       "cwd": "/var/www/firebat"
 *     }
 *   }
 * }
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getCore } from '../lib/singleton';

async function main() {
  const core = getCore();
  const { createFirebatMcpServer } = await import('./server');
  const server = createFirebatMcpServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[Firebat MCP] Fatal:', err);
  process.exit(1);
});
