/**
 * 페이지 visibility 설정 API
 *
 * PATCH /api/pages/:slug/visibility — visibility 변경 (public/password/private)
 * POST  /api/pages/:slug/visibility — 비밀번호 검증 (비인증 사용자용)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../../lib/auth-guard';

function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

/** PATCH — visibility 설정 변경 (관리자 전용) */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const slug = safeDecodeSlug((await params).slug);
  const body = await req.json();
  const { visibility, password } = body;

  if (!visibility || !['public', 'password', 'private'].includes(visibility)) {
    return NextResponse.json({ success: false, error: 'visibility는 public, password, private 중 하나' }, { status: 400 });
  }
  if (visibility === 'password' && !password) {
    return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호 필수' }, { status: 400 });
  }

  const core = getCore();
  const result = await core.setPageVisibility(slug, visibility, password);
  return result.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: result.error }, { status: 404 });
}

/** POST — 비밀번호 검증 (비인증 사용자용 — requireAuth 없음) */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const slug = safeDecodeSlug((await params).slug);
  const body = await req.json();
  const { password } = body;

  if (!password) {
    return NextResponse.json({ success: false, error: '비밀번호 필수' }, { status: 400 });
  }

  const core = getCore();
  const result = await core.verifyPagePassword(slug, password);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 });
  }
  return NextResponse.json({ success: true, verified: result.data });
}
