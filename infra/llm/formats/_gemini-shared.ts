/**
 * Gemini (AI Studio + Vertex) 공용 유틸
 *
 * gemini-native.ts와 vertex-gemini.ts가 공유하는 스키마 어댑터를 한 곳에 모은다.
 * 로직 변경 시 둘 다 동시 반영 (중복 복사 방지).
 */

/**
 * JSON Schema → Gemini 호환 스키마 변환
 * 제약:
 *  - enum은 반드시 string 배열 (Gemini가 숫자 enum 거부)
 *  - type이 integer/number + enum 조합은 금지 → enum 제거
 *  - 재귀적으로 nested properties/items에도 적용
 */
export function adaptSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(adaptSchemaForGemini);
  const s = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'enum' && Array.isArray(v)) {
      const type = s.type as string | undefined;
      // 숫자 타입 + enum → enum 제거 (Gemini 미지원)
      if (type === 'integer' || type === 'number') continue;
      // string enum → 값 string 변환 (mixed 타입 방어)
      result[k] = v.map(e => String(e));
    } else if (v && typeof v === 'object') {
      result[k] = adaptSchemaForGemini(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}
