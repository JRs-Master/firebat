/**
 * MCP 서버 관리 API
 *
 * GET    /api/mcp/servers          — 등록된 서버 목록
 * POST   /api/mcp/servers          — 서버 추가/수정
 * DELETE /api/mcp/servers?name=xxx — 서버 제거
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

// isDemo는 requireAuth의 auth.role로 확인

/** GET — 등록된 MCP 서버 목록 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const core = getCore();
    const servers = core.listMcpServers();
    return NextResponse.json({ success: true, servers });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** POST — MCP 서버 추가/수정 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드에서는 설정을 변경할 수 없습니다.' }, { status: 403 });
  }
  try {
    const body = await req.json();
    const { name, transport, command, args, env, url, enabled } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ success: false, error: 'name 필수' }, { status: 400 });
    }
    if (!transport || !['stdio', 'sse'].includes(transport)) {
      return NextResponse.json({ success: false, error: 'transport는 stdio 또는 sse' }, { status: 400 });
    }

    const core = getCore();
    const result = await core.addMcpServer({
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
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** DELETE — MCP 서버 제거 */
export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드에서는 설정을 변경할 수 없습니다.' }, { status: 403 });
  }
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });

  const core = getCore();
  const result = await core.removeMcpServer(name);
  return result.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: result.error }, { status: 500 });
}
