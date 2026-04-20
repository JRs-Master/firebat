import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const result = await getCore().getPage(slug);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 });
  }
  return NextResponse.json({ success: true, spec: result.data });
}

/** 페이지 slug 변경 — body: { newSlug, setRedirect?: boolean } */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const rawSlug = (await params).slug;
  const oldSlug = safeDecodeSlug(rawSlug);
  let body: { newSlug?: string; setRedirect?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'JSON 파싱 실패' }, { status: 400 }); }
  if (!body.newSlug) return NextResponse.json({ success: false, error: 'newSlug 누락' }, { status: 400 });
  const res = await getCore().renamePage(oldSlug, body.newSlug, { setRedirect: !!body.setRedirect });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 400 });
  return NextResponse.json({ success: true, data: res.data });
}
