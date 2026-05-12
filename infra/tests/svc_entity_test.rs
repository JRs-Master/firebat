//! EntityService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::entity::EntityManager;
use firebat_core::ports::IEntityPort;
use firebat_core::proto::{entity_service_server::EntityService, EntitySaveRequest, EntitySearchRequest};
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
        .save(Request::new(EntitySaveRequest {
            name: "테스트".to_string(),
            entity_type: "stock".to_string(),
            aliases: vec!["t".to_string()],
            metadata_json: None,
            source_conv_id: None,
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert!(inner.id > 0);

    let search_resp = svc
        .search(Request::new(EntitySearchRequest {
            opts_json: serde_json::json!({"query": "테스트", "limit": 10}).to_string(),
        }))
        .await
        .unwrap();
    let list: serde_json::Value = serde_json::from_str(&search_resp.into_inner().raw_json).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
}
