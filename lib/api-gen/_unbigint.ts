/**
 * unBigInt — protobuf-es 의 i64 → bigint 출력을 number 로 자동 변환.
 *
 * proto 의 `int64` field 가 protoc-gen-es 에서 `bigint` 으로 디폴트 매핑됩니다.
 * `NextResponse.json` / `JSON.stringify` 는 BigInt 직렬화 불가 → TypeError throw.
 *
 * 매 RPC client 함수가 response 반환 직전에 호출 → 호출 site (API route / hook) 영역
 * BigInt 영역 의식할 필요 0.
 *
 * 경고 — i64 값 > 2^53 (9.007e15) 영역은 number 변환 시 precision loss. Firebat 의 i64
 * field 영역 = timestamp ms / count / size 등 안전 범위. 정공 위험 0.
 */
export function unBigInt<T>(data: T): T {
  if (typeof data === 'bigint') return Number(data) as T;
  if (Array.isArray(data)) return data.map(unBigInt) as T;
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) out[k] = unBigInt(v);
    return out as T;
  }
  return data;
}
