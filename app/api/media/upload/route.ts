import { NextRequest, NextResponse } from 'next/server';
import { saveUpload } from '../../../../lib/api-gen/media';
import { withAuth } from '../../../../lib/with-api-error';

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
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 });
  }
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!dataUrl.startsWith('data:')) {
    return NextResponse.json({ success: false, error: 'dataUrl 가 data URL 형식이 아닙니다.' }, { status: 400 });
  }

  // MediaSaveRequest { binaryBase64, contentType, optsJson }
  // dataUrl 형식: 'data:image/png;base64,...' — content type 추출 + base64 부분만 분리.
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  const contentType = m ? m[1] : 'application/octet-stream';
  const binaryBase64 = m ? m[2] : '';
  const opts: Record<string, unknown> = {
    scope: body.scope === 'system' ? 'system' : 'user',
  };
  if (typeof body.filenameHint === 'string' && body.filenameHint) opts.filenameHint = body.filenameHint;

  const result = await saveUpload({
    binaryBase64,
    contentType,
    optsJson: JSON.stringify(opts),
  } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
});
