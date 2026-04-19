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
  // internal-server 사용 — render_* 시각화 도구 포함 (server.ts 는 코딩·파일 도구만).
  // Claude Code CLI 가 Firebat User AI 백엔드로 동작할 때 리치 컴포넌트 렌더 가능.
  // 외부 AI (Claude Desktop 등) 가 개발용으로 접속해도 동일 도구 사용 가능하므로 호환.
  const { createInternalMcpServer } = await import('./internal-server');
  const server = createInternalMcpServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[Firebat MCP] Fatal:', err);
  process.exit(1);
});
