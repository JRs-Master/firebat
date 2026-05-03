//! Pipeline resolver — `$prev` / `$prev.path` / `$stepN` / `$stepN.path` 치환.
//!
//! 옛 TS `TaskManager.resolveValue` Rust 재현 (Phase B-14 minimum).
//!
//! 핵심 — 옛 TS 에서 silent bug fix 한 패턴 (Vitest 도입 즉시 잡힌 것) 그대로 재현:
//! - `$prev.missing` 케이스에서 두 번째 regex 가 preserved literal 의 $prev 부분 덮어쓰는
//!   버그 → negative lookahead `\$prev(?!\.\w)` 로 fix.
//! - Rust 의 `regex` crate 는 lookahead 미지원 → 직접 walk 로 구현 (안전).

use crate::utils::path_resolve::resolve_field_path;
use serde_json::{Map, Value};

/// 임의의 값에서 `$prev` / `$prev.path` / `$stepN` / `$stepN.path` 치환 (재귀).
pub fn resolve_value(val: &Value, prev: &Value, step_results: &[Value]) -> Value {
    match val {
        Value::String(s) => Value::String(resolve_string(s, prev, step_results))
            .or_object_passthrough(s, prev, step_results),
        Value::Array(arr) => {
            Value::Array(arr.iter().map(|v| resolve_value(v, prev, step_results)).collect())
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), resolve_value(v, prev, step_results));
            }
            Value::Object(out)
        }
        _ => val.clone(),
    }
}

/// String 의 $prev / $stepN 치환을 처리.
/// 단일 reference (전체 string 이 `$prev` 또는 `$prev.path`) 면 객체·배열 그대로 반환.
/// 부분 치환 (string 안 mixed) 이면 stringify 후 결과 string.
fn resolve_string(s: &str, prev: &Value, step_results: &[Value]) -> String {
    // Step 1: 단일 reference 매칭은 caller (object_passthrough) 가 시도.
    // 여기서는 string 만 반환 (mixed 패턴 처리). object 가 들어오면 stringify.
    // 다만 caller 가 단일 reference 인 경우 별도 분기를 처리하므로 이 함수는 항상 string 결과.

    // 단일 $prev → string 일 때만 그대로 반환, 아니면 stringify
    if s == "$prev" {
        return value_to_string_for_substitution(prev);
    }
    // 단일 $stepN
    if let Some(idx) = parse_step_exact(s) {
        let result = step_results.get(idx).cloned().unwrap_or(Value::Null);
        return value_to_string_for_substitution(&result);
    }
    // 단일 $prev.path
    if let Some(path) = parse_prev_path_exact(s) {
        if let Some(v) = resolve_field_path(prev, path) {
            return value_to_string_for_substitution(v);
        }
        if let Value::String(ps) = prev {
            return ps.clone();
        }
        return s.to_string();
    }
    // 단일 $stepN.path
    if let Some((idx, path)) = parse_step_path_exact(s) {
        let result = step_results.get(idx).cloned().unwrap_or(Value::Null);
        if let Some(v) = resolve_field_path(&result, path) {
            return value_to_string_for_substitution(v);
        }
        if let Value::String(rs) = &result {
            return rs.clone();
        }
        return s.to_string();
    }

    // Mixed — 단어 단위 walk 로 $prev.path / $stepN.path / $prev / $stepN 치환.
    if !s.contains("$prev") && !s.contains("$step") {
        return s.to_string();
    }
    substitute_mixed(s, prev, step_results)
}

fn value_to_string_for_substitution(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        _ => v.to_string(),
    }
}

fn parse_step_exact(s: &str) -> Option<usize> {
    let stripped = s.strip_prefix("$step")?;
    if stripped.is_empty() {
        return None;
    }
    if !stripped.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    stripped.parse().ok()
}

fn parse_prev_path_exact(s: &str) -> Option<&str> {
    let path = s.strip_prefix("$prev.")?;
    if path.is_empty() || !is_valid_path_char_only(path) {
        return None;
    }
    Some(path)
}

fn parse_step_path_exact(s: &str) -> Option<(usize, &str)> {
    let stripped = s.strip_prefix("$step")?;
    let dot_pos = stripped.find('.')?;
    let (num_str, rest) = stripped.split_at(dot_pos);
    let path = &rest[1..]; // skip '.'
    if num_str.is_empty() || !num_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if path.is_empty() || !is_valid_path_char_only(path) {
        return None;
    }
    let idx: usize = num_str.parse().ok()?;
    Some((idx, path))
}

fn is_valid_path_char_only(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '[' || c == ']' || c == '-')
}

