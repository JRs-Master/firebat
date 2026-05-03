//! LLM 응답 sanitize — 옛 TS core/utils/sanitize.ts Rust port.
//!
//! 모든 LLM (Gemini/Claude/Codex/GPT, API/CLI 공통) 이 AiManager.process_with_tools 하나를
//! 거치므로 여기서 정제 레이어 1 회만 수행. 프론트는 받은 값 그대로 렌더.
//!
//! 필드 기반 일반 로직 (모델별 분기 / 도구별 hardcode 0):
//! - TEXT_FIELDS: label/title/message/description/etc → HTML 태그 + 마크다운 마커 제거
//! - NUMERIC_LIKE_FIELDS: value/delta → cleanText (locale 콤마 포맷팅은 AI 책임)
//! - TEXT_ARRAY_FIELDS: columns/rows/cells/items/etc → 재귀 (rows 는 2차원, insideTextArray 플래그)
//! - PRESERVE_FIELDS_BY_COMP: Text.content / Html.content/htmlContent → 원본 유지

use serde_json::Value;

use std::collections::HashSet;
use std::sync::OnceLock;

fn text_fields() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "label", "title", "subtitle", "message", "subLabel", "description", "text", "name",
            "key", "symbol", "alt", "placeholder", "helpUrl", "targetDate", "category",
            "estimatedTime", "unit",
        ]
        .into_iter()
        .collect()
    })
}

fn numeric_like_fields() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| ["value", "delta"].into_iter().collect())
}

fn text_array_fields() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "columns",
            "headers",
            "rows",
            "cells",
            "items",
            "steps",
            "indicators",
            "buyPoints",
            "sellPoints",
        ]
        .into_iter()
        .collect()
    })
}

/// component_name + field_name 조합이 매칭되면 원본 유지 (Text.content, Html.content/htmlContent).
fn preserve(component: &str, field: &str) -> bool {
    matches!(
        (component, field),
        ("Text", "content")
            | ("Html", "content")
            | ("Html", "htmlContent")
    )
}

/// HTML 태그 제거 + 마크다운 강조 마커 제거 + Unicode escape decode.
/// 옛 TS cleanText 1:1 port.
pub fn clean_text(s: &str) -> String {
    // 1. Unicode escape decode (Claude Haiku 가 \\ud83d\\udd1f 같은 escape 박는 케이스)
    let decoded = decode_unicode_escapes(s);
    // 2. HTML 태그 제거 (간단한 regex 없는 walk 방식 — `<...>` 매칭)
    let stripped = strip_html_tags(&decoded);
    // 3. 마크다운 강조 마커 제거 — `**굵게**`, `*기울임*`, `` `코드` ``
    strip_markdown_markers(&stripped)
}

/// `\uXXXX` / `\uHHHH\uLLLL` (surrogate pair) → UTF-8.
fn decode_unicode_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 5 < bytes.len() && bytes[i] == b'\\' && bytes[i + 1] == b'u' {
            let hex = &s[i + 2..i + 6];
            if let Ok(code1) = u32::from_str_radix(hex, 16) {
                // surrogate pair?
                if (0xD800..=0xDBFF).contains(&code1)
                    && i + 11 < bytes.len()
                    && bytes[i + 6] == b'\\'
                    && bytes[i + 7] == b'u'
                {
                    let hex2 = &s[i + 8..i + 12];
                    if let Ok(code2) = u32::from_str_radix(hex2, 16) {
                        if (0xDC00..=0xDFFF).contains(&code2) {
                            let combined =
                                0x10000 + ((code1 - 0xD800) << 10) + (code2 - 0xDC00);
                            if let Some(c) = char::from_u32(combined) {
                                out.push(c);
                                i += 12;
                                continue;
                            }
                        }
                    }
                }
                if let Some(c) = char::from_u32(code1) {
                    out.push(c);
                    i += 6;
                    continue;
                }
            }
        }
        let ch_start = i;
        let ch = s[ch_start..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0_i32;
    for c in s.chars() {
        if c == '<' {
            depth += 1;
            continue;
        }
        if c == '>' && depth > 0 {
            depth -= 1;
            continue;
        }
        if depth == 0 {
            out.push(c);
        }
    }
    out
}

