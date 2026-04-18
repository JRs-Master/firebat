import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

/**
 * /api/conversations — admin 계정 대화 히스토리 CRUD (다기기 동기화)
 * demo 역할은 차단 (user 계정은 로컬스토리지만 사용).
 */
function assertAdmin(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role !== 'admin') {
    return NextResponse.json({ success: false, error: 'admin 전용 API' }, { status: 403 });
  }
  return auth;
}

/** GET — 전체 목록 또는 ?id=xxx 단건 */
export async function GET(req: NextRequest) {
  const auth = assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const id = req.nextUrl.searchParams.get('id');
  const core = getCore();
  if (id) {
    const res = await core.getConversation('admin', id);
    return res.success
      ? NextResponse.json({ success: true, conversation: res.data })
      : NextResponse.json({ success: false, error: res.error }, { status: 404 });
  }
  const res = await core.listConversations('admin');
  return res.success
    ? NextResponse.json({ success: true, conversations: res.data ?? [] })
    : NextResponse.json({ success: false, error: res.error }, { status: 500 });
}

/** POST — 대화 저장/갱신 (upsert) */
export async function POST(req: NextRequest) {
  const auth = assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const { id, title, messages, createdAt } = body as { id?: string; title?: string; messages?: unknown[]; createdAt?: number };
    if (!id || !title || !Array.isArray(messages)) {
      return NextResponse.json({ success: false, error: 'id, title, messages 필수' }, { status: 400 });
    }
    const res = await getCore().saveConversation('admin', id, title, messages, createdAt);
    return res.success
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: res.error }, { status: 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/** DELETE — ?id=xxx 삭제 */
export async function DELETE(req: NextRequest) {
  const auth = assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await getCore().deleteConversation('admin', id);
  return res.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.error }, { status: 500 });
}
