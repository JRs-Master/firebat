import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

/**
 * POST /api/conversations/permanent-delete
 *
 * 휴지통 안 대화 영구 삭제 — row + 임베딩 cascade. tombstone 박힌 그대로
 * (다기기 stale POST 차단).
 *
 * Body: { id: string }
 */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await getCore().permanentDeleteConversation('admin', id);
  return res.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.error }, { status: 500 });
});
