import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../../../lib/singleton';
import { getOAuthProvider } from '../../../../../../lib/oauth-providers';
import * as nodeCrypto from 'crypto';

/** state 비교 — timing-safe 동일 길이만 통과. CSRF 방지. */
function statesMatch(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * GET /api/auth/oauth/[provider]/callback — OAuth 콜백 (generic).
 *
 * 인증 후 리다이렉트되며, authorization code 를 받아 token 발급 + Vault 저장.
 *
 * provider 측 등록 (예: 카카오 디벨로퍼스 → 내 애플리케이션 → 카카오 로그인 → Redirect URI):
 *   `{도메인}/api/auth/oauth/<provider>/callback`
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerId } = await params;
  const config = getOAuthProvider(providerId);
  if (!config) {
    return redirectToAdmin(`미등록 OAuth provider: ${providerId}`, 'error');
  }

  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const stateFromQuery = req.nextUrl.searchParams.get('state');
  const stateCookieName = `oauth_state_${providerId}`;
  const stateFromCookie = req.cookies.get(stateCookieName)?.value;

  if (error) {
    return redirectToAdmin(`${config.label} 로그인이 취소되었습니다.`, 'error');
  }
  if (!code) {
    return redirectToAdmin('인증 코드가 없습니다.', 'error');
  }
  // CSRF — state 검증
  if (!stateFromQuery || !stateFromCookie || !statesMatch(stateFromQuery, stateFromCookie)) {
    return redirectToAdmin('OAuth state 검증 실패 — CSRF 의심. 다시 시도해주세요.', 'error');
  }

  const core = getCore();
  const apiKey = await core.getUserSecret(config.apiKeyVaultKey);
  if (!apiKey) {
    return redirectToAdmin(`${config.apiKeyVaultKey} 가 Vault 에 없습니다.`, 'error');
  }
  const clientSecret = config.clientSecretVaultKey
    ? await core.getUserSecret(config.clientSecretVaultKey)
    : null;

  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/oauth/${providerId}/callback`;

  try {
    const tokenParams: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: apiKey,
      redirect_uri: redirectUri,
      code,
    };
    if (clientSecret) tokenParams.client_secret = clientSecret;

    const tokenResp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return redirectToAdmin(`토큰 발급 실패: ${tokenResp.status} ${errText}`, 'error');
    }

    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    const { access_token, refresh_token } = tokenData;

    if (!access_token) {
      return redirectToAdmin('액세스 토큰이 응답에 없습니다.', 'error');
    }

    await core.setUserSecret(config.accessTokenVaultKey, access_token);
    if (refresh_token && config.refreshTokenVaultKey) {
      await core.setUserSecret(config.refreshTokenVaultKey, refresh_token);
    }

    const res = redirectToAdmin(config.successMessage, 'success');
    res.cookies.delete(stateCookieName); // state 1회용 — 즉시 폐기
    return res;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return redirectToAdmin(`토큰 교환 중 오류: ${msg}`, 'error');
  }
}

/** 어드민 페이지로 리다이렉트 (결과 메시지 HTML 표시). */
function redirectToAdmin(message: string, status: 'success' | 'error'): NextResponse {
  const color = status === 'success' ? '#16a34a' : '#dc2626';
  const icon = status === 'success' ? '&#10003;' : '&#10007;';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth 연동</title></head>
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
