import { NextRequest, NextResponse } from 'next/server';
import { getUser as getUserSecret } from '../../../../../lib/api-gen/secret';
import { getOAuthProvider } from '../../../../../lib/oauth-providers';
import * as nodeCrypto from 'crypto';

/**
 * GET /api/auth/oauth/[provider] — OAuth 인증 시작 (generic).
 *
 * 사전 조건: Vault 에 provider 의 `apiKeyVaultKey` 등록.
 * CSRF 방지: random state 생성 → httpOnly 쿠키 (10분) → 쿠키와 callback state 비교.
 *
 * provider registry: `lib/oauth-providers.ts`
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerId } = await params;
  const config = getOAuthProvider(providerId);
  if (!config) {
    return NextResponse.json(
      { success: false, error: `미등록 OAuth provider: ${providerId}` },
      { status: 404 },
    );
  }

  const apiKeyRes = await getUserSecret({ name: config.apiKeyVaultKey });
  if (!apiKeyRes.ok || !apiKeyRes.data) {
    return NextResponse.json(
      { success: false, error: `${config.apiKeyVaultKey}를 먼저 API 키 설정에서 등록해주세요.` },
      { status: 400 },
    );
  }
  const apiKey = apiKeyRes.data;

  // 콜백 URL — 현재 호스트 기준 동적 생성
  const host = req.headers.get('host') || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth/oauth/${providerId}/callback`;

  // CSRF state — 32 byte hex
  const state = nodeCrypto.randomBytes(32).toString('hex');

  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set('client_id', apiKey);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', config.scope);
  authUrl.searchParams.set('state', state);

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set({
    name: `oauth_state_${providerId}`,
    value: state,
    httpOnly: true,
    secure: !host.startsWith('localhost'),
    sameSite: 'lax', // OAuth redirect 흐름은 lax 가 안전 (strict 면 callback 시 cookie 미전달)
    path: '/',
    maxAge: 600, // 10분
  });
  return res;
}
