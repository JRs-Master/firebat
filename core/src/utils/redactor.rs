//! 공용 토큰 / 시크릿 redactor — 옛 `lib/redactor.ts` 1:1 Rust port.
//!
//! AI 응답 / 도구 결과 / 에러 메시지 사용자 노출 직전 통과. 외부 API 응답 본문 안
//! api-key / customer-id / Bearer 토큰 / JWT / Telegram bot token / OpenAI sk-* /
//! Anthropic sk-ant-* / Google AIza* / GitHub ghp_* / Slack xox*-* 등 자동 마스킹.
//!
//! 사용 site:
//!   - AiManager.process_with_tools_opts 끝 — AiResponse 안 모든 string 필드 통과
//!   - 도구 실행 결과 build 시점 — sysmod / mcp / 내장 도구 에러 메시지
//!   - gRPC TonicStatus::internal / invalid_argument 직전 (선택)
//!
//! Defense-in-depth — frontend `lib/redactor.ts` 도 logger meta 영역 추가 layer 적용.

use serde_json::Value;

const MASK: &str = "[REDACTED]";

/// 민감 정보 마스킹 — 옛 TS `redactString` 1:1 port.
///
/// 매 패턴 마다 알려진 토큰 prefix (sk-, sk-ant-, AIza, ghp_, xox*, fbat_, fbt_, eyJ JWT)
/// + 길이 ≥40 의 보수적 base64 like 영역 + 네이버 광고 API 의 `api-key:` / `customer-id:` /
/// `x-signature:` / `access-license:` key=value 패턴 모두 cover.
pub fn redact_string(s: &str) -> String {
    let mut out = s.to_string();

    // 알려진 토큰 prefix — 단순 substring replace 대신 정규식 사용 시 regex crate 의존 필요.
    // Rust std 만 사용 — 수동 패턴 매칭 (per char loop).
    out = redact_known_tokens(&out);

    // 네이버 광고 API + 비슷한 key=value 안 민감 value — `api-key: <hex>` / `customer-id: -1` 등.
    out = redact_key_value_pair(&out, &["api-key", "api_key", "apikey", "x-api-key"]);
    out = redact_key_value_pair(&out, &["customer-id", "customer_id", "customerid"]);
    out = redact_key_value_pair(&out, &["x-signature", "signature"]);
    out = redact_key_value_pair(&out, &["access-license", "access_license"]);
    out = redact_key_value_pair(&out, &["secret-key", "secret_key", "secretkey"]);
    out = redact_key_value_pair(&out, &["authorization", "bearer"]);
    out = redact_key_value_pair(&out, &["token", "access-token", "refresh-token"]);

    out
}

/// 알려진 prefix 토큰 마스킹 — `sk-XXX...`, `sk-ant-XXX...`, `AIza...`, `ghp_...`, `xox?-...`,
/// `fbat_...`, `fbt_...`, JWT (`eyJ...\.eyJ...\.XXX`), Telegram bot (`12345:XXX...`).
fn redact_known_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // 후보 prefix 검사 — 가장 긴 매칭 먼저.
        let remaining: String = chars[i..].iter().collect();
        if let Some(consumed) = match_token_prefix(&remaining) {
            out.push_str(MASK);
            i += consumed;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// remaining 의 prefix 가 알려진 토큰 형태면 consumed char 수 반환. 아니면 None.
fn match_token_prefix(remaining: &str) -> Option<usize> {
    // Telegram bot token: `123456789:AAAA-AAAA_AAAA...` (8-12 digit + `:` + 30+ alnum/_-)
    if let Some(c) = match_telegram_bot_token(remaining) {
        return Some(c);
    }
    // JWT — `eyJ` + 20+ + `.` + `eyJ` + 20+ + `.` + 20+
    if let Some(c) = match_jwt(remaining) {
        return Some(c);
    }
    // 짧은 prefix — sk-ant-, sk-, AIza, ghp_, xoxb-/xoxa-/xoxp-/xoxr-/xoxs-, fbat_, fbt_
    for prefix in &[
        "sk-ant-",
        "sk-",
        "AIza",
        "ghp_",
        "xoxb-",
        "xoxa-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "fbat_",
        "fbt_",
    ] {
        if remaining.starts_with(prefix) {
            // 이어지는 alnum/_-/=/+/ 의 길이 검사 (≥20)
            let after_prefix = &remaining[prefix.len()..];
            let consumed = after_prefix
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(*c, '_' | '-' | '+' | '/' | '='))
                .count();
            if consumed >= 20 {
                return Some(prefix.len() + consumed);
            }
        }
    }
    None
}

