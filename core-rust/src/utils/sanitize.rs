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

/// Reply segment — markdown 구조 분할 결과.
#[derive(Debug, Clone)]
pub enum ReplySegment {
    Text(String),
    Header { level: u8, text: String },
    Table { headers: Vec<String>, rows: Vec<Vec<String>> },
}

/// AI reply 안 markdown 표·헤더 자동 추출 — 옛 TS extractMarkdownStructure 1:1 port.
/// AI 가 마크다운 표/헤더 박으면 자동으로 component blocks 으로 변환 가능 (caller 가 segment →
/// render_header / render_table 매핑).
///
/// 결과 segments 순서:
/// - Text — `## 헤더` 또는 `|---|` 표 사이 일반 텍스트
/// - Header { level, text } — `# ~ ######` 마커 (level 1-6)
/// - Table { headers, rows } — `|...| / |---| / |...|` 구조
///
/// 일반 메커니즘 — 모든 표/헤더 동일 path 통과. 모델별 분기 0.
pub fn extract_markdown_structure(reply: &str) -> Vec<ReplySegment> {
    let mut segments = Vec::new();
    if reply.is_empty() {
        return segments;
    }
    let lines: Vec<&str> = reply.split('\n').collect();
    let mut text_buffer: Vec<&str> = Vec::new();

    let flush_text = |buf: &mut Vec<&str>, segments: &mut Vec<ReplySegment>| {
        if buf.is_empty() {
            return;
        }
        let mut text = buf.join("\n");
        // \n{3,} → \n\n (옛 TS 동등)
        while text.contains("\n\n\n") {
            text = text.replace("\n\n\n", "\n\n");
        }
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            segments.push(ReplySegment::Text(trimmed));
        }
        buf.clear();
    };

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        // 1. Header (# ~ ######)
        if let Some((level, text)) = parse_header(line) {
            flush_text(&mut text_buffer, &mut segments);
            segments.push(ReplySegment::Header {
                level,
                text: clean_inline(&text),
            });
            i += 1;
            continue;
        }

        // 2. Table — 헤더줄 + 구분줄 + 데이터줄
        if line.trim().starts_with('|') && i + 2 < lines.len() {
            if let Some((headers, rows, consumed)) = parse_table(&lines, i) {
                flush_text(&mut text_buffer, &mut segments);
                segments.push(ReplySegment::Table {
                    headers: headers.into_iter().map(|h| clean_inline(&h)).collect(),
                    rows: rows
                        .into_iter()
                        .map(|r| r.into_iter().map(|c| clean_inline(&c)).collect())
                        .collect(),
                });
                i += consumed;
                continue;
            }
        }

        // 3. 일반 텍스트
        text_buffer.push(line);
        i += 1;
    }
    flush_text(&mut text_buffer, &mut segments);
    segments
}

fn parse_header(line: &str) -> Option<(u8, String)> {
    let trimmed = line.trim_start();
    let mut hash_count = 0_u8;
    for c in trimmed.chars() {
        if c == '#' {
            hash_count += 1;
            if hash_count > 6 {
                return None;
            }
        } else {
            break;
        }
    }
    if hash_count == 0 || hash_count > 6 {
        return None;
    }
    let after = &trimmed[hash_count as usize..];
    if !after.starts_with(' ') && !after.starts_with('\t') {
        return None;
    }
    let text = after.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some((hash_count, text))
}

/// Table 파싱 — `lines[start]` 가 헤더줄이라 가정. 매칭되면 (headers, rows, lines_consumed).
fn parse_table(lines: &[&str], start: usize) -> Option<(Vec<String>, Vec<Vec<String>>, usize)> {
    let header_line = lines[start].trim();
    let sep_line = lines.get(start + 1)?.trim();
    if !sep_line.starts_with('|') {
        return None;
    }

    let sep_cells: Vec<String> = split_table_cells(sep_line);
    if sep_cells.is_empty() || !sep_cells.iter().all(is_valid_separator) {
        return None;
    }
    let header_cells: Vec<String> = split_table_cells(header_line);
    if header_cells.len() != sep_cells.len() {
        return None;
    }

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut j = start + 2;
    while j < lines.len() && lines[j].trim().starts_with('|') {
        let cells = split_table_cells(lines[j].trim());
        if cells.len() != header_cells.len() {
            break;
        }
        rows.push(cells);
        j += 1;
    }
    if rows.is_empty() {
        return None;
    }
    Some((header_cells, rows, j - start))
}

