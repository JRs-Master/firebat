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
                cur = match map.get(raw_key) {
                    Some(v) => v,
                    // Two Korean strings that print identically can differ in bytes: a syllable
                    // may arrive DECOMPOSED (초성+중성+종성 jamo) instead of precomposed. Tool-call
                    // arguments are exactly where that happens to Korean
                    // ([[korean_char_corruption_root_cause]]), and the failure is invisible —
                    // measured 2026-08-13 (turn 58): every cached row carried `조문내용`, a grep
                    // for `조문내용` matched nothing, and the diagnostic listed the field it had
                    // just said was missing. The model called that contradictory, repeated the
                    // same call three times and burned the turn's budget paging 1,337 rows by
                    // hand instead. Compare composed forms before giving up.
                    None => map
                        .iter()
                        .find(|(k, _)| compose_hangul(k) == compose_hangul(raw_key))
                        .map(|(_, v)| v)?,
                };
            }
            _ => return None,
        }
    }
    Some(cur)
}

/// Precomposes decomposed Hangul (Unicode's algorithmic L+V(+T) → syllable). Everything else is
/// passed through untouched, so this is a no-op for ASCII keys.
///
/// No dependency needed: Hangul composition is arithmetic, unlike general NFC.
pub fn compose_hangul(s: &str) -> String {
    const L_BASE: u32 = 0x1100;
    const V_BASE: u32 = 0x1161;
    const T_BASE: u32 = 0x11A7;
    const S_BASE: u32 = 0xAC00;
    const V_COUNT: u32 = 21;
    const T_COUNT: u32 = 28;

    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i] as u32;
        let l = c.checked_sub(L_BASE).filter(|n| *n < 19);
        let v = chars
            .get(i + 1)
            .map(|c| *c as u32)
            .and_then(|n| n.checked_sub(V_BASE))
            .filter(|n| *n < V_COUNT);
        match (l, v) {
            (Some(l), Some(v)) => {
                let t = chars
                    .get(i + 2)
                    .map(|c| *c as u32)
                    .and_then(|n| n.checked_sub(T_BASE))
                    .filter(|n| *n > 0 && *n < T_COUNT);
                let syllable = S_BASE + ((l * V_COUNT) + v) * T_COUNT + t.unwrap_or(0);
                out.push(char::from_u32(syllable).unwrap_or(chars[i]));
                i += if t.is_some() { 3 } else { 2 };
            }
            _ => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `[n]` / `[-n]` → `.n`. Walks characters, not bytes: walking bytes and pushing each one back
/// as a `char` turned every multi-byte character into Latin-1 garbage (one Hangul syllable = three
/// UTF-8 bytes = three Latin letters), so no non-ASCII field name could ever match — measured
/// 2026-11-12 with exact NFC bytes on both sides (law-search `조문번호` · `조문내용`, 0 rows). The
/// composed-Hangul comparison above ran on that garbage too, so it never helped either.
fn normalize_brackets(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    let mut out = String::with_capacity(path.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '[' {
            // capture [-?123] and turn it into .123
            let mut j = i + 1;
            let mut num = String::new();
            if j < chars.len() && chars[j] == '-' {
                num.push('-');
                j += 1;
            }
            while j < chars.len() && chars[j].is_ascii_digit() {
                num.push(chars[j]);
                j += 1;
            }
            if j < chars.len() && chars[j] == ']' && !num.is_empty() {
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

    // Non-ASCII field names — the keys and paths are this test's own data, written as escapes so
    // the bytes are fixed whatever the editor does (조 = U+C870 · 문 = U+BB38 · 번 = U+BC88 · 호 = U+D638).
    #[test]
    fn resolve_korean_field_name() {
        let v = json!({"\u{c870}\u{bb38}": "x"});
        assert_eq!(resolve_field_path(&v, "\u{c870}\u{bb38}"), Some(&Value::String("x".to_string())));
    }

    #[test]
    fn resolve_korean_field_name_after_an_index() {
        let v = json!({"rows": [{"\u{bc88}\u{d638}": "1"}, {"\u{bc88}\u{d638}": "2"}]});
        assert_eq!(resolve_field_path(&v, "rows[1].\u{bc88}\u{d638}"), Some(&Value::String("2".to_string())));
        assert_eq!(resolve_field_path(&v, "rows.0.\u{bc88}\u{d638}"), Some(&Value::String("1".to_string())));
    }

    #[test]
    fn resolve_decomposed_korean_path_against_a_composed_key() {
        // 조문 as jamo (ᄌ ᅩ · ᄆ ᅮ ᆫ) — the branch that compares composed forms
        let v = json!({"\u{c870}\u{bb38}": "x"});
        assert_eq!(resolve_field_path(&v, "\u{110c}\u{1169}\u{1106}\u{116e}\u{11ab}"), Some(&Value::String("x".to_string())));
    }

    #[test]
    fn normalize_brackets_keeps_non_ascii() {
        assert_eq!(normalize_brackets("\u{c870}\u{bb38}[2]"), "\u{c870}\u{bb38}.2");
        assert_eq!(normalize_brackets("a[-1].\u{bc88}\u{d638}"), "a.-1.\u{bc88}\u{d638}");
    }
}
