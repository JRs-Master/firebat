import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * GET /api/conversations/trash
 *
 * 휴지통 (soft-deleted) 대화 목록. 최신 삭제 순.
 * 30일 후 internal cron 이 자동 영구 삭제.
 *
 * 응답: { success: true, conversations: [{ id, title, createdAt, updatedAt }] }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const res = await core.listDeletedConversations('admin');
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  }
  const items = (res.data ?? []) as Array<Record<string, unknown>>;
  // proto-loader i64 → string 변환 정규화 (createdAt/updatedAt) — 옛 /api/conversations 와 동일
  return NextResponse.json({
    success: true,
    conversations: items.map(r => {
      const out = { ...r };
      for (const key of ['createdAt', 'updatedAt', 'created_at', 'updated_at']) {
        const v = out[key];
        if (typeof v === 'string' && /^\d+$/.test(v)) out[key] = Number(v);
      }
      return out;
    }),
  });
}
