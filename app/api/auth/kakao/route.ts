import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * GET /api/auth/kakao — 카카오 OAuth 인증 시작
 *
 * Vault에 저장된 REST API 키를 사용하여 카카오 로그인 페이지로 리다이렉트.
 * 사전 조건: Vault에 user:KAKAO_REST_API_KEY 저장 필요.
 */
export async function GET(req: NextRequest) {
  const core = getCore();
  const restApiKey = core.getUserSecret('KAKAO_REST_API_KEY');

  if (!restApiKey) {
    return NextResponse.json(
      { success: false, error: 'KAKAO_REST_API_KEY를 먼저 API 키 설정에서 등록해주세요.' },
      { status: 400 },
    );
  }

  // 콜백 URL: 현재 호스트 기준으로 동적 생성
  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/kakao/callback`;

  const kakaoAuthUrl = new URL('https://kauth.kakao.com/oauth/authorize');
  kakaoAuthUrl.searchParams.set('client_id', restApiKey);
  kakaoAuthUrl.searchParams.set('redirect_uri', redirectUri);
  kakaoAuthUrl.searchParams.set('response_type', 'code');
  kakaoAuthUrl.searchParams.set('scope', 'talk_message');

  return NextResponse.redirect(kakaoAuthUrl.toString());
}
