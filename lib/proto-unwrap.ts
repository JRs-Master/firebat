/**
 * Proto unwrap — Rust gRPC 응답의 wrap envelope 제거.
 *
 * BoolRequest = `{value: bool}` / StringRequest = `{value: string}` / NumberRequest = `{value: number}`.
 * RustCoreProxy 가 자동 unwrap 박은 메서드도 일부 있지만 모두는 X — 누락 케이스에서
 * frontend 가 객체 자체를 string/bool 로 잘못 박는 사례 발생 (timezone select default 첫
 * 옵션 (Pacific/Midway) 표시 buggy 사례 — 2026-05-10).
 *
 * 일관 적용 — settings / auth route 등에서 응답 처리 직전 unwrap 통과.
 */

/** `{value: T}` envelope 또는 raw T → raw T */
export function unwrapValue<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    return (inner === null || inner === undefined ? fallback : (inner as T));
  }
  return v as T;
}

export function unwrapString(v: unknown, fallback = ''): string {
  return unwrapValue<string>(v, fallback);
}

export function unwrapBool(v: unknown, fallback = false): boolean {
  return Boolean(unwrapValue<boolean>(v, fallback));
}
