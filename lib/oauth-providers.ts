/**
 * OAuth provider registry — single source.
 *
 * 새 provider 추가 시:
 *   1. 본 파일에 entry 추가 (id / authUrl / tokenUrl / scope / vault key)
 *   2. SystemModuleSettings 의 oauth 필드에서 `oauthUrl: '/api/auth/oauth/<id>'` 사용
 *
 * Generic route (`/api/auth/oauth/[provider]/route.ts` + `[provider]/callback/route.ts`) 가
 * 본 registry 를 read 해서 동작. provider-specific route 박지 마라.
 */

export type OAuthProviderConfig = {
  /** provider 식별자 — URL path 의 `[provider]` 와 일치. 예: 'kakao'. */
  id: string;
  /** 사용자 노출용 한국어 이름. */
  label: string;
  /** OAuth authorize endpoint — `client_id` / `redirect_uri` / `scope` / `state` query 자동 추가. */
  authUrl: string;
  /** OAuth token endpoint — POST x-www-form-urlencoded {grant_type, client_id, client_secret?, redirect_uri, code}. */
  tokenUrl: string;
  /** OAuth scope (공백 구분). */
  scope: string;
  /** Vault user secret key — client_id (REST API 키) 보유. 예: 'KAKAO_REST_API_KEY'. */
  apiKeyVaultKey: string;
  /** Vault user secret key (옵션) — client_secret. 일부 provider 만 (kakao confidential 옵션). */
  clientSecretVaultKey?: string;
  /** Vault 저장 — token 응답의 access_token 박음 위치. 예: 'KAKAO_ACCESS_TOKEN'. */
  accessTokenVaultKey: string;
  /** Vault 저장 — token 응답의 refresh_token (없으면 미저장). */
  refreshTokenVaultKey?: string;
  /** OAuth 흐름 완료 메시지 (한국어). */
  successMessage: string;
};

const providerList: OAuthProviderConfig[] = [
  {
    id: 'kakao',
    label: '카카오',
    authUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    scope: 'talk_message',
    apiKeyVaultKey: 'KAKAO_REST_API_KEY',
    clientSecretVaultKey: 'KAKAO_CLIENT_SECRET',
    accessTokenVaultKey: 'KAKAO_ACCESS_TOKEN',
    refreshTokenVaultKey: 'KAKAO_REFRESH_TOKEN',
    successMessage: '카카오톡 연동 완료! 토큰이 저장되었습니다.',
  },
];

const providerMap: Record<string, OAuthProviderConfig> = Object.fromEntries(
  providerList.map((p) => [p.id, p]),
);

/** provider id → config. 미등록 id 는 null. */
export function getOAuthProvider(id: string): OAuthProviderConfig | null {
  return providerMap[id] ?? null;
}

/** 등록 provider 전체 — 어드민 UI dropdown. */
export function listOAuthProviders(): OAuthProviderConfig[] {
  return providerList.slice();
}
