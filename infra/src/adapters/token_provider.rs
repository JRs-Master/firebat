//! OAuthTokenProvider — 인프라 OAuth 토큰 발급·갱신 (config-declarative).
//!
//! sysmod 가 토큰 코드를 갖는 대신, config.json 의 token secret `oauth` 블록(OAuthSpec)을 인프라가
//! 읽어 발급(client_credentials)·TTL 선제 갱신(proactive)·무효 시 재발급(reactive)·Vault 영속을 처리한다.
//! `sandbox::run_once` 가 호출. vertex_gemini OAuth 패턴 + per-secret 락(동시 호출 herd 방지).
//!
//! 보안: 치환된 body·발급 토큰은 절대 로깅하지 않는다 (HTTP status·secret 이름만).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use firebat_core::ports::IVaultPort;
use firebat_core::utils::http_client::http_client;
use firebat_core::utils::secret_schema::{InvalidCondition, MatchMode, OAuthSpec};

/// 토큰 캐시 vault 값 — sysmod 와 byte-동일 포맷 `{t, iat}`. iat = epoch ms (JS `Date.now()` 호환)
/// 라 반쪽 마이그(인프라 일부 + sysmod 일부) 상태에서도 캐시가 상호 호환된다.
#[derive(Serialize, Deserialize)]
struct TokenCache {
    t: String,
    iat: u64,
}

