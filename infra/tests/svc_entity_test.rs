//! EntityService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::entity::EntityManager;
use firebat_core::ports::IEntityPort;
use firebat_core::proto::{entity_service_server::EntityService, JsonArgs};
use firebat_core::services::entity::EntityServiceImpl;
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

fn service() -> (EntityServiceImpl, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let port: Arc<dyn IEntityPort> =
        Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    let mgr = Arc::new(EntityManager::new(port));
    (EntityServiceImpl::new(mgr), dir)
}

#[tokio::test]
async fn save_then_search_via_grpc() {
    let (svc, _dir) = service();
    let resp = svc
        .save(Request::new(JsonArgs {
            raw: serde_json::json!({
                "name": "테스트",
                "type": "stock",
                "aliases": ["t"]
            })
            .to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert!(parsed["id"].as_i64().unwrap() > 0);

    let search_resp = svc
        .search(Request::new(JsonArgs {
            raw: serde_json::json!({"query": "테스트", "limit": 10}).to_string(),
        }))
        .await
        .unwrap();
    let list: serde_json::Value = serde_json::from_str(&search_resp.into_inner().raw).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
}
