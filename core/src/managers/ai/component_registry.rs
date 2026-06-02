//! Component Registry — render() 디스패처 컴포넌트 카탈로그.
//!
//! 옛 TS `infra/llm/component-registry.ts` (641 LOC + COMPONENTS 26개) Rust 1:1 port.
//!
//! AI 는 `search_components(query)` 로 관련 컴포넌트를 찾고, `render(name, props)` 로 실제 렌더링.
//! 26개 component 정의 — `name + componentType + description + semanticText + propsSchema`.
//!
//! 데이터는 `components.json` (build 시 옛 TS COMPONENTS 에서 추출) 을 include_str! 로 embed,
//! 첫 호출 시 OnceLock + parse 로 lazy init. 모든 컴포넌트는 `Vec<ComponentDef>` 로 노출.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const COMPONENTS_JSON: &str = include_str!("components.json");

/// 1개 component 정의 — 옛 TS `ComponentDef` 1:1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDef {
    /// `render(name, ...)` 에서 쓰는 이름 (snake_case).
    pub name: String,
    /// 프론트엔드 ComponentRenderer 가 기대하는 타입명 (PascalCase).
    #[serde(rename = "componentType")]
    pub component_type: String,
    /// AI 에게 보여주는 도구 설명.
    pub description: String,
    /// 벡터 임베딩 입력 — 키워드 나열 (길수록 의미 확장).
    #[serde(rename = "semanticText")]
    pub semantic_text: String,
    /// JSON Schema — AI 가 props 조립에 사용. serde_json::Value 그대로 보존.
    #[serde(rename = "propsSchema")]
    pub props_schema: serde_json::Value,
}

/// 27개 component 정의 (components.json) — 옛 TS 26개 + map(태풍 시각화).
/// 첫 호출 시 lazy init. 이후 cached.
pub fn components() -> &'static Vec<ComponentDef> {
    static CACHE: OnceLock<Vec<ComponentDef>> = OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str(COMPONENTS_JSON)
            .expect("components.json 파싱 실패 — build 시 추출된 데이터 형식 깨짐")
    })
}

/// `name` 으로 컴포넌트 lookup. 옛 TS `COMPONENTS.find(c => c.name === name)` 1:1.
pub fn find_component(name: &str) -> Option<&'static ComponentDef> {
    components().iter().find(|c| c.name == name)
}

/// 모든 컴포넌트 이름 목록. 디버깅·logging 용.
pub fn component_names() -> Vec<&'static str> {
    components().iter().map(|c| c.name.as_str()).collect()
}

/// schema 의 `"type"` 가 주어진 type 이름(예: "object" / "array" / "null")을 허용하는지 판정.
/// `"type"` 가 단일 문자열이면 일치 여부, 배열이면 포함 여부를 본다.
fn schema_allows_type(schema: &serde_json::Value, type_name: &str) -> bool {
    match schema.get("type") {
        Some(serde_json::Value::String(s)) => s == type_name,
        Some(serde_json::Value::Array(arr)) => arr.iter().any(|x| x.as_str() == Some(type_name)),
        _ => false,
    }
}