pub struct OAuthTokenProvider {
    vault: Arc<dyn IVaultPort>,
    /// per-secret-name 락 — read-decide-fetch-persist 를 직렬화해 동시 호출 시 토큰 엔드포인트
    /// 중복 타격(thundering herd)을 막는다. 뒤따른 호출은 락 안에서 갱신된 캐시를 본다.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// serde_json::Value → 비교용 문자열 (String 은 따옴표 없이, 그 외는 to_string).
fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl OAuthTokenProvider {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn lock_for(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(name.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// 캐시 vault 키 — mock 은 별도 슬롯 (real/mock 토큰이 같은 슬롯을 덮어쓰지 않게).
    fn cache_key(name: &str, mock: bool) -> String {
        if mock {
            format!("user:{name}__mock")
        } else {
            format!("user:{name}")
        }
    }

    /// proactive. 캐시가 lifetime 안이면 그대로, 만료/없음/force 면 발급해 영속 후 raw 토큰 반환.
    /// 호출자(sandbox)는 반환된 raw 토큰을 env 에 주입한다. Err 는 호출자가 pass-through 판단한다
    /// (유효 캐시가 있으면 그걸로 진행, 없으면 호출 실패).
    pub async fn ensure_fresh(
        &self,
        name: &str,
        spec: &OAuthSpec,
        lifetime_sec: u64,
        mock: bool,
        force: bool,
    ) -> Result<String, String> {
        let lock = self.lock_for(name);
        let _guard = lock.lock().await;
        let key = Self::cache_key(name, mock);

        if !force {
            if let Some(raw) = self.vault.get_secret(&key) {
                if let Ok(c) = serde_json::from_str::<TokenCache>(&raw) {
                    if now_ms().saturating_sub(c.iat) < lifetime_sec.saturating_mul(1000) {
                        return Ok(c.t);
                    }
                }
                // non-JSON(옛 raw 형식) 또는 만료 → 아래에서 재발급
            }
        }

        let token = self.fetch_token(name, spec, mock).await?;
        let serialized = serde_json::to_string(&TokenCache {
            t: token.clone(),
            iat: now_ms(),
        })
        .map_err(|e| format!("token cache 직렬화 실패: {e}"))?;
        self.vault.set_secret(&key, &serialized);
        // 발급 이벤트만 기록 (토큰 값은 절대 X) — proactive/reactive 갱신 가시화 + 검증.
        tracing::info!(target: "token", secret = %name, mock, force, "OAuth 토큰 발급·갱신 + Vault 영속");
        Ok(token)
    }

    /// reactive — 응답 data 가 `spec.invalid_when` 규칙에 매치하면 "토큰 무효" 로 판정. 순수(no I/O).
    /// `data` = sysmod envelope 의 `data` 필드 (API 응답 필드 rt_cd/return_code/msg1 등이 spread 됨).
    pub fn is_invalid(&self, spec: &OAuthSpec, data: &serde_json::Value) -> bool {
        let Some(iw) = &spec.invalid_when else {
            return false;
        };
        match iw.match_mode {
            MatchMode::All => iw.conditions.iter().all(|c| Self::cond_matches(c, data)),
            MatchMode::Any => iw.conditions.iter().any(|c| Self::cond_matches(c, data)),
        }
    }

    fn cond_matches(c: &InvalidCondition, data: &serde_json::Value) -> bool {
        let Some(actual) = data.get(&c.field) else {
            return false;
        };
        // equals — 타입 무관 (number==number, string==string, number↔string 은 문자열화 비교).
        if let Some(exp) = &c.equals {
            if exp == actual || value_to_string(exp) == value_to_string(actual) {
                return true;
            }
        }
        // regex — actual 문자열화 후 test.
        if let Some(pat) = &c.regex {
            if let Ok(re) = regex::Regex::new(pat) {
                if re.is_match(&value_to_string(actual)) {
                    return true;
                }
            }
        }
        false
    }

    async fn fetch_token(
        &self,
        name: &str,
        spec: &OAuthSpec,
        mock: bool,
    ) -> Result<String, String> {
        let base = if mock {
            spec.base_mock
                .as_deref()
                .ok_or_else(|| format!("{name}: baseMock 미설정인데 mock 호출"))?
        } else {
            spec.base.as_str()
        };
        let url = format!("{base}{}", spec.path);
        let body = self.resolve_body(name, &spec.body);
        let method =
            reqwest::Method::from_bytes(spec.method.as_bytes()).unwrap_or(reqwest::Method::POST);

        let mut req = http_client()
            .request(method, url)
            .header("Content-Type", spec.content_type.as_str())
            .timeout(Duration::from_secs(10));
        if spec.content_type.contains("urlencoded") {
            let form: Vec<(String, String)> = body
                .iter()
                .map(|(k, v)| (k.clone(), value_to_string(v)))
                .collect();
            req = req.form(&form);
        } else {
            let payload = serde_json::to_string(&serde_json::Value::Object(body))
                .map_err(|e| format!("OAuth body 직렬화 실패: {e}"))?;
            req = req.body(payload);
        }

        let resp = req.send().await.map_err(|e| format!("OAuth 요청 실패: {e}"))?;
        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("OAuth 응답 파싱 실패: {e}"))?;
        if !status.is_success() {
            // body·토큰 로깅 금지 — status 만.
            return Err(format!("OAuth {name}: HTTP {}", status.as_u16()));
        }
        json.get(&spec.token_field)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| format!("OAuth {name}: 응답에 토큰 필드 '{}' 없음", spec.token_field))
    }

    /// body 의 `${VAR}` placeholder 를 vault `user:VAR` 로 치환. 미해결은 빈 문자열 + 이름만 warn
    /// (값·치환 결과는 절대 로깅 X).
    fn resolve_body(
        &self,
        name: &str,
        body: &serde_json::Map<String, serde_json::Value>,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut out = serde_json::Map::new();
        for (k, v) in body {
            let nv = match v.as_str() {
                Some(s) => serde_json::Value::String(self.substitute(name, s)),
                None => v.clone(),
            };
            out.insert(k.clone(), nv);
        }
        out
    }

    fn substitute(&self, name: &str, s: &str) -> String {
        use std::sync::OnceLock;
        static RE: OnceLock<regex::Regex> = OnceLock::new();
        let re = RE.get_or_init(|| regex::Regex::new(r"\$\{([A-Za-z0-9_]+)\}").unwrap());
        re.replace_all(s, |caps: &regex::Captures| {
            let var = &caps[1];
            match self.vault.get_secret(&format!("user:{var}")) {
                Some(val) => val,
                None => {
                    tracing::warn!(target: "secret", secret = %name, var = %var, "oauth body placeholder 미해결");
                    String::new()
                }
            }
        })
        .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use firebat_core::utils::secret_schema::{InvalidCondition, InvalidWhen, MatchMode, OAuthSpec};
    use serde_json::json;

    struct StubVault(HashMap<String, String>);
    impl IVaultPort for StubVault {
        fn get_secret(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
        fn set_secret(&self, _k: &str, _v: &str) -> bool {
            true
        }
        fn delete_secret(&self, _k: &str) -> bool {
            true
        }
        fn list_keys(&self) -> Vec<String> {
            vec![]
        }
        fn list_keys_by_prefix(&self, _p: &str) -> Vec<String> {
            vec![]
        }
    }

    fn provider(vault: HashMap<String, String>) -> OAuthTokenProvider {
        OAuthTokenProvider::new(Arc::new(StubVault(vault)))
    }

    fn spec(invalid_when: Option<InvalidWhen>) -> OAuthSpec {
        OAuthSpec {
            base: "https://x".into(),
            base_mock: None,
            path: "/t".into(),
            method: "POST".into(),
            content_type: "application/json".into(),
            body: serde_json::Map::new(),
            token_field: "token".into(),
            invalid_when,
        }
    }

    #[test]
    fn is_invalid_match_all_kis() {
        // korea-invest: rt_cd=="1" AND msg1 ~ token (둘 다여야 무효)
        let p = provider(HashMap::new());
        let s = spec(Some(InvalidWhen {
            match_mode: MatchMode::All,
            conditions: vec![
                InvalidCondition { field: "rt_cd".into(), equals: Some(json!("1")), regex: None },
                InvalidCondition { field: "msg1".into(), equals: None, regex: Some("token|토큰".into()) },
            ],
        }));
        assert!(p.is_invalid(&s, &json!({"rt_cd": "1", "msg1": "token invalid"})));
        // 하나만 → match=all 이라 false (TIME LIMIT 같은 비-토큰 오류는 재발급 안 함)
        assert!(!p.is_invalid(&s, &json!({"rt_cd": "1", "msg1": "TIME LIMIT 00:00 ~ 15:40"})));
        assert!(!p.is_invalid(&s, &json!({"rt_cd": "2", "msg1": "token x"})));
    }

    #[test]
    fn is_invalid_match_any_kiwoom_number() {
        // kiwoom: return_code==3(숫자) OR return_msg ~ regex
        let p = provider(HashMap::new());
        let s = spec(Some(InvalidWhen {
            match_mode: MatchMode::Any,
            conditions: vec![
                InvalidCondition { field: "return_code".into(), equals: Some(json!(3)), regex: None },
                InvalidCondition { field: "return_msg".into(), equals: None, regex: Some("token.*invalid".into()) },
            ],
        }));
        assert!(p.is_invalid(&s, &json!({"return_code": 3}))); // 숫자 매치
        assert!(p.is_invalid(&s, &json!({"return_code": 0, "return_msg": "token is invalid"})));
        assert!(!p.is_invalid(&s, &json!({"return_code": 0, "return_msg": "ok"})));
    }

    #[test]
    fn is_invalid_no_rule_false() {
        let p = provider(HashMap::new());
        assert!(!p.is_invalid(&spec(None), &json!({"rt_cd": "1"})));
    }

    #[test]
    fn substitute_resolves_placeholders_from_vault() {
        let mut v = HashMap::new();
        v.insert("user:KIS_APP_KEY".to_string(), "APPKEY123".to_string());
        let p = provider(v);
        assert_eq!(p.substitute("T", "${KIS_APP_KEY}"), "APPKEY123");
        assert_eq!(p.substitute("T", "literal"), "literal");
        assert_eq!(p.substitute("T", "${MISSING}"), ""); // 미해결 → 빈 문자열
    }

    #[test]
    fn cache_key_separates_mock() {
        assert_eq!(OAuthTokenProvider::cache_key("KIS", false), "user:KIS");
        assert_eq!(OAuthTokenProvider::cache_key("KIS", true), "user:KIS__mock");
    }
}
