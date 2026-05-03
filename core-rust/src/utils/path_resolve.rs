//! 객체·배열 path 해석 — 옛 TS `core/utils/path-resolve.ts` Rust 재현.
//!
//! 점 표기 + array index + 음수 index (뒤에서 N번째) 지원.
//! 일반 메커니즘 — 특정 sysmod 응답 형태 가정 X. 어떤 array/object 응답에도 동작.
//!
//! 지원 형태:
//!   foo                  → obj.foo
//!   foo.bar.baz          → obj.foo.bar.baz
//!   output[0]            → obj.output[0]
//!   output[0].opnd_yn    → obj.output[0].opnd_yn
//!   foo[2][3]            → 다차원
//!   output[-1].x         → 배열 마지막 요소의 x
//!   output.0.x           → 점 표기로 인덱스 OK

use serde_json::Value;

/// path 해석 — 미존재 / 타입 불일치 시 None.
pub fn resolve_field_path<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(obj);
    }
    // [n] / [-n] → .n 정규화
    let normalized = normalize_brackets(path);
    let mut cur: &Value = obj;
    for raw_key in normalized.split('.') {
        if raw_key.is_empty() {
            continue;
        }
        match cur {
            Value::Array(arr) => {
                let idx: i64 = raw_key.parse().ok()?;
                let real_idx = if idx < 0 {
                    (arr.len() as i64) + idx
                } else {
                    idx
                };
                if real_idx < 0 || real_idx as usize >= arr.len() {
                    return None;
                }
                cur = &arr[real_idx as usize];
            }
            Value::Object(map) => {
                cur = map.get(raw_key)?;
            }
            _ => return None,
        }
    }
    Some(cur)
}

fn normalize_brackets(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '[' {
            // [-?123] 캡처 후 .123 으로 변환
            let mut j = i + 1;
            let mut num = String::new();
            if j < bytes.len() && bytes[j] as char == '-' {
                num.push('-');
                j += 1;
            }
            while j < bytes.len() && (bytes[j] as char).is_ascii_digit() {
                num.push(bytes[j] as char);
                j += 1;
            }
            if j < bytes.len() && bytes[j] as char == ']' && !num.is_empty() {
                out.push('.');
                out.push_str(&num);
                i = j + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_simple_dot_path() {
        let v = json!({"foo": {"bar": "baz"}});
        assert_eq!(resolve_field_path(&v, "foo.bar"), Some(&Value::String("baz".to_string())));
    }

    #[test]
    fn resolve_array_index_bracket() {
        let v = json!({"items": [{"id": 1}, {"id": 2}]});
        let r = resolve_field_path(&v, "items[1].id").unwrap();
        assert_eq!(r, &Value::Number(2.into()));
    }

    #[test]
    fn resolve_array_index_dot() {
        let v = json!({"items": [10, 20, 30]});
        let r = resolve_field_path(&v, "items.1").unwrap();
        assert_eq!(r, &Value::Number(20.into()));
    }

    #[test]
    fn resolve_negative_index() {
        let v = json!({"items": [10, 20, 30]});
        let r = resolve_field_path(&v, "items[-1]").unwrap();
        assert_eq!(r, &Value::Number(30.into()));
    }

    #[test]
    fn resolve_missing_returns_none() {
        let v = json!({"foo": "bar"});
        assert!(resolve_field_path(&v, "missing.path").is_none());
    }

    #[test]
    fn resolve_multidim() {
        let v = json!({"grid": [[1, 2], [3, 4]]});
        let r = resolve_field_path(&v, "grid[1][0]").unwrap();
        assert_eq!(r, &Value::Number(3.into()));
    }
}
