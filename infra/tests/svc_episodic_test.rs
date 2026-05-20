//! EpisodicService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::ports::IEpisodicPort;
use firebat_core::proto::{
    episodic_service_server::EpisodicService, EpisodicListRecentRequest, EpisodicSaveEventRequest,
};
use firebat_core::grpc::episodic::EpisodicServiceImpl;
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

#[tokio::test]
async fn save_then_search_via_grpc() {
    let dir = tempfile::tempdir().unwrap();
    let _dir_keep: TempDir = dir;
    let port: Arc<dyn IEpisodicPort> =
        Arc::new(SqliteMemoryAdapter::new(_dir_keep.path().join("memory.db")).unwrap());
    let mgr = Arc::new(EpisodicManager::new(port));
    let svc = EpisodicServiceImpl::new(mgr);

    let resp = svc
        .save_event(Request::new(EpisodicSaveEventRequest {
            event_type: "page_publish".to_string(),
            title: "test".to_string(),
            description: None,
            who: None,
            context_json: None,
            occurred_at: Some(1000),
            entity_ids: vec![],
            source_conv_id: None,
            ttl_days: None,
            dedup_threshold: None,
            owner: None,
        }))
        .await
        .unwrap();
    let inner = resp.into_inner();
    assert!(inner.id > 0);

    let recent = svc
        .list_recent(Request::new(EpisodicListRecentRequest {
            opts_json: serde_json::json!({"limit": 10}).to_string(),
        }))
        .await
        .unwrap();
    let list: serde_json::Value = serde_json::from_str(&recent.into_inner().raw_json).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
}
