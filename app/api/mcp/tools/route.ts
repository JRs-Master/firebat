/**
 * MCP 도구 API
 *
 * GET  /api/mcp/tools              — 모든 활성 서버의 도구 목록
 * GET  /api/mcp/tools?server=xxx   — 특정 서버의 도구 목록
 * POST /api/mcp/tools              — 도구 실행 { server, tool, arguments }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

/** GET — 도구 목록 */
export const GET = withAuth(async (req: NextRequest) => {
  const core = getCore();
  const serverName = req.nextUrl.searchParams.get('server');

  const result = serverName
    ? await core.listMcpTools(serverName)
    : await core.listAllMcpTools();

  return result.success
    ? NextResponse.json({ success: true, tools: result.data })
    : NextResponse.json({ success: false, error: result.error }, { status: 500 });
});

/** POST — 도구 실행 */
export const POST = withAuth(async (req: NextRequest) => {
  const { server, tool, arguments: args } = await req.json();
  if (!server || !tool) {
    return NextResponse.json({ success: false, error: 'server, tool 필수' }, { status: 400 });
  }
  const result = await getCore().callMcpTool(server, tool, args ?? {});
  return result.success
    ? NextResponse.json({ success: true, data: result.data })
    : NextResponse.json({ success: false, error: result.error }, { status: 500 });
});
