/**
 * Frontend / API route 의 상수 — 옛 `infra/config.ts` 의존성 제거 (Phase B-4 cutover).
 *
 * BASE_URL 은 `lib/base-url.ts` 가 export. 그 외 인증·OAuth 상수만 여기에 박힘.
 */

/** 세션 토큰 max-age — 24시간. /api/auth 의 Set-Cookie 에서 사용. */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** OAuth provider 가 만료 시간 미제공 시 폴백 — 1시간. /api/mcp/auth/callback. */
export const DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS = 3600;
