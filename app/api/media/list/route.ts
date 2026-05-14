import { NextRequest, NextResponse } from 'next/server';
import { listMedia, removeMedia } from '../../../../lib/api-gen/media';
import { withAuth } from '../../../../lib/with-api-error';

/** GET /api/media/list?scope=user|system|all&limit=50&offset=0&search=foo
 *  갤러리용 미디어 목록 — 관리자 인증 필수.
 */
export const GET = withAuth(async (req: NextRequest) => {
  const url = req.nextUrl;
  const scopeRaw = url.searchParams.get('scope');
  const scope: 'user' | 'system' | 'all' | undefined =
    scopeRaw === 'user' || scopeRaw === 'system' || scopeRaw === 'all' ? scopeRaw : undefined;
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const search = url.searchParams.get('search') || undefined;

  const result = await listMedia({ optsJson: JSON.stringify({ scope, limit, offset, search }) } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, items: result.data?.items ?? [], total: result.data?.total ?? 0 });
});

/** DELETE /api/media/list?slug=2026-04-24-foo-abcd — 갤러리에서 삭제 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });
  }
  const result = await removeMedia({ value: slug } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});
