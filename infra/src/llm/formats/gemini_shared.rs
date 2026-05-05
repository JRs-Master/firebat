//! Gemini (AI Studio + Vertex) 공용 유틸 — 옛 TS `_gemini-shared.ts` 1:1 port.
//!
//! gemini_native.rs + vertex_gemini.rs 둘 다 이 모듈의 sanitize 활용. 로직 변경 시 한 곳만
//! 고쳐도 양쪽 동시 반영 (중복 복사 방지).
//!
//! Gemini 스키마 제약:
//!   - `enum` 은 반드시 string 배열 (Gemini 가 숫자 enum 거부)
//!   - `type: integer` / `number` + `enum` 조합 금지 → enum 제거
//!   - 재귀적으로 nested properties / items 에도 동일 적용

/// JSON Schema → Gemini 호환 스키마 변환 (옛 TS adaptSchemaForGemini 1:1).
///
/// 호출자는 보통 `&t.input_schema` 같은 `serde_json::Value` 를 넘김. 반환값은 새 Value (원본 보존).
pub fn sanitize_gemini_schema(schema: &serde_json::Value) -> serde_json::Value {
    let mut cloned = schema.clone();
    walk_sanitize(&mut cloned);
    cloned
}

fn walk_sanitize(v: &mut serde_json::Value) {
    if let serde_json::Value::Object(map) = v {
        // integer / number + enum 조합 금지 — Gemini 미지원
        let ty = map.get("type").and_then(|t| t.as_str()).map(String::from);
        if matches!(ty.as_deref(), Some("integer") | Some("number")) && map.contains_key("enum") {
            map.remove("enum");
        }
        // enum 값을 string 배열로 강제 (mixed 타입 방어)
        if let Some(enum_val) = map.get_mut("enum") {
            if let Some(arr) = enum_val.as_array_mut() {
                let strs: Vec<serde_json::Value> = arr
                    .iter()
                    .map(|v| match v {
                        serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                        _ => serde_json::Value::String(v.to_string()),
                    })
                    .collect();
                *arr = strs;
            }
        }
        // 재귀 — properties / items / additionalProperties / anyOf / oneOf 등 모두 walk
        for (_k, child) in map.iter_mut() {
            walk_sanitize(child);
        }
    } else if let serde_json::Value::Array(arr) = v {
        for child in arr.iter_mut() {
            walk_sanitize(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_enum_on_integer() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "n": {"type": "integer", "enum": [1, 2, 3]}
            }
        });
        let cleaned = sanitize_gemini_schema(&schema);
        assert!(cleaned["properties"]["n"].get("enum").is_none());
    }

    #[test]
    fn removes_enum_on_number() {
        let schema = serde_json::json!({
            "type": "number",
            "enum": [1.5, 2.5]
        });
        let cleaned = sanitize_gemini_schema(&schema);
        assert!(cleaned.get("enum").is_none());
    }

    #[test]
    fn converts_string_enum_to_strings() {
        let schema = serde_json::json!({
            "type": "string",
            "enum": ["a", "b"]
        });
        let cleaned = sanitize_gemini_schema(&schema);
        let arr = cleaned["enum"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr[0].is_string());
        assert_eq!(arr[0].as_str(), Some("a"));
    }

    #[test]
    fn coerces_mixed_enum_to_strings() {
        let schema = serde_json::json!({
            "enum": ["a", 1, true]
        });
        let cleaned = sanitize_gemini_schema(&schema);
        let arr = cleaned["enum"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        for v in arr {
            assert!(v.is_string());
        }
    }

    #[test]
    fn recurses_into_properties_and_items() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "integer",
                        "enum": [1, 2]
                    }
                },
                "tag": {
                    "type": "string",
                    "enum": ["red", 1]
                }
            }
        });
        let cleaned = sanitize_gemini_schema(&schema);
        // nested array items 의 integer + enum → enum 제거
        assert!(cleaned["properties"]["items"]["items"].get("enum").is_none());
        // nested string + mixed enum → 모두 string
        let tag_arr = cleaned["properties"]["tag"]["enum"].as_array().unwrap();
        assert_eq!(tag_arr.len(), 2);
        assert!(tag_arr.iter().all(|v| v.is_string()));
    }

    #[test]
    fn array_at_top_level_walked() {
        let schema = serde_json::json!([
            {"type": "integer", "enum": [1, 2]},
            {"type": "string", "enum": ["a", 2]}
        ]);
        let cleaned = sanitize_gemini_schema(&schema);
        assert!(cleaned[0].get("enum").is_none());
        let arr = cleaned[1]["enum"].as_array().unwrap();
        assert!(arr.iter().all(|v| v.is_string()));
    }

    #[test]
    fn primitive_input_returned_as_is() {
        let schema = serde_json::json!("not-an-object");
        let cleaned = sanitize_gemini_schema(&schema);
        assert_eq!(cleaned, schema);
    }

    #[test]
    fn empty_object_unchanged() {
        let schema = serde_json::json!({});
        let cleaned = sanitize_gemini_schema(&schema);
        assert_eq!(cleaned, serde_json::json!({}));
    }
}
