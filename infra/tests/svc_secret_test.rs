//! SecretService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::secret::SecretManager;
use firebat_core::ports::{IStoragePort, IVaultPort};
use firebat_core::proto::{secret_service_server::SecretService, Empty, JsonArgs, StringRequest};
use firebat_core::services::secret::SecretServiceImpl;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_service() -> (SecretServiceImpl, TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(tmp.path().join("vault.db")).unwrap());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
    let manager = Arc::new(SecretManager::new(vault, storage));
    (SecretServiceImpl::new(manager), tmp)
}

#[tokio::test]
async fn user_secret_set_get_delete_via_grpc() {
    let (service, _dir) = make_service();

    // set
    let resp = service
        .set_user(Request::new(JsonArgs {
            raw: r#"{"name":"FOO","value":"bar"}"#.to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    // get
    let resp = service
        .get_user(Request::new(StringRequest {
            value: "FOO".to_string(),
        }))
        .await
        .unwrap();
    let val: Option<String> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(val, Some("bar".to_string()));

    // list
    let resp = service.list_user(Request::new(Empty {})).await.unwrap();
    let names: Vec<String> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(names, vec!["FOO".to_string()]);

    // delete
    let resp = service
        .delete_user(Request::new(StringRequest {
            value: "FOO".to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    // verify deleted
    let resp = service.list_user(Request::new(Empty {})).await.unwrap();
    let names: Vec<String> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(names.len(), 0);
}
