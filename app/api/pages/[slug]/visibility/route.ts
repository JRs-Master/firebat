/**
 * 페이지 visibility 설정 API
 *
 * PATCH /api/pages/:slug/visibility — visibility 변경 (public/password/private)
 * POST  /api/pages/:slug/visibility — 비밀번호 검증 (비인증 사용자용)
 */
import { NextRequest, NextResponse } from 'next/server';
import { setVisibility as setPageVisibility, verifyPassword as verifyPagePassword } from '../../../../../lib/api-gen/page';
import { withApiError, withAuth } from '../../../../../lib/with-api-error';

function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

/** PATCH — visibility 설정 변경 (관리자 전용) */
export const PATCH = withAuth(async (
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) => {
  const slug = safeDecodeSlug((await params).slug);
  const body = await req.json();
  const { visibility, password } = body;

  if (!visibility || !['public', 'password', 'private'].includes(visibility)) {
    return NextResponse.json({ success: false, error: 'visibility는 public, password, private 중 하나' }, { status: 400 });
  }
  if (visibility === 'password' && !password) {
    return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호 필수' }, { status: 400 });
  }

  const res = await setPageVisibility({ slug, visibility, password });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 404 });
});

/** POST — 비밀번호 검증 (비인증 사용자용 — withApiError 만, requireAuth 없음) */
export const POST = withApiError(async (
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) => {
  const slug = safeDecodeSlug((await params).slug);
  const body = await req.json();
  const { password } = body;

  if (!password) {
    return NextResponse.json({ success: false, error: '비밀번호 필수' }, { status: 400 });
  }

  const res = await verifyPagePassword({ slug, password });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 404 });
  }
  return NextResponse.json({ success: true, verified: res.data });
});
