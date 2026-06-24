import { NextRequest, NextResponse } from 'next/server';
import { get as getPage, rename as renamePage } from '../../../../lib/api-gen/page';
import { unwrapPageSpec } from '../../../../lib/util/page-pb-convert';
import { withAuth } from '../../../../lib/with-api-error';

function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

export const GET = withAuth(async (
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) => {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const res = await getPage({ slug });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 404 });
  }
  // inner PageSpec 만 반환(+double-wrap 복구) — 옛날엔 raw PageRecordPb(`{$typeName,slug,spec,...}`)를
  // 그대로 줘서 편집기가 PB 를 들고 재저장 → spec 컬럼에 PB 통째 = double-wrap 이었음. unwrapPageSpec 으로 차단.
  return NextResponse.json({ success: true, spec: unwrapPageSpec(res.data?.spec) });
});

/** 페이지 slug 변경 — body: { newSlug, setRedirect?: boolean } */
export const PATCH = withAuth(async (
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) => {
  const rawSlug = (await params).slug;
  const oldSlug = safeDecodeSlug(rawSlug);
  const body = await req.json().catch(() => null) as { newSlug?: string; setRedirect?: boolean } | null;
  if (!body?.newSlug) return NextResponse.json({ success: false, error: 'newSlug 누락' }, { status: 400 });
  const res = await renamePage({ oldSlug, newSlug: body.newSlug, setRedirect: !!body.setRedirect });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 400 });
  return NextResponse.json({ success: true, data: res.data });
});