fn split_table_cells(line: &str) -> Vec<String> {
    // |a|b|c| → ["a", "b", "c"]. 첫·끝 빈 cell 제거.
    let parts: Vec<String> = line.split('|').map(|s| s.trim().to_string()).collect();
    if parts.len() < 2 {
        return Vec::new();
    }
    parts[1..parts.len() - 1].to_vec()
}

fn is_valid_separator(cell: &String) -> bool {
    // ^:?-+:?$ — `:---`, `---:`, `:---:`, `---` 모두 허용
    let s = cell.trim();
    if s.is_empty() {
        return false;
    }
    let mut chars = s.chars().peekable();
    if chars.peek() == Some(&':') {
        chars.next();
    }
    let mut dash_count = 0;
    while let Some(&c) = chars.peek() {
        if c == '-' {
            dash_count += 1;
            chars.next();
        } else {
            break;
        }
    }
    if dash_count == 0 {
        return false;
    }
    if chars.peek() == Some(&':') {
        chars.next();
    }
    chars.next().is_none()
}

fn clean_inline(s: &str) -> String {
    strip_markdown_markers(s).trim().to_string()
}

/// extract_markdown_structure 의 segment → render_* component blocks 변환.
/// AiManager.process_with_tools 가 sanitize_reply 후 호출 — text segment 만 reply 에 남고
/// header/table 은 blocks 로 분리.
pub fn segments_to_blocks(segments: Vec<ReplySegment>) -> (String, Vec<Value>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut blocks: Vec<Value> = Vec::new();
    for seg in segments {
        match seg {
            ReplySegment::Text(t) => text_parts.push(t),
            ReplySegment::Header { level, text } => {
                blocks.push(serde_json::json!({
                    "type": "Header",
                    "props": {"text": text, "level": level}
                }));
            }
            ReplySegment::Table { headers, rows } => {
                blocks.push(serde_json::json!({
                    "type": "Table",
                    "props": {"columns": headers, "rows": rows}
                }));
            }
        }
    }
    (text_parts.join("\n\n"), blocks)
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

    #[test]
    fn extract_header_segment() {
        let reply = "## 안녕\n\n본문 텍스트";
        let segments = extract_markdown_structure(reply);
        assert_eq!(segments.len(), 2);
        match &segments[0] {
            ReplySegment::Header { level, text } => {
                assert_eq!(*level, 2);
                assert_eq!(text, "안녕");
            }
            _ => panic!("first segment 가 Header 아님"),
        }
        match &segments[1] {
            ReplySegment::Text(t) => assert_eq!(t, "본문 텍스트"),
            _ => panic!("second segment 가 Text 아님"),
        }
    }

    #[test]
    fn extract_table_segment() {
        let reply = "| 이름 | 가격 |\n|---|---|\n| A | 100 |\n| B | 200 |";
        let segments = extract_markdown_structure(reply);
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            ReplySegment::Table { headers, rows } => {
                assert_eq!(headers, &["이름", "가격"]);
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0], vec!["A".to_string(), "100".to_string()]);
            }
            _ => panic!("Table 아님"),
        }
    }

    #[test]
    fn segments_to_blocks_separates_text_and_components() {
        let reply = "도입부\n\n## 헤더\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n결론";
        let segments = extract_markdown_structure(reply);
        let (text, blocks) = segments_to_blocks(segments);
        assert!(text.contains("도입부"));
        assert!(text.contains("결론"));
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "Header");
        assert_eq!(blocks[1]["type"], "Table");
    }

    #[test]
    fn invalid_table_kept_as_text() {
        // 구분선 없으면 일반 텍스트 (옛 TS 와 동일)
        let reply = "| a | b |\n| 1 | 2 |";
        let segments = extract_markdown_structure(reply);
        assert_eq!(segments.len(), 1);
        assert!(matches!(&segments[0], ReplySegment::Text(_)));
    }

    #[test]
    fn empty_reply_returns_empty_segments() {
        let segments = extract_markdown_structure("");
        assert!(segments.is_empty());
    }

    #[test]
    fn header_inline_markdown_stripped() {
        let reply = "# **굵은 헤더**";
        let segments = extract_markdown_structure(reply);
        match &segments[0] {
            ReplySegment::Header { text, .. } => assert_eq!(text, "굵은 헤더"),
            _ => panic!(),
        }
    }
}
