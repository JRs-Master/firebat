//! AuthService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::auth::AuthManager;
use firebat_core::ports::{IAuthPort, IVaultPort};
use firebat_core::proto::{
    auth_service_server::AuthService, AuthGenerateApiTokenRequest, AuthGetApiTokenInfoRequest,
    AuthIsAdminSetupRequest, AuthLoginRequest, AuthRevokeApiTokensRequest,
    AuthValidateApiTokenRequest,
};
use firebat_core::services::auth::AuthServiceImpl;
use firebat_infra::adapters::auth::VaultAuthAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// 명시 자격증명 (testadmin / testpass) 설정 완료 상태로 service 반환.
/// 2026-05-09: admin/admin 디폴트 폴백 폐기 (setup wizard 패턴) — 모든 테스트가
/// 명시 setup 후 시작.
fn make_service() -> (AuthServiceImpl, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    let manager = Arc::new(AuthManager::new(auth, vault));
    manager.set_admin_credentials(Some("testadmin"), Some("testpass"));
    (AuthServiceImpl::new(manager), dir)
}

#[tokio::test]
async fn login_success_via_grpc() {
    let (service, _dir) = make_service();
    let resp = service
        .login(Request::new(AuthLoginRequest {
            id: "testadmin".to_string(),
            password: "testpass".to_string(),
            attempt_key: Some("test".to_string()),
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert!(inner.ok);
    assert!(inner.session.unwrap().token.starts_with("fbat_"));
}

#[tokio::test]
async fn login_wrong_password_returns_failed() {
    let (service, _dir) = make_service();
    let resp = service
        .login(Request::new(AuthLoginRequest {
            id: "testadmin".to_string(),
            password: "wrong".to_string(),
            attempt_key: None,
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert!(!inner.ok);
    assert_eq!(inner.code.as_deref(), Some("AUTH_FAILED"));
}

#[tokio::test]
async fn is_admin_setup_via_grpc_reflects_state() {
    // setup 전: false
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    let manager = Arc::new(AuthManager::new(auth, vault));
    let service = AuthServiceImpl::new(manager.clone());

    let resp = service
        .is_admin_setup(Request::new(AuthIsAdminSetupRequest {}))
        .await
        .unwrap();
    assert!(!resp.into_inner().is_setup);

    // setup 후: true
    manager.set_admin_credentials(Some("testadmin"), Some("testpass"));
    let resp = service
        .is_admin_setup(Request::new(AuthIsAdminSetupRequest {}))
        .await
        .unwrap();
    assert!(resp.into_inner().is_setup);
}

#[tokio::test]
async fn api_token_grpc_lifecycle() {
    let (service, _dir) = make_service();
    // 발급
    let resp = service
        .generate_api_token(Request::new(AuthGenerateApiTokenRequest {
            label: "MCP test".to_string(),
        }))
        .await
        .unwrap();
    let token = resp.into_inner().token;
    assert!(token.starts_with("fbat_"));

    // 검증
    let resp = service
        .validate_api_token(Request::new(AuthValidateApiTokenRequest {
            token: token.clone(),
        }))
        .await
        .unwrap();
    // session.token="" 이면 미인증 (None 에 해당)
    assert!(!resp.into_inner().session.unwrap().token.is_empty());

    // info
    let resp = service
        .get_api_token_info(Request::new(AuthGetApiTokenInfoRequest {}))
        .await
        .unwrap();
    assert!(resp.into_inner().exists);

    // 폐기
    let resp = service
        .revoke_api_tokens(Request::new(AuthRevokeApiTokensRequest {}))
        .await
        .unwrap();
    assert_eq!(resp.into_inner().revoked_count, 1);

    // 검증 실패
    let resp = service
        .validate_api_token(Request::new(AuthValidateApiTokenRequest { token }))
        .await
        .unwrap();
    // 폐기 후 — session.token="" 빈 문자열로 미인증 표시
    assert!(resp.into_inner().session.unwrap().token.is_empty());
}
