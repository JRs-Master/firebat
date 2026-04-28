/**
 * 템플릿 단건 API.
 *
 * GET    /api/templates/{slug}    — 템플릿 config 조회
 * DELETE /api/templates/{slug}    — 삭제
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { slug } = await params;
  const config = await getCore().getTemplate(slug);
  if (!config) {
    return NextResponse.json({ success: false, error: '템플릿을 찾을 수 없습니다.' }, { status: 404 });
  }
  return NextResponse.json({ success: true, template: config });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { slug } = await params;
  const res = await getCore().deleteTemplate(slug);
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
