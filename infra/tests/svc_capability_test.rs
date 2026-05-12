//! CapabilityService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::capability::CapabilityManager;
use firebat_core::ports::{ILogPort, IStoragePort, IVaultPort};
use firebat_core::proto::{
    capability_service_server::CapabilityService, CapabilitySetSettingsRequest, Empty, StringRequest,
};
use firebat_core::services::capability::CapabilityServiceImpl;
use firebat_infra::adapters::log::ConsoleLogAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_service() -> (CapabilityServiceImpl, TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(tmp.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let manager = Arc::new(CapabilityManager::new(storage, vault, log));
    (CapabilityServiceImpl::new(manager), tmp)
}

#[tokio::test]
async fn list_returns_builtin_via_grpc() {
    let (service, _dir) = make_service();
    let resp = service.list(Request::new(Empty {})).await.unwrap();
    let caps: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(caps.get("web-scrape").is_some());
    assert!(caps.get("notification").is_some());
}

#[tokio::test]
async fn settings_roundtrip_via_grpc() {
    let (service, _dir) = make_service();

    // set
    let resp = service
        .set_settings(Request::new(CapabilitySetSettingsRequest {
            cap_id: "notification".to_string(),
            providers: vec!["a".to_string(), "b".to_string()],
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    // get
    let resp = service
        .get_settings(Request::new(StringRequest {
            value: "notification".to_string(),
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert_eq!(inner.providers, vec!["a".to_string(), "b".to_string()]);
}
