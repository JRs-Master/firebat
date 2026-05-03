//! ResultProcessor — AI 도구 호출 결과 축약·요약. 순수 함수.
//!
//! 옛 TS `core/managers/ai/result-processor.ts` 1:1 port.
//!
//! 책임:
//!   1. `trim_tool_result` — Vertex 학습 데이터 저장 시 2000자 cap (파인튜닝 토큰 비용 절감).
//!   2. `slim_result_for_llm` — 다음 turn LLM 컨텍스트로 넘길 결과 축약 (render 도구 props 탈거 등).
//!   3. `aggressive_summarize` — 이전 턴 도구 결과 요약 (멀티턴 누적 비용 차단).
//!
//! 분리 이유: 순수 함수 3개 — AiManager state 의존 X. 단위 테스트 용이.
//! 일반 로직 — 도구별 분기는 옛 TS 와 동일 (render_stock_chart / render_table / render_chart /
//! render_iframe 4 케이스 명시 — 그 외는 카탈로그 매핑 또는 폴백).

use serde_json::{json, Map, Value};

use crate::utils::render_map::{render_tool_inverse_map, render_tool_map};

const TRIM_TOTAL_LIMIT: usize = 2000;
const TRIM_CONTENT_LIMIT: usize = 1500;
const TRIM_DATA_LIMIT: usize = 1500;
const TRIM_ERROR_LIMIT: usize = 500;
const AGGRESSIVE_DATA_PREVIEW: usize = 200;
const AGGRESSIVE_STRING_DATA_PREVIEW: usize = 300;
const AGGRESSIVE_TEXT_FIELD_LIMIT: usize = 300;
const AGGRESSIVE_DATA_KEEP_INLINE: usize = 500;
const AGGRESSIVE_OBJECT_KEYS_MAX: usize = 20;
const AGGRESSIVE_ARRAY_KEYS_MAX: usize = 10;
const AGGRESSIVE_ERROR_LIMIT: usize = 300;

/// 학습 데이터 저장용 — 도구 결과 2000자 cap. 큰 응답은 핵심 필드만 남김.
/// 옛 TS `trimToolResult` 1:1.
pub fn trim_tool_result(result: &Value) -> Value {
    let str_repr = result.to_string();
    if str_repr.len() <= TRIM_TOTAL_LIMIT {
        return result.clone();
    }
    let mut trimmed = Map::new();
    if let Some(success) = result.get("success") {
        trimmed.insert("success".to_string(), success.clone());
    }
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        trimmed.insert(
            "error".to_string(),
            json!(slice_chars(error, TRIM_ERROR_LIMIT)),
        );
    }
    if let Some(content) = result.get("content").and_then(Value::as_str) {
        trimmed.insert(
            "content".to_string(),
            json!(slice_chars(content, TRIM_CONTENT_LIMIT)),
        );
    }
    if let Some(items) = result.get("items").and_then(Value::as_array) {
        trimmed.insert("items".to_string(), json!(format!("[{} items]", items.len())));
    }
    if let Some(data) = result.get("data") {
        let data_str = data.to_string();
        if data_str.len() > TRIM_DATA_LIMIT {
            trimmed.insert(
                "data".to_string(),
                json!(format!("{}...", slice_chars(&data_str, TRIM_DATA_LIMIT))),
            );
        } else {
            trimmed.insert("data".to_string(), data.clone());
        }
    }
    Value::Object(trimmed)
}

