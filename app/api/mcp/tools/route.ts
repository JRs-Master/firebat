/**
 * MCP 도구 API
 *
 * GET  /api/mcp/tools              — 모든 활성 서버의 도구 목록
 * GET  /api/mcp/tools?server=xxx   — 특정 서버의 도구 목록
 * POST /api/mcp/tools              — 도구 실행 { server, tool, arguments }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

// isDemo는 requireAuth의 auth.role로 확인

/** GET — 도구 목록 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드에서는 MCP를 사용할 수 없습니다.' }, { status: 403 });
  }
  try {
    const core = getCore();
    const serverName = req.nextUrl.searchParams.get('server');

    const result = serverName
      ? await core.listMcpTools(serverName)
      : await core.listAllMcpTools();

    return result.success
      ? NextResponse.json({ success: true, tools: result.data })
      : NextResponse.json({ success: false, error: result.error }, { status: 500 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** POST — 도구 실행 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드에서는 MCP를 사용할 수 없습니다.' }, { status: 403 });
  }
  try {
    const { server, tool, arguments: args } = await req.json();

    if (!server || !tool) {
      return NextResponse.json({ success: false, error: 'server, tool 필수' }, { status: 400 });
    }

    const core = getCore();
    const result = await core.callMcpTool(server, tool, args ?? {});

    return result.success
      ? NextResponse.json({ success: true, data: result.data })
      : NextResponse.json({ success: false, error: result.error }, { status: 500 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
