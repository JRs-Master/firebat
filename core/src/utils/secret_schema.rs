//! 모듈 config.json 의 `secrets` 배열 parse — string | object union 일반화.
//!
//! MODULE_BIBLE 제4장. 옛 형태 (`"secrets": ["KEY1", "KEY2"]`) 는 type=Key 로 자동 매핑.
//! 새 형태 (`"secrets": [{name, type, lifetimeSec?, refreshFrom?}]`) 는 메타 그대로 보존.
//! sandbox env 주입 / mcp 도구 description / secret scanner 등 모든 site 본 helper 통과.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    /// 사용자 직접 입력 (API key / client secret / static token) — 만료 X. 어드민 UI 입력 필드 노출.
    Key,
    /// 자동 발급 (OAuth access/refresh · API token cache) — 사용자 입력 영역 X. 어드민 UI 숨김.
    Token,
}

impl Default for SecretKind {
    fn default() -> Self { SecretKind::Key }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretMeta {
    pub name: String,
    #[serde(default)]
    pub kind: SecretKind,
    /// 만료 (초) — token 만 의미. 자동 갱신 cron trigger 시점 결정.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime_sec: Option<u64>,
    /// refresh_token vault 키 — access 만료 시 본 키로 갱신.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_from: Option<String>,
}

impl SecretMeta {
    pub fn key(name: impl Into<String>) -> Self {
        Self { name: name.into(), kind: SecretKind::Key, lifetime_sec: None, refresh_from: None }
    }
}

/// `secrets` 배열 (json) → SecretMeta 벡터. 비-배열 / 누락 시 빈 벡터.
///
/// - string entry → `{name, kind=Key}` 매핑 (옛 호환)
/// - object entry → `name` 필수 + `type` (snake_case "key"|"token") + `lifetimeSec` + `refreshFrom`
/// - 그 외 형태 entry → skip (silent)
pub fn parse_secrets(value: &serde_json::Value) -> Vec<SecretMeta> {
    let Some(arr) = value.get("secrets").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter().filter_map(parse_entry).collect()
}

fn parse_entry(entry: &serde_json::Value) -> Option<SecretMeta> {
    if let Some(name) = entry.as_str() {
        return Some(SecretMeta::key(name));
    }
    let obj = entry.as_object()?;
    let name = obj.get("name").and_then(|v| v.as_str())?.to_string();
    let kind = match obj.get("type").and_then(|v| v.as_str()) {
        Some("token") => SecretKind::Token,
        _ => SecretKind::Key,
    };
    let lifetime_sec = obj.get("lifetimeSec").and_then(|v| v.as_u64());
    let refresh_from = obj.get("refreshFrom").and_then(|v| v.as_str()).map(String::from);
    Some(SecretMeta { name, kind, lifetime_sec, refresh_from })
}

/// 편의: name 만 추출 (description note · scanner 등 메타 불요 site).
pub fn secret_names(value: &serde_json::Value) -> Vec<String> {
    parse_secrets(value).into_iter().map(|m| m.name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_legacy_string_array() {
        let v = json!({"secrets": ["A", "B"]});
        let parsed = parse_secrets(&v);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "A");
        assert_eq!(parsed[0].kind, SecretKind::Key);
        assert!(parsed[0].lifetime_sec.is_none());
    }

    #[test]
    fn parses_object_form_with_type_and_lifetime() {
        let v = json!({"secrets": [
            {"name": "K", "type": "key"},
            {"name": "T", "type": "token", "lifetimeSec": 3600, "refreshFrom": "R"}
        ]});
        let parsed = parse_secrets(&v);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].kind, SecretKind::Key);
        assert_eq!(parsed[1].kind, SecretKind::Token);
        assert_eq!(parsed[1].lifetime_sec, Some(3600));
        assert_eq!(parsed[1].refresh_from.as_deref(), Some("R"));
    }

    #[test]
    fn mixes_string_and_object_entries() {
        let v = json!({"secrets": ["A", {"name": "T", "type": "token"}]});
        let parsed = parse_secrets(&v);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].kind, SecretKind::Key);
        assert_eq!(parsed[1].kind, SecretKind::Token);
    }

    #[test]
    fn skips_malformed_entries() {
        let v = json!({"secrets": [123, true, {"type": "key"}, "OK"]});
        let parsed = parse_secrets(&v);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "OK");
    }

    #[test]
    fn returns_empty_when_missing() {
        let v = json!({});
        assert!(parse_secrets(&v).is_empty());
    }

    #[test]
    fn secret_names_helper_extracts_names_only() {
        let v = json!({"secrets": ["A", {"name": "B", "type": "token"}]});
        assert_eq!(secret_names(&v), vec!["A".to_string(), "B".to_string()]);
    }
}