fn match_telegram_bot_token(s: &str) -> Option<usize> {
    let chars: Vec<char> = s.chars().collect();
    let digit_end = chars
        .iter()
        .position(|c| !c.is_ascii_digit())
        .unwrap_or(chars.len());
    if !(8..=12).contains(&digit_end) {
        return None;
    }
    if chars.get(digit_end) != Some(&':') {
        return None;
    }
    let after_colon = digit_end + 1;
    let token_end = chars[after_colon..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(**c, '_' | '-'))
        .count();
    if token_end < 30 {
        return None;
    }
    Some(after_colon + token_end)
}

fn match_jwt(s: &str) -> Option<usize> {
    if !s.starts_with("eyJ") {
        return None;
    }
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut segment_count = 0;
    while i < chars.len() {
        let seg_start = i;
        while i < chars.len()
            && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '-' | '+' | '/' | '='))
        {
            i += 1;
        }
        let seg_len = i - seg_start;
        if seg_len < 20 {
            return None;
        }
        segment_count += 1;
        if segment_count == 3 {
            return Some(i);
        }
        if chars.get(i) != Some(&'.') {
            return None;
        }
        i += 1;
    }
    None
}

/// `<key>: <value>` 또는 `<key>=<value>` 패턴 안 value 마스킹. key 이름 대소문자 무관.
fn redact_key_value_pair(s: &str, keys: &[&str]) -> String {
    let mut out = s.to_string();
    for key in keys {
        out = mask_key_value(&out, key);
    }
    out
}

fn mask_key_value(s: &str, key: &str) -> String {
    let lower = s.to_lowercase();
    let key_lower = key.to_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    let bytes = s.as_bytes();
    while cursor < bytes.len() {
        if let Some(rel) = lower[cursor..].find(&key_lower) {
            let key_start = cursor + rel;
            let key_end = key_start + key.len();
            // 키 이전 char — 단어 경계 (alnum / _- 아님) 확인. start 인 경우 OK.
            if key_start > 0 {
                let prev = bytes[key_start - 1];
                if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'-' {
                    out.push_str(&s[cursor..key_end]);
                    cursor = key_end;
                    continue;
                }
            }
            // 키 이후 close-quote (`"` / `'`) 가 올 수 있음 — JSON 안 `"apikey":"value"` 형식 호환.
            // 옛 mask_key_value 안 close-quote skip 0 → JSON 매칭 fail → api-key 노출 사고.
            let mut after = key_end;
            if after < bytes.len() && (bytes[after] == b'"' || bytes[after] == b'\'') {
                after += 1;
            }
            // separator 매칭 2 영역:
            //   case (a) `: ` / `=` separator + 일반 value (quoted 또는 word boundary)
            //   case (b) 공백 + quoted value (`API-KEY 'dddd' is invalid` 형식)
            // case (b) 는 공백 다음 quote 가 있어야 매칭 — 자연어 "api-key is required" 의 false
            // positive 차단 (다음 char = word 면 case (b) 가 아님).
            let mut sep_kind: Option<u8> = None; // b':' / b'=' = case (a), b'\'' / b'"' = case (b)
            // 공백 skip 후 separator / quote 확인.
            let mut probe = after;
            while probe < bytes.len() && (bytes[probe] == b' ' || bytes[probe] == b'\t') {
                probe += 1;
            }
            if probe < bytes.len() && (bytes[probe] == b':' || bytes[probe] == b'=') {
                sep_kind = Some(bytes[probe]);
                after = probe + 1;
            } else if probe > after && probe < bytes.len() && (bytes[probe] == b'"' || bytes[probe] == b'\'') {
                // case (b) — key 직후 1+ 공백 + quoted value
                sep_kind = Some(bytes[probe]);
                after = probe;
            }
            let Some(sk) = sep_kind else {
                out.push_str(&s[cursor..key_end]);
                cursor = key_end;
                continue;
            };
            // case (a) 안 공백 skip + value 추출. case (b) 안 already at quote.
            if sk == b':' || sk == b'=' {
                while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
                    after += 1;
                }
            }
            // value 시작. quote 우선 매칭.
            let quote = if after < bytes.len() && (bytes[after] == b'"' || bytes[after] == b'\'') {
                Some(bytes[after])
            } else {
                None
            };
            let mut value_start = after;
            if let Some(_q) = quote {
                value_start = after + 1;
            }
            let mut value_end = value_start;
            if let Some(q) = quote {
                while value_end < bytes.len() && bytes[value_end] != q {
                    value_end += 1;
                }
            } else {
                while value_end < bytes.len()
                    && !matches!(bytes[value_end], b',' | b' ' | b'\n' | b'\r' | b'\t' | b'"' | b'\'' | b'}' | b']' | b';')
                {
                    value_end += 1;
                }
            }
            // 마스킹 적용.
            out.push_str(&s[cursor..after]);
            if let Some(q) = quote {
                out.push(q as char);
            }
            out.push_str(MASK);
            if let Some(q) = quote {
                out.push(q as char);
                cursor = value_end + 1;
            } else {
                cursor = value_end;
            }
        } else {
            out.push_str(&s[cursor..]);
            break;
        }
    }
    out
}

