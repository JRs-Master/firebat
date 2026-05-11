import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/conversations/restore
 *
 * 휴지통 → 활성 복원. deleted_at NULL 박음 + tombstone 제거 (다기기 동기화 정상화).
 *
 * Body: { id: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await getCore().restoreConversation('admin', id);
  return res.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.error }, { status: 500 });
}
