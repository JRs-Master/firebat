//! AuthManager — 통합 인증 / 토큰 관리.
//!
//! 옛 TS AuthManager (`core/managers/auth-manager.ts`) Rust 재구현.
//!
//! 책임:
//!  - 로그인 / 로그아웃 (세션 토큰, 24h 만료)
//!  - API 토큰 생성 / 검증 / 폐기 (MCP 등 외부, 만료 없음)
//!  - 관리자 자격증명 (Vault + env fallback)
//!  - Brute force 방지 (IP·계정 조합 5회 실패 시 60초 lock)
//!  - timing-safe 비교 (timing attack 방어)

use rand::RngCore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

use crate::ports::{AuthSession, IAuthPort, IVaultPort, SessionRole, SessionType};
use crate::vault_keys::{VK_ADMIN_ID, VK_ADMIN_PASSWORD};

/// 세션 토큰 유효기간 — 24시간.
const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Brute force 한도 — N회 실패 시 lock.
const LOGIN_FAIL_LIMIT: u32 = 5;
const LOGIN_LOCK_MS: i64 = 60 * 1000;
const LOGIN_FAIL_DECAY_MS: i64 = 10 * 60 * 1000;
/// `lastUsedAt` throttle — 1분 이내 재갱신 스킵 (Vault write 비용 회피).
const LAST_USED_THROTTLE_MS: i64 = 60_000;

/// 관리자 자격증명 default — Vault / env 둘 다 미설정 시. 운영 시 사용자가 변경 권장.
const DEFAULT_ADMIN_ID: &str = "admin";
const DEFAULT_ADMIN_PASSWORD: &str = "admin";

/// Login 결과.
#[derive(Debug)]
pub enum LoginOutcome {
    Ok(AuthSession),
    InvalidCredentials,
    /// 잠김 — caller 가 429 응답으로 변환. retry_after_sec 후 재시도 가능.
    Locked { retry_after_sec: i64 },
}

#[derive(Debug, Clone)]
struct LoginAttemptState {
    fail_count: u32,
    locked_until: i64,
    last_attempt_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApiTokenInfo {
    pub exists: bool,
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: Option<String>,    // ISO 8601
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,  // ISO 8601 — 미사용이면 None
}

pub struct AuthManager {
    auth: Arc<dyn IAuthPort>,
    vault: Arc<dyn IVaultPort>,
    /// 메모리 — restart 시 reset (영속 X). 1인 운영 OK.
    login_attempts: Mutex<HashMap<String, LoginAttemptState>>,
}

impl AuthManager {
    pub fn new(auth: Arc<dyn IAuthPort>, vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            auth,
            vault,
            login_attempts: Mutex::new(HashMap::new()),
        }
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// `fbat_` + 32자 hex (16 byte random).
    fn generate_token(prefix: &str) -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        format!("{}{}", prefix, hex)
    }

    /// timing-safe 문자열 비교 — id / password 비교 시 timing attack 방어.
    /// 길이 자체가 누설일 수 있어 length 검사도 hidden.
    fn timing_safe_eq(a: &str, b: &str) -> bool {
        // 길이 mismatch 도 일정 시간 비교 — pad 후 ct_eq
        let max = a.len().max(b.len()).max(1);
        let mut ab = a.as_bytes().to_vec();
        let mut bb = b.as_bytes().to_vec();
        ab.resize(max, 0);
        bb.resize(max, 0);
        let eq_pad = ab.ct_eq(&bb).unwrap_u8() == 1;
        let eq_len = a.len() == b.len();
        eq_pad && eq_len
    }