/// `**굵게**` / `*기울임*` / `` `코드` `` 마커 제거. 마크다운 텍스트 → 평문.
fn strip_markdown_markers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // ** ... ** 또는 * ... *
        if c == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            continue;
        }
        if c == '*' {
            i += 1;
            continue;
        }
        // ` ... `
        if c == '`' {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 재귀 sanitize — 옛 TS sanitizeValue 1:1 port.
pub fn sanitize_value(
    val: &Value,
    component: Option<&str>,
    field: Option<&str>,
    inside_text_array: bool,
) -> Value {
    // preserve 대상
    if let (Some(c), Some(f)) = (component, field) {
        if preserve(c, f) {
            return val.clone();
        }
    }

    match val {
        Value::Null => Value::Null,
        Value::Bool(_) | Value::Number(_) => val.clone(),
        Value::String(s) => {
            // TEXT_FIELDS 또는 NUMERIC_LIKE_FIELDS 또는 inside_text_array → cleanText
            let should_clean = match field {
                Some(f) => text_fields().contains(f) || numeric_like_fields().contains(f),
                None => inside_text_array,
            };
            if should_clean {
                Value::String(clean_text(s))
            } else {
                val.clone()
            }
        }
        Value::Array(arr) => {
            let next_inside = inside_text_array
                || field.map(|f| text_array_fields().contains(f)).unwrap_or(false);
            Value::Array(
                arr.iter()
                    .map(|v| sanitize_value(v, component, None, next_inside))
                    .collect(),
            )
        }
        Value::Object(map) => {
            let next_component = match map.get("type").and_then(|v| v.as_str()) {
                Some(t) => Some(t),
                None => component,
            };
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), sanitize_value(v, next_component, Some(k), false));
            }
            Value::Object(out)
        }
    }
}

/// AiResponse.reply 정제 — clean_text 단일 호출 (block 안 텍스트가 아니라 외부 reply).
pub fn sanitize_reply(reply: &str) -> String {
    clean_text(reply)
}

/// Block 단일 정제 — sanitize_value(block, None, None, false).
pub fn sanitize_block(block: &Value) -> Value {
    sanitize_value(block, None, None, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_text_strips_html() {
        assert_eq!(clean_text("<b>굵게</b>"), "굵게");
        assert_eq!(clean_text("plain"), "plain");
    }

    #[test]
    fn clean_text_strips_markdown_bold() {
        assert_eq!(clean_text("**굵게**"), "굵게");
        assert_eq!(clean_text("*기울임*"), "기울임");
    }

    #[test]
    fn decode_unicode_escapes_handles_surrogate_pair() {
        // \\ud83d\\udd1f = 🔟
        let s = "test \\ud83d\\udd1f text";
        assert_eq!(decode_unicode_escapes(s), "test 🔟 text");
    }

    #[test]
    fn sanitize_text_field_strips_html() {
        let val = json!({"type": "Header", "label": "<strong>안녕</strong>"});
        let cleaned = sanitize_block(&val);
        assert_eq!(cleaned["label"], "안녕");
    }

    #[test]
    fn sanitize_preserves_text_content() {
        let val = json!({"type": "Text", "content": "**원본 마크다운 보존**"});
        let cleaned = sanitize_block(&val);
        assert_eq!(cleaned["content"], "**원본 마크다운 보존**");
    }

    #[test]
    fn sanitize_preserves_html_content() {
        let val = json!({"type": "Html", "content": "<div>raw HTML</div>"});
        let cleaned = sanitize_block(&val);
        assert_eq!(cleaned["content"], "<div>raw HTML</div>");
    }

    #[test]
    fn sanitize_recurses_into_array_field() {
        let val = json!({
            "type": "Table",
            "columns": ["**col1**", "<i>col2</i>"]
        });
        let cleaned = sanitize_block(&val);
        assert_eq!(cleaned["columns"][0], "col1");
        assert_eq!(cleaned["columns"][1], "col2");
    }

    #[test]
    fn sanitize_nested_object() {
        let val = json!({
            "type": "Card",
            "title": "**Title**",
            "footer": {"label": "<em>foot</em>"}
        });
        let cleaned = sanitize_block(&val);
        assert_eq!(cleaned["title"], "Title");
        assert_eq!(cleaned["footer"]["label"], "foot");
    }

    #[test]
    fn sanitize_reply_cleans_string() {
        assert_eq!(sanitize_reply("<b>안녕</b> **세계**"), "안녕 세계");
    }
}
