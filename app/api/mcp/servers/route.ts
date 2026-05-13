/**
 * MCP 서버 관리 API
 *
 * GET    /api/mcp/servers          — 등록된 서버 목록
 * POST   /api/mcp/servers          — 서버 추가/수정
 * DELETE /api/mcp/servers?name=xxx — 서버 제거
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

/** GET — 등록된 MCP 서버 목록 */
export const GET = withAuth(async () => {
  const servers = await getCore().listMcpServers();
  return NextResponse.json({ success: true, servers });
});

/** POST — MCP 서버 추가/수정 */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { name, transport, command, args, env, url, enabled } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ success: false, error: 'name 필수' }, { status: 400 });
  }
  if (!transport || !['stdio', 'sse'].includes(transport)) {
    return NextResponse.json({ success: false, error: 'transport는 stdio 또는 sse' }, { status: 400 });
  }

  const result = await getCore().addMcpServer({
    name,
    transport,
    command,
    args,
    env,
    url,
    enabled: enabled !== false,
  });

  return result.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: result.error }, { status: 500 });
});

/** DELETE — MCP 서버 제거 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });

  const result = await getCore().removeMcpServer(name);
  return result.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: result.error }, { status: 500 });
});
