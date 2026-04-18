/**
 * MCP Internal Endpoint — LLM 통신용 MCP 서버
 *
 * OpenAI Responses API (hosted MCP connector), Claude API 등 외부 LLM이 연결.
 * 외부용(/api/mcp)과 별도 토큰 (system:internal-mcp-token) 사용.
 *
 * Authorization: Bearer <token> 필수.
 */
import { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getCore } from '../../../lib/singleton';
import { createInternalMcpServer } from '../../../mcp/internal-server';

const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport }>();

function validateBearerToken(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const core = getCore();
  const stored = core.getGeminiKey('system:internal-mcp-token');
  return !!stored && stored === match[1];
}

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ error: 'Unauthorized — 내부 MCP 토큰 필요. 설정 > MCP > LLM 통신용 탭에서 생성.' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function POST(req: NextRequest) {
  if (!validateBearerToken(req)) return unauthorizedResponse();

  const sessionId = req.headers.get('mcp-session-id');
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    return transport.handleRequest(req);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, { transport }); },
    onsessionclosed: (id) => { sessions.delete(id); },
  });

  const core = getCore();
  const server = createInternalMcpServer(core);
  await server.connect(transport);

  return transport.handleRequest(req);
}

export async function GET(req: NextRequest) {
  if (!validateBearerToken(req)) return unauthorizedResponse();
  const sessionId = req.headers.get('mcp-session-id');
  if (!sessionId || !sessions.has(sessionId)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing session. POST first to initialize.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const { transport } = sessions.get(sessionId)!;
  return transport.handleRequest(req);
}

export async function DELETE(req: NextRequest) {
  if (!validateBearerToken(req)) return unauthorizedResponse();
  const sessionId = req.headers.get('mcp-session-id');
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.close();
    sessions.delete(sessionId);
  }
  return new Response(null, { status: 204 });
}
