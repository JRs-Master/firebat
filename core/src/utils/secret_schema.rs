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
    /// OAuth 자동 발급 스펙 — 인프라 TokenProvider 가 본 메타로 토큰 발급·갱신 (token kind 만).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthSpec>,
}

impl SecretMeta {
    pub fn key(name: impl Into<String>) -> Self {
        Self { name: name.into(), kind: SecretKind::Key, lifetime_sec: None, refresh_from: None, oauth: None }
    }
}

/// OAuth 토큰 발급 스펙 — config.json 의 token secret 안 `oauth` 블록. 인프라 TokenProvider 가
/// 본 데이터로 발급(client_credentials)·갱신한다. per-module 차이를 전부 데이터로 흡수 (하드코딩 0).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSpec {
    /// 실전 base URL (scheme+host[:port]) — path 가 append 된다.
    pub base: String,
    /// 모의투자 base URL — data.mock=true 시 사용.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_mock: Option<String>,
    /// 토큰 발급 경로 (base 에 append).
    pub path: String,
    #[serde(default = "default_post")]
    pub method: String,
    #[serde(default = "default_json_ct")]
    pub content_type: String,
    /// 요청 body — 값에 `${SECRET_NAME}` placeholder 가능 (다른 key secret 참조, vault 에서 치환).
    pub body: serde_json::Map<String, serde_json::Value>,
    /// 응답 JSON 에서 토큰을 꺼낼 필드명 (예: access_token / token).
    pub token_field: String,
    /// (옵션) refresh_token grant 에서 회전된 refresh_token 을 응답에서 꺼낼 필드 (예: kakao 의 refresh_token).
    /// 함께 `refresh_token_secret` 이 있으면, 발급 시 그 값을 vault 에 영속한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token_field: Option<String>,
    /// (옵션) 회전된 refresh_token 을 영속할 vault secret 이름 (`user:{name}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token_secret: Option<String>,
    /// 응답이 "토큰 무효" 임을 판정하는 규칙 — reactive 재발급 trigger. 없으면 reactive 안 함.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalid_when: Option<InvalidWhen>,
}

/// 토큰 무효 판정 — conditions 를 match(all/any) 로 결합.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidWhen {
    #[serde(rename = "match")]
    pub match_mode: MatchMode,
    pub conditions: Vec<InvalidCondition>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    All,
    Any,
}

/// 단일 조건 — 응답 data 의 `field` 값이 `equals` 와 같거나(타입 무관) `regex` 에 매치하면 참.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InvalidCondition {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
}

fn default_post() -> String {
    "POST".to_string()
}
fn default_json_ct() -> String {
    "application/json".to_string()
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
    // oauth 블록 — malformed 면 None 으로 degrade (secret 자체는 보존. 토큰 typo 가 API 키 secret 을 증발시키면 안 됨).
    let oauth = match obj.get("oauth") {
        None => None,
        Some(raw) => match serde_json::from_value::<OAuthSpec>(raw.clone()) {
            Ok(spec) => Some(spec),
            Err(e) => {
                tracing::warn!(target: "secret", secret = %name, error = %e, "oauth spec parse failed — token auto-issue disabled");
                None
            }
        },
    };
    Some(SecretMeta { name, kind, lifetime_sec, refresh_from, oauth })
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

    #[test]
    fn parses_oauth_block() {
        let v = json!({"secrets": [{
            "name": "TOK", "type": "token", "lifetimeSec": 85800,
            "oauth": {
                "base": "https://x", "baseMock": "https://y", "path": "/oauth2/token",
                "body": {"grant_type": "client_credentials", "appkey": "${K}"},
                "tokenField": "access_token",
                "invalidWhen": {"match": "all", "conditions": [
                    {"field": "rt_cd", "equals": "1"}, {"field": "msg1", "regex": "token"}]}
            }
        }]});
        let parsed = parse_secrets(&v);
        let o = parsed[0].oauth.as_ref().unwrap();
        assert_eq!(o.path, "/oauth2/token");
        assert_eq!(o.method, "POST"); // default 적용
        assert_eq!(o.content_type, "application/json"); // default 적용
        assert_eq!(o.token_field, "access_token");
        assert_eq!(o.base_mock.as_deref(), Some("https://y"));
        let iw = o.invalid_when.as_ref().unwrap();
        assert_eq!(iw.match_mode, MatchMode::All);
        assert_eq!(iw.conditions.len(), 2);
        assert_eq!(iw.conditions[0].equals, Some(json!("1")));
        assert_eq!(iw.conditions[1].regex.as_deref(), Some("token"));
    }

    #[test]
    fn parses_oauth_equals_number() {
        // kiwoom: return_code 는 숫자 3. equals 가 serde_json::Value 라 숫자도 보존.
        let v = json!({"secrets": [{
            "name": "T", "type": "token",
            "oauth": {"base": "https://x", "path": "/t", "body": {}, "tokenField": "token",
                "invalidWhen": {"match": "any", "conditions": [{"field": "return_code", "equals": 3}]}}
        }]});
        let o = parse_secrets(&v)[0].oauth.clone().unwrap();
        assert_eq!(o.invalid_when.unwrap().conditions[0].equals, Some(json!(3)));
    }

    #[test]
    fn malformed_oauth_degrades_to_none_keeps_secret() {
        // oauth 필수 필드(path/body/tokenField) 누락 → oauth None, secret 은 보존.
        let v = json!({"secrets": [{"name": "TOK", "type": "token", "oauth": {"base": "https://x"}}]});
        let parsed = parse_secrets(&v);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "TOK");
        assert!(parsed[0].oauth.is_none());
    }
}
