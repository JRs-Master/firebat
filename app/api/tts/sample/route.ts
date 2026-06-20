import { NextRequest, NextResponse } from 'next/server';
import { synthesizeSample } from '../../../../lib/api-gen/media';
import { withAuth } from '../../../../lib/with-api-error';

/**
 * POST /api/tts/sample
 *
 * 어드민 설정 음성(TTS) 탭의 보이스 picker — 후보 보이스로 짧은 문장을 합성해 미리듣기.
 * 저장 안 함 (transient). browser provider 는 클라 Web Speech 라 이 경로 안 옴.
 *
 * Body: { provider, model?, voice, text? }
 * 응답: { success, audioBase64, contentType } — 클라가 data URL 로 <audio> 재생.
 *
 * 관리자 인증 필수.
 */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 });
  }
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const voice = typeof body.voice === 'string' ? body.voice : '';
  const model = typeof body.model === 'string' ? body.model : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!provider || provider === 'browser') {
    return NextResponse.json({ success: false, error: 'provider(openai/gemini) 필요' }, { status: 400 });
  }

  const result = await synthesizeSample({ provider, model, voice, text });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    audioBase64: result.data.audioBase64,
    contentType: result.data.contentType,
  });
});