/// LLM 컨텍스트로 들어갈 tool 결과 축약. `aggressive=true` 면 render 외 도구도 요약.
///
/// 멀티턴 루프에서 이전 턴 결과가 매 턴 재전송되는 걸 방지하기 위해, 현재 턴 호출 직전에
/// 이전 턴들을 `aggressive=true` 로 재슬림. 현재 턴 결과는 `aggressive=false` (AI 가 바로 써야
/// 하므로 원본). 옛 TS `slimResultForLLM` 1:1.
pub fn slim_result_for_llm(tool_name: &str, result: &Value, aggressive: bool) -> Value {
    if !result.is_object() {
        return result.clone();
    }
    let map = render_tool_map();

    // render(name, props) dispatcher — result.component → 매핑된 render_* 로 재귀
    if tool_name == "render" {
        if let Some(comp) = result.get("component").and_then(Value::as_str) {
            let inv = render_tool_inverse_map();
            if let Some(mapped_tool) = inv.get(comp) {
                return slim_result_for_llm(mapped_tool, result, aggressive);
            }
            return json!({
                "success": true,
                "component": comp,
                "summary": format!("{} 렌더 완료", comp),
            });
        }
    }

    // render_* 특별 처리 (옛 TS 4 케이스 1:1)
    match tool_name {
        "render_stock_chart" => {
            let props = result.get("props").and_then(Value::as_object);
            let symbol = props
                .and_then(|p| p.get("symbol"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let data: Vec<&Value> = props
                .and_then(|p| p.get("data"))
                .and_then(Value::as_array)
                .map(|arr| arr.iter().collect())
                .unwrap_or_default();
            let closes: Vec<f64> = data
                .iter()
                .filter_map(|d| d.get("close").and_then(Value::as_f64))
                .collect();
            let summary = if data.is_empty() {
                "StockChart 렌더 완료".to_string()
            } else if closes.is_empty() {
                format!("StockChart 렌더 완료 · {} · {}개 OHLCV", symbol, data.len())
            } else {
                let last = closes[closes.len() - 1];
                let max = closes.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let min = closes.iter().cloned().fold(f64::INFINITY, f64::min);
                format!(
                    "StockChart 렌더 완료 · {} · {}개 OHLCV · 최근 종가 {} · 최고 {} · 최저 {}",
                    symbol,
                    data.len(),
                    last,
                    max,
                    min
                )
            };
            return json!({"success": true, "component": "StockChart", "summary": summary});
        }
        "render_table" => {
            let props = result.get("props").and_then(Value::as_object);
            let rows = props
                .and_then(|p| p.get("rows"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let headers = props
                .and_then(|p| p.get("headers"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            return json!({
                "success": true,
                "component": "Table",
                "summary": format!("Table 렌더 완료 · {}열 × {}행", headers, rows),
            });
        }
        "render_chart" => {
            let props = result.get("props").and_then(Value::as_object);
            let data_len = props
                .and_then(|p| p.get("data"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            return json!({
                "success": true,
                "component": "Chart",
                "summary": format!("Chart 렌더 완료 · {}개 포인트", data_len),
            });
        }
        "render_iframe" => {
            let len = result
                .get("htmlContent")
                .and_then(Value::as_str)
                .map(|s| s.len())
                .unwrap_or(0);
            return json!({
                "success": true,
                "component": "Html",
                "summary": format!("iframe 위젯 렌더 완료 · {}자", len),
            });
        }
        _ => {}
    }

    // 기타 render_* — component 이름만 AI 에 피드백 (props 탈거)
    if let Some(component) = map.get(tool_name) {
        return json!({
            "success": true,
            "component": component,
            "summary": format!("{} 렌더 완료", component),
        });
    }

    // 그 외 (sysmod_* / mcp_* / network_request / execute) — aggressive 시만 축약.
    // 현재 턴 결과는 원본 (AI 가 이번 턴 응답 작성에 바로 사용).
    if aggressive {
        return aggressive_summarize(result);
    }
    result.clone()
}

/// 이전 턴 tool 결과를 LLM 컨텍스트에서 최소 요약으로 축소.
/// 도구 종류 무관 일반 로직 (도메인별 분기 0). 옛 TS `aggressiveSummarize` 1:1.
pub fn aggressive_summarize(result: &Value) -> Value {
    let obj = match result.as_object() {
        Some(o) => o,
        None => return result.clone(),
    };

    // 실패는 에러 메시지 유지 (AI 가 재시도 판단에 필요)
    if obj.get("success").and_then(Value::as_bool) == Some(false) {
        let err = obj
            .get("error")
            .and_then(Value::as_str)
            .map(|s| slice_chars(s, AGGRESSIVE_ERROR_LIMIT))
            .unwrap_or_else(|| "unknown error".to_string());
        return json!({"success": false, "error": err});
    }

    // 성공 — 상위 필드 키·타입·길이 + 짧은 프리뷰
    let mut out = Map::new();
    out.insert("success".to_string(), json!(true));
    out.insert(
        "_note".to_string(),
        json!("이전 턴 결과 (원본은 축약됨). 필요시 해당 도구 재호출."),
    );

    if let Some(data) = obj.get("data") {
        if let Some(s) = data.as_str() {
            out.insert(
                "_preview".to_string(),
                json!(if s.chars().count() > AGGRESSIVE_STRING_DATA_PREVIEW {
                    format!("{}...", slice_chars(s, AGGRESSIVE_STRING_DATA_PREVIEW))
                } else {
                    s.to_string()
                }),
            );
        } else if data.is_object() || data.is_array() {
            let data_str = data.to_string();
            if data_str.len() <= AGGRESSIVE_DATA_KEEP_INLINE {
                // 작으면 그대로
                out.insert("data".to_string(), data.clone());
            } else if let Some(arr) = data.as_array() {
                let first = arr.first();
                let keys: Vec<String> = first
                    .and_then(Value::as_object)
                    .map(|o| {
                        o.keys()
                            .take(AGGRESSIVE_ARRAY_KEYS_MAX)
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                let summary = if keys.is_empty() {
                    format!("array length={}", arr.len())
                } else {
                    format!("array length={}, item keys=[{}]", arr.len(), keys.join(","))
                };
                out.insert("_summary".to_string(), json!(summary));
                out.insert(
                    "_preview".to_string(),
                    json!(format!(
                        "{}...",
                        slice_chars(&data_str, AGGRESSIVE_DATA_PREVIEW)
                    )),
                );
            } else if let Some(o) = data.as_object() {
                let keys: Vec<String> = o
                    .keys()
                    .take(AGGRESSIVE_OBJECT_KEYS_MAX)
                    .cloned()
                    .collect();
                out.insert(
                    "_summary".to_string(),
                    json!(format!("object keys=[{}]", keys.join(","))),
                );
                out.insert(
                    "_preview".to_string(),
                    json!(format!(
                        "{}...",
                        slice_chars(&data_str, AGGRESSIVE_DATA_PREVIEW)
                    )),
                );
            }
        } else if !data.is_null() {
            // 숫자·boolean — 그대로 보존
            out.insert("data".to_string(), data.clone());
        }
    }

    // 기타 상위 텍스트 필드 — 짧게만 (옛 TS 동등)
    for key in ["content", "text", "summary", "message"] {
        if let Some(s) = obj.get(key).and_then(Value::as_str) {
            if s.is_empty() {
                continue;
            }
            let trimmed = if s.chars().count() <= AGGRESSIVE_TEXT_FIELD_LIMIT {
                s.to_string()
            } else {
                format!("{}...", slice_chars(s, AGGRESSIVE_TEXT_FIELD_LIMIT))
            };
            out.insert(key.to_string(), json!(trimmed));
        }
    }

    Value::Object(out)
}

/// UTF-8 안전 — char 단위 cutoff (옛 TS `String.slice` 와 등동).
fn slice_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_small_result_unchanged() {
        let r = json!({"success": true, "data": "small"});
        assert_eq!(trim_tool_result(&r), r);
    }

    #[test]
    fn trim_large_result_keeps_core_fields() {
        let big_content = "x".repeat(3000);
        let r = json!({
            "success": true,
            "content": big_content,
            "items": [1, 2, 3, 4, 5],
        });
        let trimmed = trim_tool_result(&r);
        assert_eq!(trimmed["success"], json!(true));
        // content: 1500자 cap
        let content_str = trimmed["content"].as_str().unwrap();
        assert_eq!(content_str.chars().count(), 1500);
        // items: "[5 items]" 요약
        assert_eq!(trimmed["items"], json!("[5 items]"));
    }

    #[test]
    fn trim_large_result_truncates_data() {
        let big_obj: Value = json!({
            "success": true,
            "data": {"x": "a".repeat(3000)}
        });
        let trimmed = trim_tool_result(&big_obj);
        // data 크면 string slice + "..."
        let data_str = trimmed["data"].as_str().unwrap();
        assert!(data_str.ends_with("..."));
    }

    #[test]
    fn slim_render_table_summary() {
        let r = json!({
            "success": true,
            "component": "Table",
            "props": {
                "headers": ["A", "B", "C"],
                "rows": [["1","2","3"], ["4","5","6"]]
            }
        });
        let slim = slim_result_for_llm("render_table", &r, false);
        assert_eq!(slim["component"], json!("Table"));
        assert!(slim["summary"]
            .as_str()
            .unwrap()
            .contains("3열 × 2행"));
        // props 탈거됨 — 메타만
        assert!(slim.get("props").is_none());
    }

    #[test]
    fn slim_render_chart_with_data() {
        let r = json!({
            "success": true,
            "component": "Chart",
            "props": {"data": [1, 2, 3, 4, 5]}
        });
        let slim = slim_result_for_llm("render_chart", &r, false);
        assert!(slim["summary"]
            .as_str()
            .unwrap()
            .contains("5개 포인트"));
    }

    #[test]
    fn slim_render_stock_chart_with_ohlcv() {
        let r = json!({
            "success": true,
            "component": "StockChart",
            "props": {
                "symbol": "005930",
                "data": [
                    {"close": 70000.0},
                    {"close": 72000.0},
                    {"close": 75000.0}
                ]
            }
        });
        let slim = slim_result_for_llm("render_stock_chart", &r, false);
        let summary = slim["summary"].as_str().unwrap();
        assert!(summary.contains("005930"));
        assert!(summary.contains("3개 OHLCV"));
        assert!(summary.contains("최고 75000"));
        assert!(summary.contains("최저 70000"));
    }

    #[test]
    fn slim_render_iframe_summary() {
        let r = json!({
            "success": true,
            "component": "Html",
            "htmlContent": "<div>".repeat(100),
        });
        let slim = slim_result_for_llm("render_iframe", &r, false);
        assert!(slim["summary"]
            .as_str()
            .unwrap()
            .contains("iframe 위젯 렌더 완료"));
    }

    #[test]
    fn slim_render_dispatcher_resolves_component() {
        // tool_name='render' + component='Table' → render_table 매핑 후 재귀
        let r = json!({
            "success": true,
            "component": "Table",
            "props": {"headers": ["A"], "rows": [["1"]]}
        });
        let slim = slim_result_for_llm("render", &r, false);
        assert!(slim["summary"]
            .as_str()
            .unwrap()
            .contains("Table 렌더 완료"));
    }

    #[test]
    fn slim_unknown_tool_returns_original_when_not_aggressive() {
        let r = json!({
            "success": true,
            "data": {"price": 75000, "volume": 1000000}
        });
        let slim = slim_result_for_llm("sysmod_kiwoom", &r, false);
        // 원본 그대로
        assert_eq!(slim, r);
    }

    #[test]
    fn slim_unknown_tool_summarizes_when_aggressive() {
        let r = json!({
            "success": true,
            "data": {"x": "a".repeat(1000)}
        });
        let slim = slim_result_for_llm("sysmod_kiwoom", &r, true);
        // 축약됨
        assert!(slim.get("_note").is_some());
        assert!(slim.get("_summary").is_some() || slim.get("_preview").is_some());
    }

    #[test]
    fn aggressive_failure_keeps_error_message() {
        let r = json!({
            "success": false,
            "error": "x".repeat(1000)
        });
        let summarized = aggressive_summarize(&r);
        assert_eq!(summarized["success"], json!(false));
        let err = summarized["error"].as_str().unwrap();
        assert_eq!(err.chars().count(), 300);
    }

    #[test]
    fn aggressive_small_data_kept_inline() {
        let r = json!({"success": true, "data": {"a": 1, "b": 2}});
        let summarized = aggressive_summarize(&r);
        // 500자 미만 → 원본 보존
        assert_eq!(summarized["data"], json!({"a": 1, "b": 2}));
    }

    #[test]
    fn aggressive_large_array_summarized() {
        let big_arr: Vec<Value> = (0..100).map(|i| json!({"id": i, "name": "x"})).collect();
        let r = json!({"success": true, "data": big_arr});
        let summarized = aggressive_summarize(&r);
        assert!(summarized.get("_summary").is_some());
        let summary = summarized["_summary"].as_str().unwrap();
        assert!(summary.contains("array length=100"));
        assert!(summary.contains("item keys"));
    }

    #[test]
    fn aggressive_text_field_truncated() {
        let r = json!({
            "success": true,
            "content": "x".repeat(500)
        });
        let summarized = aggressive_summarize(&r);
        let content = summarized["content"].as_str().unwrap();
        assert!(content.ends_with("..."));
    }

    #[test]
    fn aggressive_string_data_preview() {
        let r = json!({
            "success": true,
            "data": "x".repeat(500)
        });
        let summarized = aggressive_summarize(&r);
        let preview = summarized["_preview"].as_str().unwrap();
        assert!(preview.ends_with("..."));
    }

    #[test]
    fn slice_chars_utf8_safe() {
        // 한국어 — char 단위 cutoff (byte 단위 cutoff 시 panic 위험)
        let s = "안녕하세요반갑습니다";
        assert_eq!(slice_chars(s, 5), "안녕하세요");
        // ASCII 도 동등 동작
        assert_eq!(slice_chars("abcdefg", 3), "abc");
    }
}
