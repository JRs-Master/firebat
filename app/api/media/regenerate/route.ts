import { NextRequest, NextResponse } from 'next/server';
import { regenerateImage } from '../../../../lib/api-gen/media';
import { withAuth } from '../../../../lib/with-api-error';

/** POST /api/media/regenerate?slug=<slug>
 *  갤러리에서 재생성 — 기존 메타의 prompt/model 등으로 image_gen 재실행.
 *  성공 시 새 slug 발급 + 기존 slug 제거 (Core 가 처리).
 *  관리자 인증 필수. */
export const POST = withAuth(async (req: NextRequest) => {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });
  }
  const result = await regenerateImage({ slug });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
});