/// props 를 schema 에 맞춰 재귀적으로 정리 — 검증 통과 가능하게 보정하되, 보정 불가한
/// 필수 누락은 그대로 남겨 (top-level validate 에서 실패 → AI 재시도). 동작:
///  - object: additionalProperties:false 면 미지 키 drop / 각 known prop 재귀 / optional prop 의
///    값이 sub-schema 위반이면 drop(→ renderer 기본값) / 누락 required 는 default 또는 null(허용
///    시) 채움
///  - array: 각 item 을 items schema 로 재귀
///  - scalar: no-op (상위에서 enum/type 판정)
///
/// required prop 은 위반이어도 drop 하지 않는다 (drop 하면 "없음"이 되어 어차피 실패 — 차이 없고,
/// gotKeys 진단으로 synonym 여부 보려면 원본 유지가 낫다). default/null 도 없는 필수 누락만 실패
/// 유지.
pub fn sanitize_to_schema(value: &mut serde_json::Value, schema: &serde_json::Value) {
    if schema_allows_type(schema, "object") {
        let Some(obj) = value.as_object_mut() else {
            return;
        };

        // schema(불변) 에서 properties / additionalProperties / required 먼저 추출 —
        // value 의 mutable borrow 와 충돌하지 않게 정보부터 모은다.
        let properties = schema.get("properties").and_then(|v| v.as_object());
        let additional_false = schema.get("additionalProperties").and_then(|v| v.as_bool())
            == Some(false);
        let required: std::collections::HashSet<&str> = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();

        // 0. synonym renaming — schema 가 선언한 synonyms 맵 (`{wrong: correct, ...}`) 으로
        //    AI 가 자연스럽게 쓰는 prop 키를 표준 키로 통합. 예: chart 의 `type → chartType`
        //    (block-level type 과 헷갈림 회피), `series → data` (대부분 차트 라이브러리 관례).
        //    extras drop 보다 먼저 실행해야 synonym key 가 미지(未知) 키로 삭제되는 것을 막는다.
        //    correct 가 이미 있으면 wrong 은 그냥 drop (correct 우선).
        if let Some(synonyms) = schema.get("synonyms").and_then(|v| v.as_object()) {
            for (wrong, correct_val) in synonyms {
                let Some(correct) = correct_val.as_str() else { continue };
                if obj.contains_key(wrong) {
                    let value = obj.remove(wrong);
                    if !obj.contains_key(correct) {
                        if let Some(v) = value {
                            obj.insert(correct.to_string(), v);
                        }
                    }
                    // correct 이미 있으면 value 폐기 (이미 drop 됨).
                }
            }
        }

        // 1. additionalProperties:false 면 properties 에 없는 키 전부 drop.
        if additional_false {
            if let Some(known) = properties {
                let extras: Vec<String> = obj
                    .keys()
                    .filter(|k| !known.contains_key(k.as_str()))
                    .cloned()
                    .collect();
                for k in extras {
                    obj.remove(&k);
                }
            }
        }

        // 2. 각 known prop 이 value 에 있으면 sub-schema 로 재귀 (중첩 먼저 정리).
        if let Some(known) = properties {
            for (key, sub_schema) in known {
                if let Some(v) = obj.get_mut(key.as_str()) {
                    sanitize_to_schema(v, sub_schema);
                }
            }

            // 3. optional prop 중 재귀 후에도 sub-schema 위반인 값은 drop (→ renderer 기본값).
            //    required prop 은 위반이어도 그대로 둔다.
            let to_drop: Vec<String> = known
                .iter()
                .filter(|(key, _)| !required.contains(key.as_str()))
                .filter_map(|(key, sub_schema)| {
                    obj.get(key.as_str()).and_then(|v| {
                        if crate::managers::module::validate_value(v, sub_schema).is_err() {
                            Some(key.clone())
                        } else {
                            None
                        }
                    })
                })
                .collect();
            for k in to_drop {
                obj.remove(&k);
            }

            // 4. 누락 required 보정 — sub-schema 에 default 있으면 그 값, 없고 null 허용 타입이면 null.
            //    둘 다 없으면 그대로 누락 (상위 validate 실패 → AI 재시도).
            for key in &required {
                if obj.contains_key(*key) {
                    continue;
                }
                let Some(sub_schema) = known.get(*key) else {
                    continue;
                };
                if let Some(default) = sub_schema.get("default") {
                    obj.insert(key.to_string(), default.clone());
                } else if schema_allows_type(sub_schema, "null") {
                    obj.insert(key.to_string(), serde_json::Value::Null);
                }
            }
        }
    } else if schema_allows_type(schema, "array") {
        let Some(items_schema) = schema.get("items") else {
            return;
        };
        let Some(arr) = value.as_array_mut() else {
            return;
        };
        for item in arr.iter_mut() {
            sanitize_to_schema(item, items_schema);
        }
    }
    // scalar: no-op.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_all_components() {
        let comps = components();
        // components.json 전체 — map(태풍 시각화) 추가로 27 (옛 26 + map).
        assert_eq!(comps.len(), 27, "components.json 의 27개 컴포넌트 모두 설정되어야");
    }

    #[test]
    fn each_component_has_required_fields() {
        for c in components() {
            assert!(!c.name.is_empty(), "name 비어있음");
            assert!(!c.component_type.is_empty(), "{} component_type 비어있음", c.name);
            assert!(!c.description.is_empty(), "{} description 비어있음", c.name);
            assert!(!c.semantic_text.is_empty(), "{} semantic_text 비어있음", c.name);
            assert!(c.props_schema.is_object(), "{} props_schema 가 object 가 아님", c.name);
        }
    }

    #[test]
    fn find_component_by_name() {
        assert!(find_component("stock_chart").is_some());
        assert!(find_component("table").is_some());
        assert!(find_component("chart").is_some());
        assert!(find_component("nonexistent").is_none());
    }

    #[test]
    fn stock_chart_has_expected_schema() {
        let c = find_component("stock_chart").unwrap();
        assert_eq!(c.component_type, "StockChart");
        let schema = &c.props_schema;
        assert_eq!(schema["type"], "object");
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "symbol"));
        assert!(required.iter().any(|v| v == "data"));
    }

    #[test]
    fn semantic_text_includes_korean_keywords() {
        let c = find_component("stock_chart").unwrap();
        assert!(c.semantic_text.contains("주식"));
        assert!(c.semantic_text.contains("캔들"));
    }

    #[test]
    fn component_names_returns_all() {
        let names = component_names();
        assert_eq!(names.len(), 27);
        assert!(names.contains(&"stock_chart"));
        assert!(names.contains(&"table"));
        assert!(names.contains(&"network"));
        assert!(names.contains(&"map"));
    }

    use crate::managers::module::validate_value;
    use serde_json::json;

    #[test]
    fn sanitize_drops_nested_optional_enum_violation() {
        // 중첩 배열 안 객체의 optional enum 위반 — items[].type = "info" 는 enum
        // ["default","success","warning","error"] 위반. top-level 정규화로는 못 잡던 사례.
        let schema = &find_component("timeline").unwrap().props_schema;
        let mut props = json!({
            "items": [
                { "date": "2026-01-01", "title": "시작", "type": "info" }
            ]
        });
        sanitize_to_schema(&mut props, schema);

        // items[0].type 가 제거되어야 한다.
        assert!(
            props["items"][0].get("type").is_none(),
            "enum 위반 optional prop 'type' 이 제거되어야 함"
        );
        // 필수 키는 보존.
        assert_eq!(props["items"][0]["date"], "2026-01-01");
        assert_eq!(props["items"][0]["title"], "시작");
        // 정리 후 검증 통과.
        assert!(
            validate_value(&props, schema).is_ok(),
            "sanitize 후 timeline 검증 통과해야 함"
        );
    }

    #[test]
    fn sanitize_fills_nullable_required_and_drops_unknown() {
        // table: stickyCol(nullable) 은 required 지만 누락 → null 채움.
        // 미지 키(bogus) 는 additionalProperties:false 라 제거.
        let schema = &find_component("table").unwrap().props_schema;
        let mut props = json!({
            "headers": ["A", "B"],
            "rows": [["1", "2"], ["3", "4"]],
            "bogus": "should be dropped"
        });
        sanitize_to_schema(&mut props, schema);

        assert_eq!(
            props["stickyCol"],
            serde_json::Value::Null,
            "nullable required 'stickyCol' 이 null 로 채워져야 함"
        );
        assert!(
            props.get("bogus").is_none(),
            "미지 키 'bogus' 가 제거되어야 함"
        );
        assert!(
            validate_value(&props, schema).is_ok(),
            "sanitize 후 table 검증 통과해야 함"
        );
    }

    #[test]
    fn sanitize_keeps_missing_required_without_default_failing() {
        // header: text 는 required + default/null 없음 → 보정 안 함 → 여전히 검증 실패.
        let schema = &find_component("header").unwrap().props_schema;
        let mut props = json!({ "level": 3 });
        sanitize_to_schema(&mut props, schema);

        assert!(
            props.get("text").is_none(),
            "보정 불가한 필수 'text' 는 채워지지 않아야 함"
        );
        assert!(
            validate_value(&props, schema).is_err(),
            "필수 'text' 누락은 sanitize 후에도 검증 실패해야 함"
        );
    }
}
