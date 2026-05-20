/**
 * 템플릿 API (CMS Phase 8b).
 *
 * GET    /api/templates           — 템플릿 목록
 * POST   /api/templates           — 신규/수정 (body: {slug, config})
 */
import { NextRequest, NextResponse } from 'next/server';
import { listTemplates, saveTemplate } from '../../../lib/api-gen/template';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async () => {
  const res = await listTemplates({ owner: '' });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, templates: res.data });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { slug, config } = await req.json();
  if (!slug || !config) {
    return NextResponse.json({ success: false, error: 'slug와 config 가 필요합니다.' }, { status: 400 });
  }
  const res = await saveTemplate({ slug, configJson: JSON.stringify(config ?? {}), owner: '' });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});
