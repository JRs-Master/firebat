import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/media/generate
 *
 * 어드민 UI 의 "이미지 모드" 토글에서 직접 호출 — LLM 우회 경로.
 * AI 가 image_gen 도구 호출하는 흐름 대비 ~26% 비용 절감 + timeout 위험 0.
 *
 * Body: GenerateImageInput (prompt 필수, 나머지 선택)
 *   { prompt, size?, quality?, model?, aspectRatio?, focusPoint?, filenameHint?, scope? }
 *
 * 응답: GenerateImageResult — render_image 와 동일 포맷 (url, thumbnailUrl, variants, blurhash, slug, modelId)
 *
 * 진행 가시화: Core.generateImage 가 StatusManager job 발행 → SSE 'status:update' → ActiveJobsIndicator 자동 표시.
 * 갤러리: 성공·실패 모두 gallery:refresh emit → GalleryPanel 자동 갱신.
 *
 * 관리자 인증 필수.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return NextResponse.json({ success: false, error: 'prompt 가 비어 있습니다.' }, { status: 400 });
  }

  const input = {
    prompt,
    ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
    ...(typeof body.size === 'string' && body.size ? { size: body.size } : {}),
    ...(typeof body.quality === 'string' && body.quality ? { quality: body.quality } : {}),
    ...(typeof body.aspectRatio === 'string' && body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
    ...(body.focusPoint ? { focusPoint: body.focusPoint } : {}),
    ...(typeof body.filenameHint === 'string' && body.filenameHint ? { filenameHint: body.filenameHint } : {}),
    ...(body.scope === 'system' ? { scope: 'system' as const } : { scope: 'user' as const }),
  };

  const result = await getCore().generateImage(input);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: result.data });
}
