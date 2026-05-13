/**
 * JSON utility — Phase 1 정공 (2026-05-13).
 *
 * 옛 산재된 try { JSON.parse(...) } catch {} 패턴 통합 — silent fail 차단 + 명시적 default.
 *
 * 사용 패턴:
 *   const data = safeJsonParse<MyType>(raw, { items: [] });   // 실패 시 default
 *   const data = safeJsonParse<MyType>(raw);                    // 실패 시 null
 *   const data = parseJsonOrThrow<MyType>(raw, '필드명');        // 실패 시 throw with context
 *
 * 옛 패턴 (silent):
 *   let data; try { data = JSON.parse(raw); } catch { data = []; }
 * 새 패턴:
 *   const data = safeJsonParse<MyType>(raw, []);
 */

/**
 * 안전한 JSON.parse — 실패 시 default 또는 null 반환. throw 0.
 *
 * default 미지정 시 null 반환. 호출자가 type narrow 필요.
 */
export function safeJsonParse<T = unknown>(raw: string | null | undefined): T | null;
export function safeJsonParse<T = unknown>(raw: string | null | undefined, fallback: T): T;
export function safeJsonParse<T = unknown>(raw: string | null | undefined, fallback?: T): T | null {
  if (raw === null || raw === undefined || raw === '') return fallback ?? null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback ?? null;
  }
}

/**
 * JSON.parse — 실패 시 throw with context. 사용자에게 어느 필드인지 명시.
 *
 * 빈 string / undefined 는 undefined 반환 (optional field 용).
 */
export function parseJsonOrThrow<T = unknown>(
  raw: string | null | undefined,
  fieldName: string,
): T | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${fieldName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * JSON.stringify — undefined / circular 안전. 실패 시 String(value) 폴백.
 *
 * pretty 옵션 = 2 space indent (디버깅 / 로그 표시 용).
 */
export function safeJsonStringify(value: unknown, opts?: { pretty?: boolean }): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, opts?.pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}
