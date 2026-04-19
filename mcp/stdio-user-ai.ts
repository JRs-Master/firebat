#!/usr/bin/env node
/**
 * Firebat MCP Server — CLI User AI 전용 stdio 진입점
 *
 * Firebat 서버가 Claude Code CLI 를 User AI 백엔드로 spawn 할 때 연결되는 MCP 엔드포인트.
 * internal-server 의 전체 도구 세트 (render_* 시각화 14개 + suggest + html + 페이지·파일 관리) 를 노출.
 *
 * VSCode/Claude Desktop 개발 도구 연결용은 mcp/stdio.ts (server.ts) — 별도 분리.
 *
 * 실행: npx tsx mcp/stdio-user-ai.ts
 *   (cli-claude-code.ts 핸들러가 MCP 설정 파일에 이 경로를 자동 주입)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getCore } from '../lib/singleton';

async function main() {
  const core = getCore();
  const { createInternalMcpServer } = await import('./internal-server');
  const server = createInternalMcpServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[Firebat MCP User AI] Fatal:', err);
  process.exit(1);
});
