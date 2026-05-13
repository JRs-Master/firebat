/**
 * Time utility — Phase 1 정공 (2026-05-13).
 *
 * 옛 산재된 magic number (`60_000` / `86400000` / `24 * 60 * 60`) 통합 + relative time + format.
 *
 * 사용 패턴:
 *   import { TIME, formatRelativeTime } from '@/lib/util/time';
 *   const watchdog = 2 * TIME.MINUTE_MS;
 *   const text = formatRelativeTime(timestamp);   // "5분 전" / "어제" / "3일 전"
 */

/** 시간 상수 (ms 단위 + 초 단위). single source of truth. */
export const TIME = {
  SECOND_MS: 1000,
  MINUTE_MS: 60 * 1000,
  HOUR_MS: 60 * 60 * 1000,
  DAY_MS: 24 * 60 * 60 * 1000,
  WEEK_MS: 7 * 24 * 60 * 60 * 1000,
  MONTH_MS: 30 * 24 * 60 * 60 * 1000,
  YEAR_MS: 365 * 24 * 60 * 60 * 1000,
  SECOND_SEC: 1,
  MINUTE_SEC: 60,
  HOUR_SEC: 60 * 60,
  DAY_SEC: 24 * 60 * 60,
  WEEK_SEC: 7 * 24 * 60 * 60,
  YEAR_SEC: 365 * 24 * 60 * 60,
} as const;

/**
 * 상대 시간 표시 — "방금 전" / "5분 전" / "3시간 전" / "어제" / "3일 전" / "2주 전" / "1개월 전".
 *
 * @param input ms timestamp 또는 Date 객체
 * @param now 비교 기준 (기본 = Date.now()). 테스트 시 fix 가능
 */
export function formatRelativeTime(input: number | Date, now: number = Date.now()): string {
  const ts = input instanceof Date ? input.getTime() : input;
  const diff = now - ts;
  if (diff < 0) return '방금';                              // 미래 시간 (clock skew) — 안전 fallback
  if (diff < 10 * TIME.SECOND_MS) return '방금 전';
  if (diff < TIME.MINUTE_MS) return `${Math.floor(diff / TIME.SECOND_MS)}초 전`;
  if (diff < TIME.HOUR_MS) return `${Math.floor(diff / TIME.MINUTE_MS)}분 전`;
  if (diff < TIME.DAY_MS) return `${Math.floor(diff / TIME.HOUR_MS)}시간 전`;
  if (diff < 2 * TIME.DAY_MS) return '어제';
  if (diff < TIME.WEEK_MS) return `${Math.floor(diff / TIME.DAY_MS)}일 전`;
  if (diff < TIME.MONTH_MS) return `${Math.floor(diff / TIME.WEEK_MS)}주 전`;
  if (diff < TIME.YEAR_MS) return `${Math.floor(diff / TIME.MONTH_MS)}개월 전`;
  return `${Math.floor(diff / TIME.YEAR_MS)}년 전`;
}

/**
 * 사용자 친화 날짜 표시 — Vault `system:timezone` 따라 localized.
 *
 * @param input ms timestamp 또는 Date
 * @param tz IANA timezone (기본 'Asia/Seoul'). 사용자 설정은 호출 site 에서 주입
 */
export function formatDate(input: number | Date, tz: string = 'Asia/Seoul'): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleString('ko-KR', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** ISO 8601 timestamp (UTC). cron schedule / DB 저장 / 로그 용. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 일자 차이 계산 — 두 timestamp 사이 일수 (소수점 절사). */
export function daysSince(input: number | Date, now: number = Date.now()): number {
  const ts = input instanceof Date ? input.getTime() : input;
  return Math.floor((now - ts) / TIME.DAY_MS);
}
