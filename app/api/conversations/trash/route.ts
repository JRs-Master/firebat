import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';
import { normalizeTimestamps } from '../../../../lib/util';

/**
 * GET /api/conversations/trash
 *
 * 휴지통 (soft-deleted) 대화 목록. 최신 삭제 순.
 * 30일 후 internal cron 이 자동 영구 삭제.
 *
 * 응답: { success: true, conversations: [{ id, title, createdAt, updatedAt }] }
 */
export const GET = withAuth(async () => {
  const res = await getCore().listDeletedConversations('admin');
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  }
  const items = (res.data ?? []) as Array<Record<string, unknown>>;
  return NextResponse.json({
    success: true,
    conversations: items.map(item => normalizeTimestamps(item)),
  });
});
