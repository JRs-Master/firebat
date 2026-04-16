/**
 * Google OAuth 콜백 엔드포인트
 *
 * GET /api/mcp/auth/callback?code=xxx&state=gmail
 * Google이 인증 후 리다이렉트 → 토큰 교환 → credentials 저장 → 창 자동 닫기
 */
import { NextRequest } from 'next/server';
import { readOAuthKeys, getServiceConfig, getOrigin } from '../route';
import { requireAuth, isAuthError } from '../../../../../lib/auth-guard';
import { DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS } from '../../../../../infra/config';

function getFs(): typeof import('fs') { return require('fs'); }
function getPath(): typeof import('path') { return require('path'); }

function htmlResponse(title: string, body: string, type: 'success' | 'error' | 'info' = 'success') {
  const colors = { success: '#3b82f6', error: '#ef4444', info: '#64748b' };
  const icons = { success: '&#10004;', error: '&#10060;', info: '&#8505;' };
  const autoClose = type === 'success';
  return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Firebat — ${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f8fafc; color: #1e293b; }
  .card { text-align: center; padding: 3rem 2.5rem; border-radius: 1rem; background: #fff; border: 1px solid #e2e8f0; box-shadow: 0 4px 24px rgba(0,0,0,0.06); max-width: 400px; width: 90vw; }
  .icon { width: 56px; height: 56px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 1.25rem; background: ${colors[type]}15; color: ${colors[type]}; }
  h2 { font-size: 1.15rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem; }
  p { color: #64748b; font-size: 0.875rem; line-height: 1.6; }
  .brand { margin-top: 2rem; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.15em; color: #cbd5e1; text-transform: uppercase; }
</style></head>
<body><div class="card">
  <div class="icon">${icons[type]}</div>
  <h2>${title}</h2>
  <p>${body}</p>
  <div class="brand">Firebat</div>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'mcp-oauth-done', success: ${type === 'success'} }, window.location.origin);
    ${autoClose ? "setTimeout(() => window.close(), 1500);" : ''}
  }
</script>
</body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');

  // 파라미터 없이 직접 접속한 경우
  if (!code && !state && !error) {
    return htmlResponse('OAuth 콜백 페이지', '이 페이지는 Google 인증 과정에서 자동으로 사용됩니다. 직접 접속할 필요가 없습니다.', 'info');
  }

  if (error) {
    return htmlResponse('인증 실패', `Google 오류: ${error}`, 'error');
  }

  if (!code || !state) {
    return htmlResponse('인증 실패', 'code 또는 state 파라미터가 없습니다.', 'error');
  }

  const service = getServiceConfig(state);
  if (!service) {
    return htmlResponse('인증 실패', `알 수 없는 서비스: ${state}`, 'error');
  }

  const keys = readOAuthKeys();
  if (!keys) {
    return htmlResponse('인증 실패', 'OAuth 키 파일을 읽을 수 없습니다.', 'error');
  }

  const redirectUri = `${getOrigin(req)}/api/mcp/auth/callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: keys.clientId,
        client_secret: keys.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      return htmlResponse('토큰 교환 실패', tokenData.error_description || tokenData.error || '알 수 없는 오류', 'error');
    }

    const credentials = {
      type: 'authorized_user',
      client_id: keys.clientId,
      client_secret: keys.clientSecret,
      refresh_token: tokenData.refresh_token,
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      expiry_date: Date.now() + (tokenData.expires_in ?? DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS) * 1000,
    };

    const credJson = JSON.stringify(credentials, null, 2);
    const f = getFs();
    const p = getPath();
    const credDir = p.dirname(service.credentialsPath);
    if (!f.existsSync(credDir)) f.mkdirSync(credDir, { recursive: true });
    f.writeFileSync(service.credentialsPath, credJson, 'utf-8');
    if (service.legacyPaths) {
      for (const lp of service.legacyPaths) {
        const lpDir = p.dirname(lp);
        if (!f.existsSync(lpDir)) f.mkdirSync(lpDir, { recursive: true });
        f.writeFileSync(lp, credJson, 'utf-8');
      }
    }

    return htmlResponse('인증 완료!', '창이 자동으로 닫힙니다. 닫히지 않으면 수동으로 닫아주세요.');
  } catch (err: any) {
    return htmlResponse('오류 발생', err.message, 'error');
  }
}
