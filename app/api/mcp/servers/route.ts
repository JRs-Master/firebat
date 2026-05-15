/**
 * MCP 서버 관리 API
 *
 * GET    /api/mcp/servers          — 등록된 서버 목록
 * POST   /api/mcp/servers          — 서버 추가/수정
 * DELETE /api/mcp/servers?name=xxx — 서버 제거
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { listMcpServers, addMcpServer, removeMcpServer } from '../../../../lib/api-gen/mcp';

/** GET — 등록된 MCP 서버 목록 */
export const GET = withAuth(async () => {
  const res = await listMcpServers();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, servers: res.data });
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

  const res = await addMcpServer({
    name,
    transport,
    command: command ?? undefined,
    args: args ?? [],
    envJson: JSON.stringify(env ?? {}),
    url: url ?? undefined,
    enabled: enabled !== false,
  });

  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

/** DELETE — MCP 서버 제거 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });

  const res = await removeMcpServer({ name });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});
