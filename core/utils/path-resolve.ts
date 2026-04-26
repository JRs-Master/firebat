/**
 * 객체·배열 path 해석 — 점 표기 + array index + 음수 index (뒤에서 N번째) 지원.
 *
 * 지원 형태:
 *   foo                  → obj.foo
 *   foo.bar.baz          → obj.foo.bar.baz
 *   output[0]            → obj.output[0]
 *   output[0].opnd_yn    → obj.output[0].opnd_yn
 *   foo[2][3]            → obj.foo[2][3]   (다차원)
 *   output[-1].x         → 배열 마지막 요소의 x
 *   output.0.x           → 점 표기로 인덱스도 OK
 *
 * 일반 메커니즘 — 특정 sysmod·특정 키 가정 X. 어떤 array 응답에도 동작.
 */
export function resolveFieldPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  // 1) [n] / [-n] 표기를 .n 형태로 정규화 → 단일 split 으로 처리
  //    foo[0].bar  →  foo.0.bar
  //    foo[-1]     →  foo.-1
  const normalized = path.replace(/\[(-?\d+)\]/g, '.$1');
  for (const rawKey of normalized.split('.')) {
    if (!rawKey) continue; // path 가 ".foo" 로 시작하거나 "foo..bar" 같은 빈 segment
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(rawKey);
      if (!Number.isInteger(idx)) return undefined;
      const realIdx = idx < 0 ? cur.length + idx : idx;
      cur = cur[realIdx];
      continue;
    }
    if (typeof cur === 'object') {
      // object 인데 키가 숫자 string 일 수도 있음 (json 객체 키) — in 연산자가 둘 다 처리
      if (rawKey in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[rawKey];
        continue;
      }
      return undefined;
    }
    return undefined;
  }
  return cur;
}
