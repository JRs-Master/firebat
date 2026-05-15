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

use argon2::password_hash::{rand_core::OsRng as Argon2Rng, PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use rand::RngCore;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;

/// 비밀번호를 argon2id 로 hash. 실패 시 빈 string (저장 차단).
fn hash_password(plain: &str) -> String {
    let salt = SaltString::generate(&mut Argon2Rng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|h| h.to_string())
        .unwrap_or_default()
}

/// hash 와 plain 비교. hash 가 argon2 형식 아니면 false (옛 plain 호환 차단).
fn verify_password(stored: &str, candidate: &str) -> bool {
    if !stored.starts_with("$argon2") {
        return false;
    }
    PasswordHash::new(stored)
        .ok()
        .and_then(|h| {
            Argon2::default()
                .verify_password(candidate.as_bytes(), &h)
                .ok()
        })
        .is_some()
}

use crate::ports::{
    AuthSession, IAuthPort, INotifierPort, IVaultPort, NotifyLevel, SessionRole, SessionType,
};
use crate::utils::time::{DAY_MS, MINUTE_MS};
use crate::vault_keys::{VK_ADMIN_ID, VK_ADMIN_PASSWORD};

/// 세션 토큰 유효기간 — 24시간.
const SESSION_TTL_MS: i64 = DAY_MS;
/// Brute force 한도 — N회 실패 시 lock.
const LOGIN_FAIL_LIMIT: u32 = 5;
const LOGIN_LOCK_MS: i64 = MINUTE_MS;
const LOGIN_FAIL_DECAY_MS: i64 = 10 * MINUTE_MS;
/// `lastUsedAt` throttle — 1분 이내 재갱신 스킵 (Vault write 비용 회피).
const LAST_USED_THROTTLE_MS: i64 = MINUTE_MS;

// admin/admin 디폴트 폴백 폐기 (2026-05-09) — 첫 부팅 setup wizard 패턴.
// Vault / env 둘 다 미설정 = `is_admin_setup()` false → frontend `/login` 이 setup form 토글.
// `login()` 은 vault 설정된 자격증명만 통과 (빈 string 비교는 항상 fail).

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
#[serde(rename_all = "camelCase")]
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
    /// 알림 채널 (옵션) — 설정되어 있으면 brute force lock 발생 시 즉시 noti 발송.
    /// 옵셔널이라 옛 호환 유지 (테스트 / Telegram 미설정 시 영향 0).
    notifier: Option<Arc<dyn INotifierPort>>,
}

