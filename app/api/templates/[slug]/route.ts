/**
 * 템플릿 단건 API.
 *
 * GET    /api/templates/{slug}    — 템플릿 config 조회
 * DELETE /api/templates/{slug}    — 삭제
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTemplate, deleteTemplate } from '../../../../lib/api-gen/template';
import { withAuth } from '../../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const res = await getTemplate({ value: slug });
  if (!res.ok || !res.data) {
    return NextResponse.json({ success: false, error: '템플릿을 찾을 수 없습니다.' }, { status: 404 });
  }
  return NextResponse.json({ success: true, template: res.data });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const res = await deleteTemplate({ value: slug });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});
