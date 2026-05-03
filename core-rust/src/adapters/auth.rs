//! VaultAuthAdapter — IAuthPort 의 Vault 기반 구현체.
//!
//! AuthSession 을 Vault SQLite 에 JSON 으로 저장. 키 형식: `auth:session:{token}`
//! 옛 TS VaultAuthAdapter (`infra/auth/index.ts`) Rust 재구현.

use std::sync::Arc;

use crate::ports::{AuthSession, IAuthPort, IVaultPort, SessionType};

const SESSION_PREFIX: &str = "auth:session:";

pub struct VaultAuthAdapter {
    vault: Arc<dyn IVaultPort>,
}

impl VaultAuthAdapter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
    }

    fn key(token: &str) -> String {
        format!("{}{}", SESSION_PREFIX, token)
    }

    /// 현재 unix epoch ms — 만료 검사용
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// 세션 만료 여부.
    fn is_expired(session: &AuthSession) -> bool {
        match session.expires_at {
            Some(exp) => Self::now_ms() > exp,
            None => false, // expires_at None = api 토큰, 영구
        }
    }
}

impl IAuthPort for VaultAuthAdapter {
    fn save_session(&self, session: &AuthSession) -> bool {
        let Ok(json) = serde_json::to_string(session) else {
            return false;
        };
        self.vault.set_secret(&Self::key(&session.token), &json)
    }

    fn get_session(&self, token: &str) -> Option<AuthSession> {
        let raw = self.vault.get_secret(&Self::key(token))?;
        let session: AuthSession = serde_json::from_str(&raw).ok()?;
        if Self::is_expired(&session) {
            self.vault.delete_secret(&Self::key(token));
            return None;
        }
        Some(session)
    }

    fn delete_session(&self, token: &str) -> bool {
        self.vault.delete_secret(&Self::key(token))
    }

    fn list_sessions(&self, session_type: SessionType) -> Vec<AuthSession> {
        let keys = self.vault.list_keys_by_prefix(SESSION_PREFIX);
        let mut result = Vec::new();
        for key in keys {
            let Some(raw) = self.vault.get_secret(&key) else {
                continue;
            };
            let Ok(session): Result<AuthSession, _> = serde_json::from_str(&raw) else {
                continue;
            };
            if session.session_type != session_type {
                continue;
            }
            // 만료된 세션 자동 정리 (lazy sweep)
            if Self::is_expired(&session) {
                self.vault.delete_secret(&key);
                continue;
            }
            result.push(session);
        }
        result
    }

    fn delete_sessions(&self, session_type: SessionType) -> usize {
        let keys = self.vault.list_keys_by_prefix(SESSION_PREFIX);
        let mut count = 0;
        for key in keys {
            let Some(raw) = self.vault.get_secret(&key) else {
                continue;
            };
            let Ok(session): Result<AuthSession, _> = serde_json::from_str(&raw) else {
                continue;
            };
            if session.session_type == session_type {
                if self.vault.delete_secret(&key) {
                    count += 1;
                }
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use crate::ports::{SessionRole, SessionType};

    fn make_adapter() -> VaultAuthAdapter {
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        VaultAuthAdapter::new(vault)
    }

    fn make_session(token: &str, t: SessionType, expires_at: Option<i64>) -> AuthSession {
        AuthSession {
            token: token.to_string(),
            session_type: t,
            role: SessionRole::Admin,
            created_at: VaultAuthAdapter::now_ms(),
            expires_at,
            last_used_at: None,
            label: None,
        }
    }

    #[test]
    fn save_get_delete_session() {
        let adapter = make_adapter();
        let session = make_session("tok-1", SessionType::Session, Some(VaultAuthAdapter::now_ms() + 60_000));

        assert!(adapter.save_session(&session));
        let got = adapter.get_session("tok-1").unwrap();
        assert_eq!(got.token, "tok-1");
        assert_eq!(got.session_type, SessionType::Session);

        assert!(adapter.delete_session("tok-1"));
        assert!(adapter.get_session("tok-1").is_none());
    }

    #[test]
    fn expired_session_is_auto_cleaned() {
        let adapter = make_adapter();
        // 이미 만료된 세션
        let past = VaultAuthAdapter::now_ms() - 1000;
        let session = make_session("expired", SessionType::Session, Some(past));
        adapter.save_session(&session);

        // get 시 None + 자동 삭제
        assert!(adapter.get_session("expired").is_none());
    }

    #[test]
    fn list_and_delete_by_type() {
        let adapter = make_adapter();
        let future = VaultAuthAdapter::now_ms() + 60_000;
        adapter.save_session(&make_session("s1", SessionType::Session, Some(future)));
        adapter.save_session(&make_session("s2", SessionType::Session, Some(future)));
        adapter.save_session(&make_session("a1", SessionType::Api, None));

        assert_eq!(adapter.list_sessions(SessionType::Session).len(), 2);
        assert_eq!(adapter.list_sessions(SessionType::Api).len(), 1);

        let deleted = adapter.delete_sessions(SessionType::Session);
        assert_eq!(deleted, 2);
        assert_eq!(adapter.list_sessions(SessionType::Session).len(), 0);
        assert_eq!(adapter.list_sessions(SessionType::Api).len(), 1);
    }

    #[test]
    fn api_token_no_expiration() {
        let adapter = make_adapter();
        // expires_at=None → 영구
        adapter.save_session(&make_session("api-tok", SessionType::Api, None));
        let got = adapter.get_session("api-tok").unwrap();
        assert_eq!(got.session_type, SessionType::Api);
        assert!(got.expires_at.is_none());
    }
}
