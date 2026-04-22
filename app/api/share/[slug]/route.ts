import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * GET /api/share/[slug] — 공개 읽기 엔드포인트 (인증 없음).
 * proxy.ts 의 public 화이트리스트에 등록되어 있어 Bearer/쿠키 체크 면제.
 *
 * 만료된 공유는 null 반환 → /share/[slug] 페이지가 404 or 만료 안내 렌더.
 * 봇 색인 방지 위해 X-Robots-Tag 헤더 추가.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const core = getCore();
  const res = await core.getShare(slug);
  const headers = { 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500, headers });
  }
  if (!res.data) {
    return NextResponse.json({ success: false, error: '만료되었거나 존재하지 않는 공유' }, { status: 404, headers });
  }
  return NextResponse.json({ success: true, share: res.data }, { headers });
}
