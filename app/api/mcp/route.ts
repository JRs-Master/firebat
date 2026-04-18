/**
 * MCP Streamable HTTP Endpoint — 웹 기반 AI 도구에서 파이어뱃 MCP 서버에 접속
 *
 * GET  /api/mcp  → SSE 스트림 (서버→클라이언트 알림)
 * POST /api/mcp  → JSON-RPC 메시지 전송 + SSE 응답
 * DELETE /api/mcp → 세션 종료
 *
 * Authorization: Bearer <token> 필수 (설정 > MCP 탭에서 생성)
 */
import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getCore } from '../../../lib/singleton';
import { createFirebatMcpServer } from '../../../mcp/server';

// 활성 세션 관리
const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport }>();

/** Authorization 헤더에서 Bearer 토큰 추출 + 검증 */
function validateBearerToken(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const core = getCore();
  return !!core.validateApiToken(match[1]);
}

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ error: 'Unauthorized — MCP 토큰이 필요합니다. 설정 > MCP 탭에서 토큰을 생성하세요.' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

function serviceDisabledResponse() {
  return new Response(
    JSON.stringify({ error: 'Firebat MCP 서버(앱 개발용)가 비활성화되어 있습니다. 사이드바 > SYSTEM > 서비스 > mcp-server-app에서 활성화하세요.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

function checkServiceEnabled(): boolean {
  return getCore().isModuleEnabled('mcp-server-app');
}

/** POST /api/mcp — JSON-RPC 요청 처리 (초기화 + 일반 메시지) */
export async function POST(req: NextRequest) {
  if (!checkServiceEnabled()) return serviceDisabledResponse();
  if (!validateBearerToken(req)) return unauthorizedResponse();

  const sessionId = req.headers.get('mcp-session-id');

  // 기존 세션이 있으면 재사용
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    return transport.handleRequest(req);
  }

  // 새 세션 생성 (초기화 요청)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });

  const core = getCore();
  const server = createFirebatMcpServer(core);
  await server.connect(transport);

  return transport.handleRequest(req);
}

/** GET /api/mcp — SSE 스트림 (서버→클라이언트 알림용) */
export async function GET(req: NextRequest) {
  if (!checkServiceEnabled()) return serviceDisabledResponse();
  if (!validateBearerToken(req)) return unauthorizedResponse();

  const sessionId = req.headers.get('mcp-session-id');
  if (!sessionId || !sessions.has(sessionId)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing session. Send POST first to initialize.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { transport } = sessions.get(sessionId)!;
  return transport.handleRequest(req);
}

/** DELETE /api/mcp — 세션 종료 */
export async function DELETE(req: NextRequest) {
  if (!checkServiceEnabled()) return serviceDisabledResponse();
  if (!validateBearerToken(req)) return unauthorizedResponse();

  const sessionId = req.headers.get('mcp-session-id');
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.close();
    sessions.delete(sessionId);
  }
  return new Response(null, { status: 204 });
}