/// JSON Value 안 모든 string 재귀 redact. 객체 안 sensitive key 이름 (`token` / `password`
/// / `secret` / `api_key` / `authorization` / `bearer` / `credential` / `access_token` /
/// `refresh_token` / `private_key` / `client_secret` / `session_id` / `cookie` / `vault`)
/// 의 value 는 통째 마스킹.
/// 외부 tool 결과·입력용 — 객체 키 이름이 시크릿 패턴이면 value 통째 마스킹(api-key 등 비표준 포맷
/// 시크릿도 키 이름으로 잡기 위함).
pub fn redact_value(val: &Value) -> Value {
    redact_value_inner(val, 0, true)
}

/// AI 가 만든 렌더 콘텐츠용(blocks/suggestions/pending) — 키 이름 마스킹은 하지 않는다. 콘텐츠
/// 필드명('tokens' = sentence S/V/O 청크 등)이 시크릿 needle 과 부분일치해 멀쩡한 콘텐츠를 통째
/// 마스킹하던 false-positive 차단. string '값'은 그대로 패턴(sk-*/JWT/Bearer/Telegram 등)으로
/// 마스킹 → 진짜 시크릿이 콘텐츠에 섞여 흘러도 키 이름이 아니라 값으로 잡힌다.
pub fn redact_value_content(val: &Value) -> Value {
    redact_value_inner(val, 0, false)
}

fn redact_value_inner(val: &Value, depth: u32, mask_keys: bool) -> Value {
    const MAX_DEPTH: u32 = 16;
    if depth > MAX_DEPTH {
        return Value::String("[max depth]".to_string());
    }
    match val {
        Value::Null | Value::Bool(_) | Value::Number(_) => val.clone(),
        Value::String(s) => Value::String(redact_string(s)),
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| redact_value_inner(v, depth + 1, mask_keys))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if mask_keys && is_sensitive_key(k) {
                    out.insert(k.clone(), Value::String(MASK.to_string()));
                } else {
                    out.insert(k.clone(), redact_value_inner(v, depth + 1, mask_keys));
                }
            }
            Value::Object(out)
        }
    }
}