/// Mixed 치환 — string 안에 $prev / $stepN 패턴이 일반 텍스트와 섞여있는 경우.
/// 옛 TS 의 4 단계 regex 를 walk 로 재현. 미존재 path 는 literal 보존.
fn substitute_mixed(s: &str, prev: &Value, step_results: &[Value]) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            // $prev 또는 $stepN 시도
            if let Some((replacement, consumed)) = try_match_at(s, i, prev, step_results) {
                out.push_str(&replacement);
                i += consumed;
                continue;
            }
        }
        // 다음 byte (UTF-8 safe iteration via char_indices)
        let ch_start = i;
        let ch = s[ch_start..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// position i 에서 $prev / $stepN 패턴 매칭 시도. 매칭 시 (replacement, consumed_bytes).
fn try_match_at(
    s: &str,
    i: usize,
    prev: &Value,
    step_results: &[Value],
) -> Option<(String, usize)> {
    let rest = &s[i..];
    // $stepN.path 또는 $stepN 시도
    if let Some(after_step) = rest.strip_prefix("$step") {
        // 숫자 추출
        let num_end = after_step
            .bytes()
            .position(|b| !b.is_ascii_digit())
            .unwrap_or(after_step.len());
        if num_end == 0 {
            return None;
        }
        let num_str = &after_step[..num_end];
        let idx: usize = num_str.parse().ok()?;
        let result = step_results.get(idx).cloned().unwrap_or(Value::Null);
        let after_num = &after_step[num_end..];
        // .path 패턴이 있는지 확인
        if after_num.starts_with('.') {
            let path_str = &after_num[1..];
            // 첫 path-character 가 word character 여야 함 (.123 같은 일반 dot 회피)
            let first_ch = path_str.chars().next();
            if let Some(c) = first_ch {
                if c.is_ascii_alphanumeric() || c == '_' {
                    let path_end = path_str
                        .bytes()
                        .position(|b| {
                            let c = b as char;
                            !(c.is_ascii_alphanumeric()
                                || c == '_'
                                || c == '.'
                                || c == '['
                                || c == ']'
                                || c == '-')
                        })
                        .unwrap_or(path_str.len());
                    let path = &path_str[..path_end];
                    if !path.is_empty() {
                        let consumed = "$step".len() + num_end + 1 + path_end;
                        if let Some(v) = resolve_field_path(&result, path) {
                            return Some((value_to_string_for_substitution(v), consumed));
                        }
                        if let Value::String(rs) = &result {
                            return Some((rs.clone(), consumed));
                        }
                        // path 미존재 — literal 보존 (옛 TS 동일)
                        return Some((format!("$step{}.{}", idx, path), consumed));
                    }
                }
            }
        }
        // path 없음 → 단독 $stepN. 다음이 word char 면 ambiguous.
        let next_ch = after_num.chars().next();
        if let Some(c) = next_ch {
            // 옛 TS regex `(?!\.[\w\[])` — .word/.[ 가 따라오는 경우만 보존, 그 외엔 치환
            // 우리 코드는 위에서 .path 이미 처리. 여기는 일반 $stepN 단독 (다음 char 가 .word/.[ 아님)
            if c == '.' {
                // 다음 char 가 .word/.[ 라면 위 분기에서 처리됐어야 함
                // 그렇지 않다는 건 path 가 빈 문자열 또는 첫 char 가 word/_ 가 아닌 dot.
                // 옛 TS lookahead 와 동일하게 — .word/.[ 매칭 안 됨 → 치환 진행
            }
        }
        let consumed = "$step".len() + num_end;
        return Some((value_to_string_for_substitution(&result), consumed));
    }

    // $prev.path 또는 $prev 시도
    if let Some(after_prev) = rest.strip_prefix("$prev") {
        if after_prev.starts_with('.') {
            let path_str = &after_prev[1..];
            let first_ch = path_str.chars().next();
            if let Some(c) = first_ch {
                if c.is_ascii_alphanumeric() || c == '_' {
                    let path_end = path_str
                        .bytes()
                        .position(|b| {
                            let c = b as char;
                            !(c.is_ascii_alphanumeric()
                                || c == '_'
                                || c == '.'
                                || c == '['
                                || c == ']'
                                || c == '-')
                        })
                        .unwrap_or(path_str.len());
                    let path = &path_str[..path_end];
                    if !path.is_empty() {
                        let consumed = "$prev".len() + 1 + path_end;
                        if let Some(v) = resolve_field_path(prev, path) {
                            return Some((value_to_string_for_substitution(v), consumed));
                        }
                        if let Value::String(ps) = prev {
                            return Some((ps.clone(), consumed));
                        }
                        // path 미존재 — literal 보존
                        return Some((format!("$prev.{}", path), consumed));
                    }
                }
            }
        }
        // 단독 $prev — negative lookahead `(?!\.[\w_\[])` 동등
        // 옛 TS 의 silent bug fix: $prev.missing 이 literal 로 보존된 후 두 번째 regex 가 그 안 $prev 만 덮어쓰는 것 방지.
        // 우리는 walk 기반이라 자연스레 처리됨 (위 .path 분기에서 미매칭이면 단독 $prev 로 떨어짐).
        // 그러나 .word 가 따라오는데 path 가 미존재 케이스를 위 분기에서 literal 로 처리했음.
        // 여기 도달했다는 건 .word 가 안 따라오거나 path 매칭 실패가 아니라 진짜 단독 $prev.
        let consumed = "$prev".len();
        return Some((value_to_string_for_substitution(prev), consumed));
    }
    None
}

/// String 결과를 Object 로 wrap 또는 그대로 — caller 패턴 (단일 reference 면 객체 그대로).
trait StringObjectPassthrough {
    fn or_object_passthrough(self, original: &str, prev: &Value, step_results: &[Value]) -> Value;
}

impl StringObjectPassthrough for Value {
    fn or_object_passthrough(self, original: &str, prev: &Value, step_results: &[Value]) -> Value {
        // 단일 reference 인 경우 (전체 string = $prev 또는 $stepN[.path]) → 객체 그대로 반환.
        // 그래야 inputMap value 가 객체일 때 다음 step 의 stepInput 에 객체로 전달됨.
        if original == "$prev" {
            return prev.clone();
        }
        if let Some(idx) = parse_step_exact(original) {
            return step_results.get(idx).cloned().unwrap_or(Value::Null);
        }
        if let Some(path) = parse_prev_path_exact(original) {
            if let Some(v) = resolve_field_path(prev, path) {
                return v.clone();
            }
            return self;
        }
        if let Some((idx, path)) = parse_step_path_exact(original) {
            let result = step_results.get(idx).cloned().unwrap_or(Value::Null);
            if let Some(v) = resolve_field_path(&result, path) {
                return v.clone();
            }
            return self;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn single_prev_returns_value() {
        let prev = json!({"foo": "bar"});
        let result = resolve_value(&json!("$prev"), &prev, &[]);
        assert_eq!(result, prev);
    }

    #[test]
    fn single_prev_path_returns_value() {
        let prev = json!({"url": "https://x", "title": "T"});
        let result = resolve_value(&json!("$prev.url"), &prev, &[]);
        assert_eq!(result, json!("https://x"));
    }

    #[test]
    fn prev_path_object_returned_as_object() {
        let prev = json!({"data": {"k": 1}});
        let result = resolve_value(&json!("$prev.data"), &prev, &[]);
        assert_eq!(result, json!({"k": 1}));
    }

    #[test]
    fn prev_missing_path_preserved_as_literal() {
        // 옛 TS silent bug — $prev.missing 의 $prev 만 덮어쓰던 것 fix 검증
        let prev = json!({"foo": "bar"});
        let result = resolve_value(&json!("$prev.missing"), &prev, &[]);
        assert_eq!(result, json!("$prev.missing"));
    }

    #[test]
    fn mixed_string_substitution() {
        let prev = json!({"name": "삼성"});
        let result = resolve_value(&json!("Hello $prev.name!"), &prev, &[]);
        assert_eq!(result, json!("Hello 삼성!"));
    }

    #[test]
    fn step_n_reference() {
        let prev = json!(null);
        let steps = vec![json!({"value": 100}), json!({"value": 200})];
        let result = resolve_value(&json!("$step1.value"), &prev, &steps);
        assert_eq!(result, json!(200));
    }

    #[test]
    fn step_path_in_mixed_string() {
        let steps = vec![json!({"price": 75000})];
        let result = resolve_value(
            &json!("현재가: $step0.price원"),
            &Value::Null,
            &steps,
        );
        assert_eq!(result, json!("현재가: 75000원"));
    }

    #[test]
    fn nested_object_recursion() {
        let prev = json!({"id": "abc"});
        let val = json!({"meta": {"key": "$prev.id"}, "list": ["$prev"]});
        let result = resolve_value(&val, &prev, &[]);
        assert_eq!(
            result,
            json!({"meta": {"key": "abc"}, "list": [{"id": "abc"}]})
        );
    }

    #[test]
    fn array_index_in_path() {
        let prev = json!({"output": [{"id": 1}, {"id": 2}]});
        let result = resolve_value(&json!("$prev.output[1].id"), &prev, &[]);
        assert_eq!(result, json!(2));
    }

    #[test]
    fn no_substitution_returns_original() {
        let result = resolve_value(&json!("Hello world"), &Value::Null, &[]);
        assert_eq!(result, json!("Hello world"));
    }

    #[test]
    fn object_value_stringified_in_mixed() {
        let prev = json!({"nested": {"k": "v"}});
        let result = resolve_value(&json!("data: $prev.nested"), &prev, &[]);
        // mixed 컨텍스트에서는 object 가 JSON stringify 됨
        assert_eq!(result, json!("data: {\"k\":\"v\"}"));
    }
}
