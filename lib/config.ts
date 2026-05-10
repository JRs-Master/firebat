/**
 * Frontend / API route 의 상수 — 옛 `infra/config.ts` 의존성 제거 (Phase B-4 cutover).
 *
 * BASE_URL 은 `lib/base-url.ts` 가 export. 그 외 인증·OAuth 상수만 여기에 설정.
 */

/** 세션 토큰 max-age — 24시간. /api/auth 의 Set-Cookie 에서 사용. */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** OAuth provider 가 만료 시간 미제공 시 폴백 — 1시간. /api/mcp/auth/callback. */
export const DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS = 3600;

/** 세션 쿠키 이름 — 모든 인증 경로 single source.
 *  proxy.ts / auth-guard / login / logout / setup / public page password gate 공통. */
export const SESSION_COOKIE_NAME = 'firebat_token';

/** 사용자 지시사항 최대 글자 수 — Rust core/src/vault_keys::USER_PROMPT_MAX_CHARS 와 동일.
 *  변경 시 양쪽 동기화 필수. SettingsModal slice + 미리보기 글자 수 표시에서 사용. */
export const USER_PROMPT_MAX_CHARS = 2000;
