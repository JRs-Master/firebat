/**
 * ID utility — Phase 1 정공 (2026-05-13).
 *
 * 옛 산재된 `Math.random().toString(36).slice(2, N)` 패턴 통합.
 *
 * 보안 ID (세션 / 토큰) 는 Rust 측 `uuid::Uuid::new_v4()` 사용 — 본 모듈은 frontend / UI
 * scope (mermaid id / iframe id / 임시 cronJob 라벨 등) 한정.
 */

/**
 * 짧은 random ID — 36진법 ~6자리 (collision 확률 무관 영역 용).
 *
 * UI / DOM key / iframe scope id / mermaid container id 등 — 보안 X.
 *
 * @param length 출력 자릿수 (기본 8). collision 위험 영역 = crypto.randomUUID() 사용
 */
export function shortId(length: number = 8): string {
  return Math.random().toString(36).slice(2, 2 + length);
}

/**
 * crypto-safe UUID — Web Crypto API. 보안 / DB key / 외부 노출 식별자 용.
 *
 * Node SSR + Browser 양쪽 호환. crypto.randomUUID() 표준.
 */
export function safeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — 옛 브라우저 / 비표준 환경. UUID v4 형식 수동 생성.
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  hex[6] = (hex[6]! & 0x0f) | 0x40;
  hex[8] = (hex[8]! & 0x3f) | 0x80;
  const h = hex.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 사람-friendly ID with prefix + timestamp + random — debug / log / cron job 식별자.
 *
 * Example: `cronJobId('cron')` → `cron-1715567890-a3f9`
 */
export function prefixedId(prefix: string, randomLen: number = 4): string {
  return `${prefix}-${Date.now()}-${shortId(randomLen)}`;
}

/**
 * slug 정규화 — 한글 / 영문 / 숫자 / 하이픈 허용. 공백 → 하이픈, 특수문자 제거.
 *
 * 페이지 URL slug 용 (BIBLE 한글 slug 허용 원칙).
 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_/]/gu, '')  // letter / number / hyphen / underscore / slash (project/slug)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
