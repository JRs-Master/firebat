import { NextRequest, NextResponse } from 'next/server';
import { createShare } from '../../../lib/api-gen/conversation';
import { withAuth } from '../../../lib/with-api-error';
import { getBaseUrl } from '../../../lib/base-url';

/**
 * POST /api/share — 공유 링크 생성 (인증 필수, admin 만)
 *
 * body: {
 *   type: 'turn' | 'full',
 *   conversationId: string,     // 원본 대화 ID (참조용)
 *   title?: string,              // 공유 제목 (미지정 시 첫 user 메시지 기반 자동)
 *   messages: unknown[],         // 공유 시점 snapshot
 * }
 * → { success: true, slug, url, expiresAt }
 */
export const POST = withAuth(async (req: NextRequest, _ctx, auth) => {
  const body = await req.json();
  const type = body.type === 'turn' ? 'turn' : 'full';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey ? body.dedupKey : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return NextResponse.json({ success: false, error: '공유할 메시지가 없습니다' }, { status: 400 });
  }

  // title — 생성자가 명시 전달하면 사용, 없으면 generic (사용자 원문을 title 로 노출하지 않음)
  const title: string = typeof body.title === 'string' && body.title
    ? body.title
    : (type === 'turn' ? '공유된 응답' : '공유된 대화');

  const res = await createShare({
    shareType: type,
    title,
    messagesJson: JSON.stringify(messages),
    owner: auth.role,
    sourceConvId: conversationId,
    dedupKey,
  });
  if (!res.ok || !res.data || !res.data.slug) {
    return NextResponse.json(
      { success: false, error: res.ok ? '공유 생성 실패' : res.message },
      { status: 500 },
    );
  }
  const base = getBaseUrl(req);
  return NextResponse.json({
    success: true,
    slug: res.data.slug,
    url: `${base}/share/${res.data.slug}`,
    expiresAt: typeof res.data.expiresAt === 'bigint' ? Number(res.data.expiresAt) : res.data.expiresAt,
    reused: res.data.reused === true,
  });
});
