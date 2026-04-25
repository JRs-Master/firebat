import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * GET /api/media/usage?slug=<media-slug>
 *
 * 미디어 slug 의 사용처 — 어떤 페이지에 박혀있는지.
 * 갤러리 모달 메타 표시 + 삭제 confirm 차등화에 사용.
 *
 * 응답: { success: true, data: [{ pageSlug, usedAt }] }
 *
 * 인덱스: PageManager.save 시 PageSpec 안 미디어 URL 자동 추출 → media_usage 테이블 갱신.
 *        page delete 시 해당 page_slug 의 사용 관계 일괄 정리.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ success: false, error: 'slug 파라미터 필요' }, { status: 400 });
  }
  const usage = await getCore().findMediaUsage(slug);
  return NextResponse.json({ success: true, data: usage });
}
