import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../../lib/singleton';
import * as nodeCrypto from 'crypto';

/** state 비교 — timing-safe 동일 길이만 통과. CSRF 방지. */
function statesMatch(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * GET /api/auth/kakao/callback — 카카오 OAuth 콜백
 *
 * 카카오 로그인 후 리다이렉트되며, authorization code를 받아서
 * 액세스 토큰 + 리프레시 토큰을 발급받고 Vault에 저장.
 *
 * 카카오 디벨로퍼스 → 내 애플리케이션 → 카카오 로그인 → Redirect URI에
 * `{도메인}/api/auth/kakao/callback` 등록 필요.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const stateFromQuery = req.nextUrl.searchParams.get('state');
  const stateFromCookie = req.cookies.get('kakao_oauth_state')?.value;

  // 사용자가 동의를 거부한 경우
  if (error) {
    return redirectToAdmin('카카오 로그인이 취소되었습니다.', 'error');
  }

  if (!code) {
    return redirectToAdmin('인증 코드가 없습니다.', 'error');
  }

  // CSRF — state 검증 (cookie 와 query 일치). 일치하지 않으면 정상 흐름 아님.
  if (!stateFromQuery || !stateFromCookie || !statesMatch(stateFromQuery, stateFromCookie)) {
    return redirectToAdmin('OAuth state 검증 실패 — CSRF 의심. 다시 시도해주세요.', 'error');
  }

  const core = getCore();
  const restApiKey = core.getUserSecret('KAKAO_REST_API_KEY');
  const clientSecret = core.getUserSecret('KAKAO_CLIENT_SECRET');

  if (!restApiKey) {
    return redirectToAdmin('KAKAO_REST_API_KEY가 Vault에 없습니다.', 'error');
  }

  // 콜백 URL 재구성 (토큰 교환 시 동일한 redirect_uri 필요)
  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/kakao/callback`;

  try {
    // authorization code → 액세스 토큰 교환
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: restApiKey,
      redirect_uri: redirectUri,
      code,
    };
    if (clientSecret) params.client_secret = clientSecret;

    const tokenResp = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return redirectToAdmin(`토큰 발급 실패: ${tokenResp.status} ${errText}`, 'error');
    }

    const tokenData = await tokenResp.json();
    const { access_token, refresh_token } = tokenData;

    if (!access_token) {
      return redirectToAdmin('액세스 토큰이 응답에 없습니다.', 'error');
    }

    // Vault에 토큰 저장
    core.setUserSecret('KAKAO_ACCESS_TOKEN', access_token);
    if (refresh_token) {
      core.setUserSecret('KAKAO_REFRESH_TOKEN', refresh_token);
    }

    const res = redirectToAdmin('카카오톡 연동 완료! 토큰이 저장되었습니다.', 'success');
    res.cookies.delete('kakao_oauth_state');  // state 1회용 — 즉시 폐기
    return res;
  } catch (e: any) {
    return redirectToAdmin(`토큰 교환 중 오류: ${e.message}`, 'error');
  }
}

/** 어드민 페이지로 리다이렉트 (결과 메시지를 HTML로 표시) */
function redirectToAdmin(message: string, status: 'success' | 'error') {
  const color = status === 'success' ? '#16a34a' : '#dc2626';
  const icon = status === 'success' ? '&#10003;' : '&#10007;';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>카카오 연동</title></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui;background:#f8fafc">
<div style="text-align:center;padding:2rem;border-radius:1rem;background:white;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:400px">
<div style="font-size:3rem;color:${color}">${icon}</div>
<p style="font-size:1.1rem;font-weight:700;color:#1e293b;margin:1rem 0 0.5rem">${message}</p>
<p style="color:#64748b;font-size:0.875rem">이 창은 자동으로 닫힙니다.</p>
</div>
<script>setTimeout(()=>{window.close();if(!window.closed)location.href='/admin'},2000)</script>
</body></html>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
