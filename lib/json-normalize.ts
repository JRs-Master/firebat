/**
 * tryUnwrapJson — 옛 `core/utils/json-normalize.ts` 1:1 (Phase B-4 cutover 시 lib 로 이동).
 *
 * AI 응답 / DB 가 string-of-string 으로 wrap 한 JSON 을 깊이 3까지 재파싱 시도.
 * 예: `'"{ \\"a\\": 1 }"'` → `'{ "a": 1 }'` → `{ a: 1 }`.
 * 입력이 이미 객체면 그대로 반환. 파싱 실패 시 원본 반환.
 */
export function tryUnwrapJson<T = unknown>(input: unknown): T {
  let cur = input;
  for (let i = 0; i < 3; i++) {
    if (typeof cur !== 'string') return cur as T;
    try {
      cur = JSON.parse(cur);
    } catch {
      return cur as T;
    }
  }
  return cur as T;
}
