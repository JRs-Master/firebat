//! CapabilityService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::capability::CapabilityManager;
use firebat_core::ports::{ILogPort, IStoragePort, IVaultPort};
use firebat_core::proto::{
    capability_service_server::CapabilityService, CapabilityGetSettingsRequest,
    CapabilityListRequest, CapabilitySetSettingsRequest,
};
use firebat_core::grpc::capability::CapabilityServiceImpl;
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

/// The service returns what the modules declare, so a temp dir with none returns none.
///
/// This asserted two hard-coded builtin ids, which is the assumption that let the hand-written
/// capability list drift from the modules in the first place — the same assertion existed in
/// capability_manager_test and both passed while fifteen real capabilities never reached the
/// screen. What the service owes is a well-formed answer, not a fixed vocabulary.
#[tokio::test]
async fn list_returns_what_the_modules_declare_via_grpc() {
    let (service, _dir) = make_service();
    let resp = service
        .list(Request::new(CapabilityListRequest {}))
        .await
        .unwrap();
    let caps: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(caps.is_object(), "expected an object, got {caps}");
    assert_eq!(caps.as_object().map(|o| o.len()), Some(0), "no modules installed: {caps}");
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
    // CapabilitySetSettingsResponse 는 empty struct — 성공 여부는 Ok(_) 자체.
    let _ = resp.into_inner();

    // get
    let resp = service
        .get_settings(Request::new(CapabilityGetSettingsRequest {
            cap_id: "notification".to_string(),
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert_eq!(inner.providers, vec!["a".to_string(), "b".to_string()]);
}
