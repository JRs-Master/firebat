/**
 * Frontend / API route 의 상수 — 옛 `infra/config.ts` 의존성 제거 (Phase B-4 cutover).
 *
 * BASE_URL 은 `lib/base-url.ts` 가 export. magic number 통합 (Phase 1 정공, 2026-05-13).
 */

import { TIME } from './util/time';

// ─── 인증 / 쿠키 ───────────────────────────────────────────────────────────
/** 세션 토큰 max-age — 24시간. /api/auth 의 Set-Cookie 에서 사용. */
export const SESSION_MAX_AGE_SECONDS = TIME.DAY_SEC;

/** OAuth provider 가 만료 시간 미제공 시 폴백 — 1시간. /api/mcp/auth/callback. */
export const DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS = TIME.HOUR_SEC;

/** 세션 쿠키 이름 — 모든 인증 경로 single source.
 *  proxy.ts / auth-guard / login / logout / setup / public page password gate 공통. */
export const SESSION_COOKIE_NAME = 'firebat_token';

/** Language preference cookie max-age — 1년 (lib/i18n.tsx). */
export const LANG_COOKIE_MAX_AGE_SECONDS = TIME.YEAR_SEC;

// ─── 사용자 입력 한도 ──────────────────────────────────────────────────────
/** 사용자 지시사항 최대 글자 수 — Rust core/src/vault_keys::USER_PROMPT_MAX_CHARS 와 동일.
 *  변경 시 양쪽 동기화 필수. SettingsModal slice + 미리보기 글자 수 표시에서 사용. */
export const USER_PROMPT_MAX_CHARS = 2000;

// ─── 채팅 / SSE / fetch ────────────────────────────────────────────────────
/** 채팅 watchdog idle 한도 — N ms 동안 응답 없으면 reconnect / abort. (useChat) */
export const CHAT_WATCHDOG_IDLE_MS = 2 * TIME.MINUTE_MS;

/** keepalive fetch body 한도 — 이 미만이면 navigator.sendBeacon 호환 keepalive 사용. (useChat) */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;

// ─── 백그라운드 작업 ──────────────────────────────────────────────────────
/** Active job 진행 중 stale 판정 한도 — 이 시간 초과 시 UI 에서 stale 표시. (ActiveJobsIndicator) */
export const STALE_RUNNING_MS = 5 * TIME.MINUTE_MS;
