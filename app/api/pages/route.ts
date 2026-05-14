import { NextRequest, NextResponse } from 'next/server';
import { listPages, savePage, deletePage } from '../../../lib/api-gen/page';
import { withAuth } from '../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const res = await listPages();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, pages: res.data });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { slug, spec } = await req.json();
  if (!slug || !spec) {
    return NextResponse.json({ success: false, error: 'slug와 spec이 필요합니다.' }, { status: 400 });
  }
  const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
  const res = await savePage({ slug, spec: specStr });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});

export const PUT = withAuth(async (req: NextRequest) => {
  const { slug, spec } = await req.json();
  if (!slug || !spec) {
    return NextResponse.json({ success: false, error: 'slug와 spec이 필요합니다.' }, { status: 400 });
  }
  const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
  // REST PUT semantic = update/replace. 어드민이 모나코 에디터 등으로 명시적으로
  // "이 페이지 수정" 의도. (AI 의 save_page tool 은 -N 접미사 자동 — 실수성 덮어쓰기 차단.)
  const res = await savePage({ slug, spec: specStr });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });
  }
  const res = await deletePage({ value: slug });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});