    fn unix_ms_to_iso(ms: i64) -> String {
        // chrono 미의존 — 단순 ISO format. UTC 기준.
        // 추후 chrono 도입 시 교체. Phase B 초기에 의존성 최소화.
        let secs = ms / 1000;
        let millis = (ms % 1000).abs();
        // 단순 epoch + sec → struct (libc time_t mock 대신 humantime crate 검토 가능)
        // 여기선 Date.now() like 단순 표현 — 정밀 ISO 는 chrono 도입 후
        format!("epoch_ms={ms}.{millis:03}_secs={secs}")
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  로그인 / 로그아웃 (세션 토큰)
    // ══════════════════════════════════════════════════════════════════════════

    /// 자격증명 검증 후 세션 토큰 발급. 5회 실패 시 60초 lock.
    pub fn login(&self, id: &str, password: &str, attempt_key: &str) -> LoginOutcome {
        let now = Self::now_ms();
        let attempt_key = if attempt_key.is_empty() {
            "global"
        } else {
            attempt_key
        };
        let mut attempts = match self.login_attempts.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let state = attempts.get(attempt_key).cloned();

        // 잠금 상태 체크
        if let Some(s) = &state {
            if s.locked_until > now {
                let retry_after_sec = ((s.locked_until - now) + 999) / 1000;
                return LoginOutcome::Locked { retry_after_sec };
            }
        }
        // decay — 일정 시간 무행동 시 카운터 reset
        let mut current = state.unwrap_or(LoginAttemptState {
            fail_count: 0,
            locked_until: 0,
            last_attempt_at: now,
        });
        if now - current.last_attempt_at > LOGIN_FAIL_DECAY_MS {
            current.fail_count = 0;
            current.locked_until = 0;
        }

        let creds = self.get_admin_credentials();
        let id_match = Self::timing_safe_eq(id, &creds.0);
        let pw_match = Self::timing_safe_eq(password, &creds.1);
        let ok = id_match && pw_match;

        if ok {
            // 성공 시 카운터 reset
            attempts.remove(attempt_key);
            drop(attempts);
            return LoginOutcome::Ok(self.create_session(SessionRole::Admin));
        }

        // 실패 — 카운터 증가
        current.fail_count += 1;
        current.last_attempt_at = now;
        if current.fail_count >= LOGIN_FAIL_LIMIT {
            current.locked_until = now + LOGIN_LOCK_MS;
            current.fail_count = 0; // lock 시작 시 reset → 잠금 해제 후 다시 5회 시도 가능
        }
        let now_locked_until = current.locked_until;
        attempts.insert(attempt_key.to_string(), current);
        drop(attempts);

        if now_locked_until > now {
            let retry_after_sec = ((now_locked_until - now) + 999) / 1000;
            LoginOutcome::Locked { retry_after_sec }
        } else {
            LoginOutcome::InvalidCredentials
        }
    }

    pub fn validate_session(&self, token: &str) -> Option<AuthSession> {
        if token.is_empty() {
            return None;
        }
        let session = self.auth.get_session(token)?;
        if session.session_type != SessionType::Session {
            return None;
        }
        self.touch_last_used(&session);
        Some(session)
    }

    pub fn logout(&self, token: &str) -> bool {
        self.auth.delete_session(token)
    }

    /// 만료된 세션 일괄 정리 — list_sessions 가 lazy sweep.
    pub fn sweep_expired_sessions(&self) -> (usize, usize) {
        let sessions = self.auth.list_sessions(SessionType::Session).len();
        let api = self.auth.list_sessions(SessionType::Api).len();
        (sessions, api)
    }

    fn touch_last_used(&self, session: &AuthSession) {
        let now = Self::now_ms();
        let last = session.last_used_at.unwrap_or(0);
        if now - last < LAST_USED_THROTTLE_MS {
            return;
        }
        let mut updated = session.clone();
        updated.last_used_at = Some(now);
        self.auth.save_session(&updated);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  API 토큰
    // ══════════════════════════════════════════════════════════════════════════

    /// 새 API 토큰 발급 — 기존 API 토큰 전부 폐기 후 새로. 원본 1회 반환.
    pub fn generate_api_token(&self, label: Option<&str>) -> String {
        self.auth.delete_sessions(SessionType::Api);

        let token = Self::generate_token("fbat_");
        let session = AuthSession {
            token: token.clone(),
            session_type: SessionType::Api,
            role: SessionRole::Admin,
            created_at: Self::now_ms(),
            expires_at: None, // 영구
            last_used_at: None,
            label: Some(label.unwrap_or("MCP API").to_string()),
        };
        self.auth.save_session(&session);
        token
    }

    pub fn validate_api_token(&self, token: &str) -> Option<AuthSession> {
        if token.is_empty() {
            return None;
        }
        let session = self.auth.get_session(token)?;
        if session.session_type != SessionType::Api {
            return None;
        }
        self.touch_last_used(&session);
        Some(session)
    }

    pub fn revoke_api_tokens(&self) -> usize {
        self.auth.delete_sessions(SessionType::Api)
    }

    pub fn get_api_token_info(&self) -> ApiTokenInfo {
        let sessions = self.auth.list_sessions(SessionType::Api);
        if sessions.is_empty() {
            return ApiTokenInfo {
                exists: false,
                hint: None,
                label: None,
                created_at: None,
                last_used_at: None,
            };
        }
        let s = &sessions[0];
        let hint = if s.token.len() > 12 {
            Some(format!("{}****{}", &s.token[..8], &s.token[s.token.len() - 4..]))
        } else {
            Some("****".to_string())
        };
        ApiTokenInfo {
            exists: true,
            hint,
            label: s.label.clone(),
            created_at: Some(Self::unix_ms_to_iso(s.created_at)),
            last_used_at: s.last_used_at.map(Self::unix_ms_to_iso),
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  통합 토큰 검증
    // ══════════════════════════════════════════════════════════════════════════

    pub fn validate_token(&self, token: &str) -> Option<AuthSession> {
        if token.is_empty() {
            return None;
        }
        self.auth.get_session(token)
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  관리자 자격증명
    // ══════════════════════════════════════════════════════════════════════════

    /// (id, password) — Vault 저장값 → env → default 순.
    pub fn get_admin_credentials(&self) -> (String, String) {
        let id = self
            .vault
            .get_secret(VK_ADMIN_ID)
            .or_else(|| std::env::var("FIREBAT_ADMIN_ID").ok())
            .unwrap_or_else(|| DEFAULT_ADMIN_ID.to_string());
        let password = self
            .vault
            .get_secret(VK_ADMIN_PASSWORD)
            .or_else(|| std::env::var("FIREBAT_ADMIN_PASSWORD").ok())
            .unwrap_or_else(|| DEFAULT_ADMIN_PASSWORD.to_string());
        (id, password)
    }

    pub fn set_admin_credentials(&self, new_id: Option<&str>, new_password: Option<&str>) {
        if let Some(id) = new_id {
            self.vault.set_secret(VK_ADMIN_ID, id);
        }
        if let Some(pw) = new_password {
            self.vault.set_secret(VK_ADMIN_PASSWORD, pw);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Private
    // ══════════════════════════════════════════════════════════════════════════

    fn create_session(&self, role: SessionRole) -> AuthSession {
        let token = Self::generate_token("fbat_");
        let now = Self::now_ms();
        let session = AuthSession {
            token: token.clone(),
            session_type: SessionType::Session,
            role,
            created_at: now,
            expires_at: Some(now + SESSION_TTL_MS),
            last_used_at: None,
            label: None,
        };
        self.auth.save_session(&session);
        session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{auth::VaultAuthAdapter, vault::SqliteVaultAdapter};

    fn make_manager() -> AuthManager {
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
        AuthManager::new(auth, vault)
    }

    #[test]
    fn login_with_default_credentials_succeeds() {
        let mgr = make_manager();
        let result = mgr.login("admin", "admin", "test-ip");
        match result {
            LoginOutcome::Ok(session) => {
                assert_eq!(session.session_type, SessionType::Session);
                assert!(session.token.starts_with("fbat_"));
                assert!(session.expires_at.is_some());
            }
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn login_with_wrong_password_fails() {
        let mgr = make_manager();
        let result = mgr.login("admin", "wrong", "test-ip");
        assert!(matches!(result, LoginOutcome::InvalidCredentials));
    }

    #[test]
    fn login_locked_after_5_failures() {
        let mgr = make_manager();
        // 4번 실패 — InvalidCredentials
        for _ in 0..4 {
            assert!(matches!(
                mgr.login("admin", "wrong", "ip-lock-test"),
                LoginOutcome::InvalidCredentials
            ));
        }
        // 5번째 실패 — Locked
        let result = mgr.login("admin", "wrong", "ip-lock-test");
        match result {
            LoginOutcome::Locked { retry_after_sec } => {
                assert!(retry_after_sec > 0 && retry_after_sec <= 60);
            }
            _ => panic!("expected Locked"),
        }
        // 잠금 중 — 정확한 비밀번호도 거부
        assert!(matches!(
            mgr.login("admin", "admin", "ip-lock-test"),
            LoginOutcome::Locked { .. }
        ));
        // 다른 attempt_key 는 영향 없음
        assert!(matches!(
            mgr.login("admin", "admin", "different-ip"),
            LoginOutcome::Ok(_)
        ));
    }

    #[test]
    fn validate_session_returns_session_for_valid_token() {
        let mgr = make_manager();
        let LoginOutcome::Ok(session) = mgr.login("admin", "admin", "ip") else {
            panic!("login failed");
        };
        let validated = mgr.validate_session(&session.token).unwrap();
        assert_eq!(validated.token, session.token);
    }

    #[test]
    fn validate_session_rejects_api_token() {
        let mgr = make_manager();
        let api_token = mgr.generate_api_token(None);
        // api 토큰을 session 으로 검증 시 None
        assert!(mgr.validate_session(&api_token).is_none());
        // api 검증 path 로는 OK
        assert!(mgr.validate_api_token(&api_token).is_some());
    }

    #[test]
    fn logout_removes_session() {
        let mgr = make_manager();
        let LoginOutcome::Ok(session) = mgr.login("admin", "admin", "ip") else {
            panic!();
        };
        assert!(mgr.logout(&session.token));
        assert!(mgr.validate_session(&session.token).is_none());
    }

    #[test]
    fn api_token_lifecycle() {
        let mgr = make_manager();
        // 처음엔 토큰 없음
        let info = mgr.get_api_token_info();
        assert!(!info.exists);

        // 발급
        let token = mgr.generate_api_token(Some("MCP for Claude"));
        assert!(token.starts_with("fbat_"));
        assert_eq!(token.len(), 5 + 32); // "fbat_" + 32 hex

        // info 확인
        let info = mgr.get_api_token_info();
        assert!(info.exists);
        assert!(info.hint.unwrap().contains("****"));
        assert_eq!(info.label, Some("MCP for Claude".to_string()));

        // 검증
        assert!(mgr.validate_api_token(&token).is_some());

        // 새 토큰 발급 시 옛 토큰 폐기
        let new_token = mgr.generate_api_token(Some("Renewed"));
        assert_ne!(token, new_token);
        assert!(mgr.validate_api_token(&token).is_none());
        assert!(mgr.validate_api_token(&new_token).is_some());

        // 폐기
        let count = mgr.revoke_api_tokens();
        assert_eq!(count, 1);
        assert!(mgr.validate_api_token(&new_token).is_none());
    }

    #[test]
    fn admin_credentials_can_be_changed() {
        let mgr = make_manager();
        // default 로 로그인 OK
        assert!(matches!(mgr.login("admin", "admin", "ip"), LoginOutcome::Ok(_)));

        // 자격증명 변경
        mgr.set_admin_credentials(Some("new-admin"), Some("new-pw"));

        // 옛 자격증명 거부
        assert!(matches!(
            mgr.login("admin", "admin", "ip2"),
            LoginOutcome::InvalidCredentials
        ));
        // 새 자격증명 OK
        assert!(matches!(
            mgr.login("new-admin", "new-pw", "ip3"),
            LoginOutcome::Ok(_)
        ));
    }

    #[test]
    fn timing_safe_eq_basic() {
        assert!(AuthManager::timing_safe_eq("abc", "abc"));
        assert!(!AuthManager::timing_safe_eq("abc", "abd"));
        assert!(!AuthManager::timing_safe_eq("abc", "abcd"));
        assert!(!AuthManager::timing_safe_eq("", "x"));
        assert!(AuthManager::timing_safe_eq("", ""));
    }

    #[test]
    fn token_format_fbat_prefix_32hex() {
        let token = AuthManager::generate_token("fbat_");
        assert!(token.starts_with("fbat_"));
        assert_eq!(token.len(), 5 + 32);
        // hex only
        assert!(token[5..].chars().all(|c| c.is_ascii_hexdigit()));
    }
}
