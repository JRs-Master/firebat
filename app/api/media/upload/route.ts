import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/media/upload
 *
 * 사용자가 채팅창에 첨부한 이미지 → 갤러리에 저장 (사용자 토글 ON 시).
 * 자동 저장 아님 — UI 토글 명시 활성 시에만 호출.
 *
 * Body:
 *   { dataUrl: 'data:image/png;base64,...', filenameHint?: string, scope?: 'user' | 'system' }
 *
 * 응답: { success: true, data: { slug, url } }
 *
 * 갤러리 자동 갱신: gallery:refresh emit (Core.saveUpload 가 처리).
 * 메타에 source: 'upload' 자동 마킹 — AI 생성 이미지와 시각·필터 구분.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 });
  }
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!dataUrl.startsWith('data:')) {
    return NextResponse.json({ success: false, error: 'dataUrl 가 data URL 형식이 아닙니다.' }, { status: 400 });
  }

  const result = await getCore().saveUpload({
    binary: dataUrl,
    ...(typeof body.filenameHint === 'string' && body.filenameHint ? { filenameHint: body.filenameHint } : {}),
    scope: body.scope === 'system' ? 'system' : 'user',
  });
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
}
