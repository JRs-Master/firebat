import { NextRequest, NextResponse } from 'next/server';
import { get as getPage, rename as renamePage } from '../../../../lib/api-gen/page';
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
  return NextResponse.json({ success: true, spec: res.data });
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
