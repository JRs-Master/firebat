/**
 * MCP 도구 API
 *
 * GET  /api/mcp/tools              — 모든 활성 서버의 도구 목록
 * GET  /api/mcp/tools?server=xxx   — 특정 서버의 도구 목록
 * POST /api/mcp/tools              — 도구 실행 { server, tool, arguments }
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { listMcpTools, listAllMcpTools, callMcpTool } from '../../../../lib/api-gen/mcp';

/** GET — 도구 목록 */
export const GET = withAuth(async (req: NextRequest) => {
  const serverName = req.nextUrl.searchParams.get('server');

  const res = serverName
    ? await listMcpTools({ value: serverName })
    : await listAllMcpTools();

  return res.ok
    ? NextResponse.json({ success: true, tools: res.data })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

/** POST — 도구 실행 */
export const POST = withAuth(async (req: NextRequest) => {
  const { server, tool, arguments: args } = await req.json();
  if (!server || !tool) {
    return NextResponse.json({ success: false, error: 'server, tool 필수' }, { status: 400 });
  }
  const res = await callMcpTool({ server, tool, argumentsJson: JSON.stringify(args ?? {}) });
  return res.ok
    ? NextResponse.json({ success: true, data: res.data })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});
