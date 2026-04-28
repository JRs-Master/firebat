/**
 * 템플릿 API (CMS Phase 8b).
 *
 * GET    /api/templates           — 템플릿 목록
 * POST   /api/templates           — 신규/수정 (body: {slug, config})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const list = await getCore().listTemplates();
  return NextResponse.json({ success: true, templates: list });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { slug, config } = await req.json();
    if (!slug || !config) {
      return NextResponse.json({ success: false, error: 'slug와 config 가 필요합니다.' }, { status: 400 });
    }
    const res = await getCore().saveTemplate(slug, config);
    if (!res.success) {
      return NextResponse.json({ success: false, error: res.error }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
