//! AuthService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::auth::AuthManager;
use firebat_core::ports::{AuthSession, IAuthPort, IVaultPort};
use firebat_core::proto::{auth_service_server::AuthService, Empty, JsonArgs, StringRequest};
use firebat_core::services::auth::AuthServiceImpl;
use firebat_infra::adapters::auth::VaultAuthAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_service() -> (AuthServiceImpl, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    let manager = Arc::new(AuthManager::new(auth, vault));
    (AuthServiceImpl::new(manager), dir)
}

#[tokio::test]
async fn login_success_via_grpc() {
    let (service, _dir) = make_service();
    let resp = service
        .login(Request::new(JsonArgs {
            raw: r#"{"id":"admin","password":"admin","attempt_key":"test"}"#.to_string(),
        }))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert_eq!(json["ok"], true);
    assert!(json["session"]["token"].as_str().unwrap().starts_with("fbat_"));
}

#[tokio::test]
async fn login_wrong_password_returns_failed() {
    let (service, _dir) = make_service();
    let resp = service
        .login(Request::new(JsonArgs {
            raw: r#"{"id":"admin","password":"wrong"}"#.to_string(),
        }))
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["code"], "AUTH_FAILED");
}

#[tokio::test]
async fn api_token_grpc_lifecycle() {
    let (service, _dir) = make_service();
    // 발급
    let resp = service
        .generate_api_token(Request::new(StringRequest {
            value: "MCP test".to_string(),
        }))
        .await
        .unwrap();
    let token = resp.into_inner().value;
    assert!(token.starts_with("fbat_"));

    // 검증
    let resp = service
        .validate_api_token(Request::new(StringRequest { value: token.clone() }))
        .await
        .unwrap();
    let session: Option<AuthSession> = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert!(session.is_some());

    // info
    let resp = service.get_api_token_info(Request::new(Empty {})).await.unwrap();
    let info: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert_eq!(info["exists"], true);

    // 폐기
    let resp = service.revoke_api_tokens(Request::new(Empty {})).await.unwrap();
    assert_eq!(resp.into_inner().value, 1);

    // 검증 실패
    let resp = service
        .validate_api_token(Request::new(StringRequest { value: token }))
        .await
        .unwrap();
    let session: Option<AuthSession> = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert!(session.is_none());
}
