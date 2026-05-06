//! AuthManager integration test — 옛 core inline tests 이관.
//!
//! private fn 사용 test (`timing_safe_eq` / `generate_token`) 는 inline 유지.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::auth::{AuthManager, LoginOutcome};
use firebat_core::ports::{IAuthPort, IVaultPort, SessionType};
use firebat_infra::adapters::auth::VaultAuthAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (AuthManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    (AuthManager::new(auth, vault), dir)
}

#[test]
fn login_with_default_credentials_succeeds() {
    let (mgr, _dir) = make_manager();
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
    let (mgr, _dir) = make_manager();
    let result = mgr.login("admin", "wrong", "test-ip");
    assert!(matches!(result, LoginOutcome::InvalidCredentials));
}

#[test]
fn login_locked_after_5_failures() {
    let (mgr, _dir) = make_manager();
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
    let (mgr, _dir) = make_manager();
    let LoginOutcome::Ok(session) = mgr.login("admin", "admin", "ip") else {
        panic!("login failed");
    };
    let validated = mgr.validate_session(&session.token).unwrap();
    assert_eq!(validated.token, session.token);
}

#[test]
fn validate_session_rejects_api_token() {
    let (mgr, _dir) = make_manager();
    let api_token = mgr.generate_api_token(None);
    // api 토큰을 session 으로 검증 시 None
    assert!(mgr.validate_session(&api_token).is_none());
    // api 검증 path 로는 OK
    assert!(mgr.validate_api_token(&api_token).is_some());
}

#[test]
fn logout_removes_session() {
    let (mgr, _dir) = make_manager();
    let LoginOutcome::Ok(session) = mgr.login("admin", "admin", "ip") else {
        panic!();
    };
    assert!(mgr.logout(&session.token));
    assert!(mgr.validate_session(&session.token).is_none());
}

#[test]
fn api_token_lifecycle() {
    let (mgr, _dir) = make_manager();
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
    let (mgr, _dir) = make_manager();
    // default 로 로그인 OK
    assert!(matches!(
        mgr.login("admin", "admin", "ip"),
        LoginOutcome::Ok(_)
    ));

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
