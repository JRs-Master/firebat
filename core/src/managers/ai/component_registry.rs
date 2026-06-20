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

/// 35개 component 정의 (components.json) — 27 + quiz/quiz_group(exam-prep)
/// + 인터랙티브 6 (form/button/slider/tabs/accordion/carousel).
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

        // 0.5 columnar → row — schema 가 선언한 `columnar` 디렉티브로 평행 배열(dates[],open[],...)을
        //     객체 배열(target)로 zip. AI 가 OHLCV 등을 컬럼 형태로 보내는 케이스 흡수.
        //     synonym 뒤·extras drop 앞 (소스 컬럼 키가 미지 키로 삭제되기 전에 소비). 데이터 기반 — 컴포넌트명 하드코딩 0.
        if let Some(columnar) = schema.get("columnar").and_then(|v| v.as_object()) {
            if let (Some(target), Some(map)) = (
                columnar.get("target").and_then(|v| v.as_str()),
                columnar.get("map").and_then(|v| v.as_object()),
            ) {
                let target_filled = obj
                    .get(target)
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if !target_filled {
                    let cols: Vec<(String, String, Vec<serde_json::Value>)> = map
                        .iter()
                        .filter_map(|(src, dst)| {
                            let dst = dst.as_str()?;
                            let arr = obj.get(src)?.as_array()?;
                            Some((src.clone(), dst.to_string(), arr.clone()))
                        })
                        .collect();
                    if !cols.is_empty() {
                        let len = cols.iter().map(|(_, _, a)| a.len()).max().unwrap_or(0);
                        let mut rows = Vec::with_capacity(len);
                        for i in 0..len {
                            let mut row = serde_json::Map::new();
                            for (_, dst, arr) in &cols {
                                if let Some(v) = arr.get(i) {
                                    row.insert(dst.clone(), v.clone());
                                }
                            }
                            rows.push(serde_json::Value::Object(row));
                        }
                        obj.insert(target.to_string(), serde_json::Value::Array(rows));
                        for (src, _, _) in &cols {
                            obj.remove(src);
                        }
                    }
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
        // 컨테이너 자식 블록 배열(grid/tabs/accordion/carousel/card 의 children) 자동 감지 —
        // items 스키마가 `{type:string, props:object}` 시그니처면 각 항목을 *실제 컴포넌트 스키마*로
        // 재귀 정규화한다(synonyms/defaults/extras-drop/props 자동채움이 깊이 무관 작동). 한 곳=N곳.
        // 옛에는 자식 props 가 불투명(additionalProperties:true)이라 자식 컴포넌트의 동의어·기본값이
        // 안 먹어 tabs 안 table 의 searchable→filterable, button label→text 가 깨졌다.
        if is_child_block_schema(items_schema) {
            for item in arr.iter_mut() {
                sanitize_child_block(item);
            }
            return;
        }
        // items 가 "단일 required 필드 객체"인데 항목이 문자열로 오면 {그 필드: 문자열} 로 coerce.
        // AI 가 steps/항목을 객체 대신 문자열 배열로 보내도 흡수 (render robustness, 일반 규칙 — 컴포넌트명 하드코딩 0).
        // 예: plan_card steps required=["title"] → "단계명" → {title: "단계명"}. required 2개+면 모호 → 미적용.
        let str_key: Option<String> = if schema_allows_type(items_schema, "object") {
            items_schema
                .get("required")
                .and_then(|r| r.as_array())
                .filter(|r| r.len() == 1)
                .and_then(|r| r[0].as_str())
                .map(|s| s.to_string())
        } else {
            None
        };
        for item in arr.iter_mut() {
            if let Some(key) = &str_key {
                if item.is_string() {
                    let s = item.take();
                    let mut obj = serde_json::Map::new();
                    obj.insert(key.clone(), s);
                    *item = serde_json::Value::Object(obj);
                }
            }
            sanitize_to_schema(item, items_schema);
        }
    } else if schema_allows_type(schema, "string") {
        // string 기대 위치에 {text}/{label}/{value}/{content} 단일-텍스트 객체가 오면 그 문자열로 coerce.
        // AI 가 list 항목·라벨 등을 객체로 감싸 보내 검증 실패하던 것을 흡수 (render robustness, 일반 규칙).
        if let Some(s) = value.as_object().and_then(|o| {
            ["text", "label", "value", "content"]
                .iter()
                .find_map(|k| o.get(*k).and_then(|v| v.as_str()).map(|s| s.to_string()))
        }) {
            *value = serde_json::Value::String(s);
        }
    }
    // scalar: no-op.
}

/// items 스키마가 "자식 블록"(`{type:string, props:object}`) 시그니처인지 판정.
/// grid/tabs/accordion/carousel/card 의 children 배열이 공통으로 이 형태 → 자동 감지.
fn is_child_block_schema(items_schema: &serde_json::Value) -> bool {
    let Some(props) = items_schema.get("properties").and_then(|v| v.as_object()) else {
        return false;
    };
    let has_type = props
        .get("type")
        .map(|t| schema_allows_type(t, "string"))
        .unwrap_or(false);
    let has_props = props
        .get("props")
        .map(|p| schema_allows_type(p, "object"))
        .unwrap_or(false);
    has_type && has_props
}

/// 컨테이너 자식 블록 1개 정규화 — top-level render_blocks 와 동일 규칙을 깊이에 적용:
///  - 문자열 항목 → text 블록 coerce (AI 가 children 에 문자열을 직접 넣는 경우).
///  - props 누락 → `{}` 채움 (divider 등 props 없는 컴포넌트 검증 통과).
///  - `type` 으로 실제 컴포넌트 lookup 후 props 를 그 스키마로 재귀 sanitize
///    (synonyms/defaults/extras-drop + 중첩 컨테이너까지 전파).
fn sanitize_child_block(item: &mut serde_json::Value) {
    // 문자열 → text 블록.
    if let Some(s) = item.as_str() {
        let s = s.to_string();
        *item = serde_json::json!({ "type": "text", "props": { "content": s } });
    }
    let Some(obj) = item.as_object_mut() else {
        return;
    };
    // props 누락 보정.
    if !obj.contains_key("props") {
        obj.insert("props".to_string(), serde_json::json!({}));
    }
    let type_name = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let (Some(t), Some(props)) = (type_name, obj.get_mut("props")) else {
        return;
    };
    let Some(comp) = find_component(&t) else {
        return;
    };
    // name→title (top-level render_blocks 와 동일 보정).
    if let Some(p) = props.as_object_mut() {
        if !p.contains_key("title") {
            if let Some(name_val) = p.remove("name") {
                p.insert("title".to_string(), name_val);
            }
        }
    }
    sanitize_to_schema(props, &comp.props_schema);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_all_components() {
        let comps = components();
        // components.json 전체 — 27 + quiz/quiz_group + 인터랙티브 6 + sentence + vocab(어휘) + passage(독해) = 38.
        assert_eq!(comps.len(), 38, "components.json 의 38개 컴포넌트 모두 설정되어야");
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
        assert_eq!(names.len(), 38);
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

    #[test]
    fn sanitize_coerces_text_object_to_string_in_list() {
        // AI 가 list 항목을 {text:"..."} 객체로 보낸 경우 → 문자열로 coerce 후 검증 통과.
        let schema = &find_component("list").unwrap().props_schema;
        let mut props = json!({
            "items": [{ "text": "**굵게** 항목" }, "평범 항목"],
            "ordered": false
        });
        sanitize_to_schema(&mut props, schema);
        assert_eq!(props["items"][0], json!("**굵게** 항목"), "{{text}} 객체가 문자열로 coerce 되어야");
        assert_eq!(props["items"][1], json!("평범 항목"), "이미 문자열인 항목은 그대로");
        assert!(
            validate_value(&props, schema).is_ok(),
            "coerce 후 list 검증 통과해야 함"
        );
    }

    #[test]
    fn sanitize_tabs_recurses_child_blocks_with_real_schema() {
        // 채팅 인터랙티브 깨짐 root — tabs 안 자식 블록이 자기 컴포넌트 스키마로 정규화되어야:
        //  - tab 항목의 `blocks` → `children` (synonym)
        //  - 자식 table 의 `searchable` → `filterable` (자식 실제 스키마 synonym, 깊이 적용)
        //  - 자식 divider 의 props 누락 → `{}` 자동 채움
        //  → 통째 검증 통과 (옛에는 silent skip 되어 화면 누락).
        let schema = &find_component("tabs").unwrap().props_schema;
        let mut props = json!({
            "tabs": [
                {
                    "label": "시세",
                    "blocks": [
                        { "type": "table", "props": { "headers": ["A"], "rows": [["1"]], "searchable": true } },
                        { "type": "divider" }
                    ]
                }
            ]
        });
        sanitize_to_schema(&mut props, schema);

        let tab0 = &props["tabs"][0];
        assert!(tab0.get("blocks").is_none(), "`blocks` 가 `children` 으로 rename 되어야");
        let children = tab0["children"].as_array().unwrap();
        assert_eq!(
            children[0]["props"]["filterable"], json!(true),
            "자식 table 의 `searchable` 가 `filterable` 로 정규화되어야 (깊이 적용)"
        );
        assert!(
            children[0]["props"].get("searchable").is_none(),
            "원본 `searchable` 키는 제거되어야"
        );
        assert!(
            children[1]["props"].is_object(),
            "props 없는 divider 에 `{{}}` 가 채워져야"
        );
        assert!(
            validate_value(&props, schema).is_ok(),
            "sanitize 후 tabs 전체 검증 통과해야 함"
        );
    }

    #[test]
    fn sanitize_button_label_synonym() {
        // button: AI 가 자주 쓰는 `label` → 표준 `text`.
        let schema = &find_component("button").unwrap().props_schema;
        let mut props = json!({ "label": "문의하기", "variant": "primary" });
        sanitize_to_schema(&mut props, schema);
        assert_eq!(props["text"], json!("문의하기"), "`label` 이 `text` 로 정규화되어야");
        assert!(validate_value(&props, schema).is_ok(), "sanitize 후 button 검증 통과해야 함");
    }
}