impl AuthManager {
    pub fn new(auth: Arc<dyn IAuthPort>, vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            auth,
            vault,
            login_attempts: Mutex::new(HashMap::new()),
            notifier: None,
        }
    }

    /// 알림 채널 주입 — brute force lock 발생 시 즉시 notify(Critical) 호출.
    pub fn with_notifier(mut self, notifier: Arc<dyn INotifierPort>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    fn now_ms() -> i64 {
        crate::utils::time::now_ms()
    }

    /// 비밀번호 정책 단일 source — 8자 이상 + 4 카테고리 (대문자/소문자/숫자/특수)
    /// 중 3 이상. 컴플라이언스·NIST 절충 패턴.
    ///
    /// 추가 규칙:
    ///   - `forbidden_id` 가 설정되어 있으면 비번이 그것과 동일 (case-insensitive) 시 거부.
    ///
    /// frontend SetupWizard 의 `isPasswordValid` / `passwordStrength` 시각화 함수가
    /// 같은 정책을 미러링 (사용자가 입력 중 strength meter 노출). 정책 변경 시 양쪽 sync 필수.
    pub fn validate_password_policy(
        password: &str,
        forbidden_id: Option<&str>,
    ) -> Result<(), String> {
        if password.len() < 8 {
            return Err(crate::i18n::t("core.error.auth.password_too_short", None, &[]));
        }
        let mut categories = 0u8;
        if password.chars().any(|c| c.is_ascii_uppercase()) {
            categories += 1;
        }
        if password.chars().any(|c| c.is_ascii_lowercase()) {
            categories += 1;
        }
        if password.chars().any(|c| c.is_ascii_digit()) {
            categories += 1;
        }
        if password
            .chars()
            .any(|c| "!@#$%^&*()_+-=[]{};':\"\\|,.<>/?".contains(c))
        {
            categories += 1;
        }
        if categories < 3 {
            return Err(crate::i18n::t(
                "core.error.auth.password_policy_category",
                None,
                &[],
            ));
        }
        if let Some(id) = forbidden_id {
            if password.to_lowercase() == id.trim().to_lowercase() {
                return Err(crate::i18n::t(
                    "core.error.auth.password_same_as_id",
                    None,
                    &[],
                ));
            }
        }
        Ok(())
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
        // vault 미설정 (setup 전) = 모든 로그인 거부. 빈 자격증명으로 우회 방지.
        // ID 는 timing-safe 평문 비교 (식별자 — hash 불필요).
        // Password 는 argon2 verify (vault 에 hash 만 저장, 평문 X).
        let id_match = Self::timing_safe_eq(id, &creds.0);
        let pw_match = !creds.1.is_empty() && verify_password(&creds.1, password);
        let setup_done = !creds.0.is_empty() && !creds.1.is_empty();
        let ok = setup_done && id_match && pw_match;

        if ok {
            // 성공 시 카운터 reset
            attempts.remove(attempt_key);
            drop(attempts);
            return LoginOutcome::Ok(self.create_session(SessionRole::Admin));
        }

        // 실패 — 카운터 증가
        current.fail_count += 1;
        current.last_attempt_at = now;
        let just_locked = current.fail_count >= LOGIN_FAIL_LIMIT;
        if just_locked {
            current.locked_until = now + LOGIN_LOCK_MS;
            current.fail_count = 0; // lock 시작 시 reset → 잠금 해제 후 다시 5회 시도 가능
        }
        let now_locked_until = current.locked_until;
        attempts.insert(attempt_key.to_string(), current);
        drop(attempts);

        // brute force lock 발생 = Critical 알림. notifier 어댑터가 자체 toggle 검사 후 발송.
        // tokio::spawn 으로 fire-and-forget — login response latency 영향 0.
        if just_locked {
            if let Some(notifier) = self.notifier.clone() {
                let key_owned = attempt_key.to_string();
                tokio::spawn(async move {
                    notifier
                        .notify(
                            NotifyLevel::Critical,
                            "Firebat 로그인 잠금 발생",
                            &format!(
                                "5회 연속 로그인 실패 — attempt_key={key_owned} 차단 (60초). brute force 시도 의심. 어드민 설정에서 비밀번호 강도 점검 권장."
                            ),
                        )
                        .await;
                });
            }
        }

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
        // setup 전 = 모든 세션 무효 (옛 자격증명 변경 / Vault 정리 후 옛 쿠키 우회 차단).
        if !self.is_admin_setup() {
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
        // setup 전 = 모든 토큰 무효 (Session / API 모두). Vault 정리 / setup 시점 옛 쿠키 우회 차단.
        if !self.is_admin_setup() {
            return None;
        }
        self.auth.get_session(token)
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  관리자 자격증명
    // ══════════════════════════════════════════════════════════════════════════

    /// (id, password) — Vault 저장값. 빈 string = setup 전.
    pub fn get_admin_credentials(&self) -> (String, String) {
        let id = self.vault.get_secret(VK_ADMIN_ID).unwrap_or_default();
        let password = self.vault.get_secret(VK_ADMIN_PASSWORD).unwrap_or_default();
        (id, password)
    }

    /// 첫 부팅 setup 완료 여부 — Vault 에 admin 자격증명 설정되어 있나.
    /// frontend `/login` 페이지가 호출 → false 면 setup wizard 노출.
    pub fn is_admin_setup(&self) -> bool {
        let (id, password) = self.get_admin_credentials();
        !id.is_empty() && !password.is_empty()
    }

    /// 평문 비밀번호 검증 — argon2 hash vs 입력 비교. set_admin_credentials 가 hash 저장
    /// 하므로 raw plain text 비교는 항상 false. SettingsModal 의 비번 변경 PATCH 가
    /// 현재 비번 검증할 때 사용 (login 부작용 — lock counter / 세션 발급 — 회피).
    pub fn verify_admin_password(&self, plain: &str) -> bool {
        let (_id, stored) = self.get_admin_credentials();
        if stored.is_empty() {
            return false;
        }
        verify_password(&stored, plain)
    }

    /// 자격증명 변경 = 모든 옛 session 즉시 무효화. API 토큰은 별도 lifecycle 이라 보존
    /// (revoke_api_tokens 가 따로 호출해야 폐기). 비번 변경 후 옛 쿠키 우회 차단 (2026-05-09).
    /// 비밀번호는 argon2id hash 후 vault 저장 (평문 저장 X — vault.db 유출 시 비번 노출 차단).
    pub fn set_admin_credentials(&self, new_id: Option<&str>, new_password: Option<&str>) {
        if let Some(id) = new_id {
            self.vault.set_secret(VK_ADMIN_ID, id);
        }
        if let Some(pw) = new_password {
            let hashed = hash_password(pw);
            if !hashed.is_empty() {
                self.vault.set_secret(VK_ADMIN_PASSWORD, &hashed);
            }
        }
        // 모든 active session 폐기 — vault 의 auth:session:* record 일괄 삭제.
        let sessions = self.auth.list_sessions(SessionType::Session);
        for s in sessions {
            self.auth.delete_session(&s.token);
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

// Tests 이관 — `infra/tests/auth_manager_test.rs` (integration test).
// private fn 사용 test 만 inline 유지 — `timing_safe_eq_basic` / `token_format_fbat_prefix_32hex`
// (uses `AuthManager::timing_safe_eq` + `AuthManager::generate_token` private fns).
#[cfg(test)]
mod tests {
    use super::*;

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
