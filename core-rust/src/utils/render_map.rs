//! `render_*` 도구 이름 → 컴포넌트 타입 매핑 single source.
//!
//! 옛 TS `lib/render-map.ts` 1:1 port.
//!
//! AI 가 `render_table` / `render_chart` / `render_alert` 등 호출 시 어떤 컴포넌트로 렌더할지 결정.
//! mcp/internal-server / cli adapter / result_processor 등 여러 곳이 본 매핑 단일 사용.
//!
//! 이전 (옛 TS): ai-manager / cli-gemini / cli-claude-code / cli-codex 4군데에 동일 매핑
//!              hardcoded → 새 컴포넌트 추가 시 4군데 수정.
//! 변경: 본 모듈 한 곳만 수정 → 자동 반영 (일반 로직).

use std::collections::HashMap;
use std::sync::OnceLock;

/// `render_*` 도구 이름 → 컴포넌트 타입 매핑.
/// 옛 TS `RENDER_TOOL_MAP` 1:1 (27 entries).
pub fn render_tool_map() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("render_stock_chart", "StockChart");
        m.insert("render_table", "Table");
        m.insert("render_alert", "Alert");
        m.insert("render_callout", "Callout");
        m.insert("render_badge", "Badge");
        m.insert("render_progress", "Progress");
        m.insert("render_header", "Header");
        m.insert("render_text", "Text");
        m.insert("render_list", "List");
        m.insert("render_divider", "Divider");
        m.insert("render_countdown", "Countdown");
        m.insert("render_chart", "Chart");
        m.insert("render_image", "Image");
        m.insert("render_card", "Card");
        m.insert("render_grid", "Grid");
        m.insert("render_metric", "Metric");
        m.insert("render_timeline", "Timeline");
        m.insert("render_compare", "Compare");
        m.insert("render_key_value", "KeyValue");
        m.insert("render_status_badge", "StatusBadge");
        m.insert("render_map", "Map");
        m.insert("render_diagram", "Diagram");
        m.insert("render_math", "Math");
        m.insert("render_code", "Code");
        m.insert("render_slideshow", "Slideshow");
        m.insert("render_lottie", "Lottie");
        m.insert("render_network", "Network");
        m
    })
}

/// `Component → render_<tool>` 역방향 매핑 (옛 TS `Object.entries` reverse 패턴 1:1).
/// `render` 단일 도구의 `result.component` 분기에서 사용 (component 이름 → tool 이름 매칭).
pub fn render_tool_inverse_map() -> &'static HashMap<&'static str, &'static str> {
    static INV: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    INV.get_or_init(|| {
        render_tool_map()
            .iter()
            .map(|(k, v)| (*v, *k))
            .collect()
    })
}

/// 변형 매칭 helper — AI 가 다양한 형태로 호출해도 자동 정규화.
///   - `"render_table"` (정확) → `Some("render_table")`
///   - `"render-table"` (kebab) → `Some("render_table")`
///   - `"table"` (접두사 누락) → `Some("render_table")`
///
/// `mcp_firebat_render_table` 같은 Gemini CLI prefix 는 호출자가 사전에 strip.
pub fn normalize_render_name(name: &str) -> Option<&'static str> {
    let stripped = name.trim();
    if stripped.is_empty() {
        return None;
    }
    let map = render_tool_map();

    // 정확 매칭
    if let Some(_) = map.get(stripped) {
        return map.keys().find(|k| **k == stripped).copied();
    }
    // kebab → snake
    let snake = stripped.replace('-', "_");
    if let Some(_) = map.get(snake.as_str()) {
        return map.keys().find(|k| **k == snake.as_str()).copied();
    }
    // render_ 접두사 누락 → 자동 추가
    let with_prefix = format!("render_{}", snake);
    if let Some(_) = map.get(with_prefix.as_str()) {
        return map.keys().find(|k| **k == with_prefix.as_str()).copied();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_map_has_27_entries() {
        // 옛 TS 1:1 — 27 컴포넌트 (Step 2 image 영역 별도)
        assert_eq!(render_tool_map().len(), 27);
    }

    #[test]
    fn render_map_known_components() {
        let m = render_tool_map();
        assert_eq!(m.get("render_table"), Some(&"Table"));
        assert_eq!(m.get("render_chart"), Some(&"Chart"));
        assert_eq!(m.get("render_stock_chart"), Some(&"StockChart"));
        assert_eq!(m.get("render_alert"), Some(&"Alert"));
        assert_eq!(m.get("render_image"), Some(&"Image"));
    }

    #[test]
    fn inverse_map_roundtrip() {
        let inv = render_tool_inverse_map();
        assert_eq!(inv.get("Table"), Some(&"render_table"));
        assert_eq!(inv.get("StockChart"), Some(&"render_stock_chart"));
        assert_eq!(inv.get("Map"), Some(&"render_map"));
    }

    #[test]
    fn normalize_exact_match() {
        assert_eq!(normalize_render_name("render_table"), Some("render_table"));
        assert_eq!(normalize_render_name("render_chart"), Some("render_chart"));
    }

    #[test]
    fn normalize_kebab_to_snake() {
        assert_eq!(normalize_render_name("render-table"), Some("render_table"));
        assert_eq!(normalize_render_name("render-stock-chart"), Some("render_stock_chart"));
    }

    #[test]
    fn normalize_missing_prefix() {
        assert_eq!(normalize_render_name("table"), Some("render_table"));
        assert_eq!(normalize_render_name("chart"), Some("render_chart"));
        // kebab + prefix 누락
        assert_eq!(normalize_render_name("stock-chart"), Some("render_stock_chart"));
    }

    #[test]
    fn normalize_unknown_returns_none() {
        assert_eq!(normalize_render_name("not_a_render_tool"), None);
        assert_eq!(normalize_render_name(""), None);
        assert_eq!(normalize_render_name("   "), None);
    }
}
