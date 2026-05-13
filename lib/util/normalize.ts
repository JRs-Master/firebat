/**
 * 데이터 정규화 utility — Phase 3 정공 (2026-05-13).
 *
 * proto layer 가 i64 → JS string 으로 변환 (proto-loader `longs: String` 설정 또는
 * @connectrpc typed client 의 bigint). frontend 가 `new Date(ts)` 호출 시 string
 * ("1778425752563") 은 Invalid Date. createdAt / updatedAt 같은 timestamp 필드 자동 변환.
 *
 * 옛 API route 별 manual `normalizeTimestamps` 함수 통합.
 */

/** proto i64 / bigint / string-of-digits → number. 실패 시 0 또는 default. */
export function toNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) return Number(value);
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 객체 안 timestamp 필드 자동 number 변환.
 *
 * @param rec  대상 객체
 * @param keys timestamp 필드 명 (기본 `['createdAt', 'updatedAt']`).
 *             custom: ['lastUsedAt', 'expiresAt'] 등
 */
export function normalizeTimestamps<T extends Record<string, unknown>>(
  rec: T,
  keys: readonly string[] = ['createdAt', 'updatedAt'],
): T {
  const out: Record<string, unknown> = { ...rec };
  for (const key of keys) {
    const v = out[key];
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      out[key] = Number(v);
    } else if (typeof v === 'bigint') {
      out[key] = Number(v);
    }
  }
  return out as T;
}

/**
 * Array of records → timestamps 일괄 정규화. 자주 쓰이는 패턴 (list response).
 */
export function normalizeTimestampsList<T extends Record<string, unknown>>(
  list: T[],
  keys?: readonly string[],
): T[] {
  return list.map(item => normalizeTimestamps(item, keys));
}