fn is_sensitive_key(k: &str) -> bool {
    let lower = k.to_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "api-key",
        "api_key",
        "apikey",
        "authorization",
        "bearer",
        "credential",
        "access-token",
        "access_token",
        "refresh-token",
        "refresh_token",
        "private-key",
        "private_key",
        "client-secret",
        "client_secret",
        "session-id",
        "session_id",
        "cookie",
        "vault",
        "x-signature",
        "x-api-key",
        "x-customer",
        "access-license",
        "access_license",
    ]
    .iter()
    // strict 부분일치 — tool 결과/입력(외부 API 데이터)에만 쓴다. AI 렌더 콘텐츠엔
    // redact_value_content(키 이름 마스킹 안 함)를 써서 'tokens' 같은 콘텐츠 필드 false-positive 회피.
    .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sk_token() {
        let s = "key: sk-abc123def456ghi789jkl012";
        let out = redact_string(s);
        assert!(out.contains(MASK), "out: {out}");
        assert!(!out.contains("sk-abc"));
    }

    #[test]
    fn redacts_anthropic_token() {
        let s = "Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl";
        let out = redact_string(s);
        assert!(out.contains(MASK));
    }

    #[test]
    fn redacts_aiza_key() {
        let s = "key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123";
        let out = redact_string(s);
        assert!(out.contains(MASK));
    }

    #[test]
    fn redacts_naver_api_key() {
        let s = "Auth failed with api-key: 01000000008ffb2ac36d312efb45034eef102c81cea022481da83f43e0775e309b852fbf1a, customer-id: -1";
        let out = redact_string(s);
        assert!(out.contains("api-key: [REDACTED]"), "out: {out}");
        assert!(out.contains("customer-id: [REDACTED]"), "out: {out}");
        assert!(!out.contains("01000000"));
    }

    #[test]
    fn redacts_json_apikey() {
        // 사용자 보고 케이스 — `"apikey":"dddd"` JSON 형식. key 뒤 close-quote skip 이 되어야 매칭.
        let s = r#"{"apikey":"dddd","status":403,"detail":"API-KEY 'dddd' is invalid."}"#;
        let out = redact_string(s);
        assert!(!out.contains("\"dddd\""), "out: {out}");
        assert!(out.contains("[REDACTED]"), "out: {out}");
    }

    #[test]
    fn redacts_space_quoted_value() {
        // `API-KEY 'dddd' is invalid` — separator 0 + 공백 + quoted value 형식.
        let s = "API-KEY 'dddd' is invalid.";
        let out = redact_string(s);
        assert!(!out.contains("'dddd'"), "out: {out}");
        assert!(out.contains("[REDACTED]"), "out: {out}");
    }

    #[test]
    fn does_not_redact_natural_language() {
        // 자연어 안 `api-key is required` — 공백 + word (quote 0). false positive 차단.
        let s = "api-key is required";
        let out = redact_string(s);
        assert!(out.contains("required"), "out: {out}");
        assert!(!out.contains("[REDACTED]"), "out: {out}");
    }

    #[test]
    fn redacts_jwt() {
        let s = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk";
        let out = redact_string(s);
        assert!(out.contains(MASK));
    }

    #[test]
    fn redacts_telegram_bot_token() {
        let s = "https://api.telegram.org/bot123456789:AAH-AbCdEfGhIjKlMnOpQrStUvWxYz012345/sendMessage";
        let out = redact_string(s);
        assert!(out.contains(MASK), "out: {out}");
    }

    #[test]
    fn preserves_short_normal_text() {
        let s = "short text without secrets";
        assert_eq!(redact_string(s), s);
    }

    #[test]
    fn redact_value_recurses_object() {
        let val = json!({
            "error": "Auth failed with api-key: sk-abc123def456ghi789jkl012",
            "nested": {
                "token": "fbat_1234567890abcdef1234567890abcdef",
                "ok": true
            }
        });
        let out = redact_value(&val);
        let s = out["error"].as_str().unwrap();
        assert!(s.contains(MASK));
        // sensitive key name 안 value 통째 mask
        assert_eq!(out["nested"]["token"].as_str().unwrap(), MASK);
        assert_eq!(out["nested"]["ok"].as_bool().unwrap(), true);
    }

    #[test]
    fn redact_value_handles_array() {
        let val = json!(["normal", "api-key: sk-abc123def456ghi789jkl012"]);
        let out = redact_value(&val);
        assert_eq!(out[0].as_str().unwrap(), "normal");
        assert!(out[1].as_str().unwrap().contains(MASK));
    }
}
