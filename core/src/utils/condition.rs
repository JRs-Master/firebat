//! CONDITION 평가 — 옛 TS `core/utils/condition.ts` Rust 재현.
//!
//! pipeline CONDITION step + cron oneShot 자동 취소 양쪽에서 사용. 단일 source 보장.
//!
//! 안전 정책 (자동매매 컨텍스트 우선):
//! - 비숫자 `<`/`<=`/`>`/`>=` 는 false 반환 (string compare 안 함 — undefined 동작 회피)
//! - 빈 문자열은 'exists' 에서 not exists 로 간주
//! - 양쪽이 number 로 변환 가능하면 숫자 비교

use serde_json::Value;

pub fn evaluate_condition(actual: &Value, op: &str, expected: Option<&Value>) -> bool {
    if op == "exists" {
        return !is_empty(actual);
    }
    if op == "not_exists" {
        return is_empty(actual);
    }

    let expected = match expected {
        Some(v) => v,
        None => return false,
    };

    let num_actual = to_f64(actual);
    let num_expected = to_f64(expected);
    let both_numeric = num_actual.is_some() && num_expected.is_some();

    match op {
        "==" => {
            if both_numeric {
                num_actual == num_expected
            } else {
                to_string(actual) == to_string(expected)
            }
        }
        "!=" => {
            if both_numeric {
                num_actual != num_expected
            } else {
                to_string(actual) != to_string(expected)
            }
        }
        "<" => {
            if let (Some(a), Some(b)) = (num_actual, num_expected) {
                a < b
            } else {
                false
            }
        }
        "<=" => {
            if let (Some(a), Some(b)) = (num_actual, num_expected) {
                a <= b
            } else {
                false
            }
        }
        ">" => {
            if let (Some(a), Some(b)) = (num_actual, num_expected) {
                a > b
            } else {
                false
            }
        }
        ">=" => {
            if let (Some(a), Some(b)) = (num_actual, num_expected) {
                a >= b
            } else {
                false
            }
        }
        "includes" => to_string(actual).contains(&to_string(expected)),
        "not_includes" => !to_string(actual).contains(&to_string(expected)),
        _ => false,
    }
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

fn to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                s.parse::<f64>().ok()
            }
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn equal_numeric() {
        assert!(evaluate_condition(&json!(75000), "==", Some(&json!(75000))));
        assert!(evaluate_condition(&json!("75000"), "==", Some(&json!(75000))));
    }

    #[test]
    fn equal_string_fallback() {
        assert!(evaluate_condition(&json!("abc"), "==", Some(&json!("abc"))));
        assert!(!evaluate_condition(&json!("abc"), "==", Some(&json!("def"))));
    }

    #[test]
    fn less_than_numeric() {
        assert!(evaluate_condition(&json!(70000), "<", Some(&json!(75000))));
        assert!(!evaluate_condition(&json!(80000), "<", Some(&json!(75000))));
    }

    #[test]
    fn less_than_non_numeric_returns_false() {
        // 자동매매 안전 — string compare 회피
        assert!(!evaluate_condition(&json!("abc"), "<", Some(&json!("xyz"))));
    }

    #[test]
    fn exists_treats_empty_string_as_not_exists() {
        assert!(!evaluate_condition(&json!(""), "exists", None));
        assert!(evaluate_condition(&json!("data"), "exists", None));
        assert!(evaluate_condition(&json!(0), "exists", None));
    }

    #[test]
    fn not_exists_inverse() {
        assert!(evaluate_condition(&Value::Null, "not_exists", None));
        assert!(!evaluate_condition(&json!("data"), "not_exists", None));
    }

    #[test]
    fn includes_substring() {
        assert!(evaluate_condition(&json!("hello world"), "includes", Some(&json!("world"))));
        assert!(!evaluate_condition(&json!("hello"), "includes", Some(&json!("world"))));
    }

    #[test]
    fn unknown_op_returns_false() {
        assert!(!evaluate_condition(&json!(1), "?", Some(&json!(1))));
    }
}
