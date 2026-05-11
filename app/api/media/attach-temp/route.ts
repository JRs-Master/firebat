import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/media/attach-temp
 *
 * 채팅창 첨부 이미지 임시 저장 — sharp 0, raw 그대로. 응답: {slug, url}.
 * 메시지에는 URL slug 만 박힘 → fetch body 작게 유지 → keepalive 안정 (모바일
 * 첨부 첫 시도 실패 root cause fix, 2026-05-11).
 *
 * 갤러리 (/api/media/upload) 와 분리 — 갤러리는 sharp + variants + 영구 저장.
 * 임시 첨부는 30일 retention internal cron 이 자동 cleanup.
 *
 * Body:
 *   { dataUrl: 'data:image/png;base64,...' }
 *
 * 응답: { success: true, data: { slug, url } }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 });
  }
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!dataUrl.startsWith('data:')) {
    return NextResponse.json({ success: false, error: 'dataUrl 가 data URL 형식이 아닙니다.' }, { status: 400 });
  }

  const result = await getCore().saveTempAttachment(dataUrl);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
}
