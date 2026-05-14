import { NextRequest, NextResponse } from 'next/server';
import { restoreConversation } from '../../../../lib/api-gen/conversation';
import { withAuth } from '../../../../lib/with-api-error';

/**
 * POST /api/conversations/restore
 *
 * 휴지통 → 활성 복원. deleted_at NULL 처리 + tombstone 제거 (다기기 동기화 정상화).
 *
 * Body: { id: string }
 */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await restoreConversation({ owner: 'admin', id });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});
