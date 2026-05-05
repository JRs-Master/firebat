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

/// 26개 component 정의 — 옛 TS `COMPONENTS` 1:1.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_26_components() {
        let comps = components();
        assert_eq!(comps.len(), 26, "옛 TS 의 26개 컴포넌트 모두 박혀야");
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
    fn component_names_returns_26() {
        let names = component_names();
        assert_eq!(names.len(), 26);
        assert!(names.contains(&"stock_chart"));
        assert!(names.contains(&"table"));
        assert!(names.contains(&"network"));
    }
}
