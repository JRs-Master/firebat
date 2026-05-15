//! ConsolidationService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;
use tonic::Request;

use firebat_core::managers::consolidation::ConsolidationManager;
use firebat_core::managers::entity::EntityManager;
use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::managers::memory_facade::MemoryFacade;
use firebat_core::ports::{IEntityPort, IEpisodicPort, IMemoryFacadePort};
use firebat_core::proto::{
    consolidation_service_server::ConsolidationService, ConsolidationConsolidateRequest,
    ConsolidationGetMemoryStatsRequest,
};
use firebat_core::services::consolidation::ConsolidationServiceImpl;
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

fn service() -> (ConsolidationServiceImpl, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let adapter = Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    let entity_port: Arc<dyn IEntityPort> = adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = adapter;
    let entity_mgr = Arc::new(EntityManager::new(entity_port));
    let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
    let memory: Arc<dyn IMemoryFacadePort> = Arc::new(MemoryFacade::new(entity_mgr, episodic_mgr));
    let mgr = Arc::new(ConsolidationManager::new(memory));
    (ConsolidationServiceImpl::new(mgr), dir)
}

#[tokio::test]
async fn consolidate_then_stats_via_grpc() {
    let (svc, _dir) = service();
    let extracted = serde_json::json!({
        "entities": [{"name": "X", "type": "stock"}],
        "facts": [{"entityName": "X", "content": "1주 매수"}],
        "events": []
    });
    let resp = svc
        .consolidate(Request::new(ConsolidationConsolidateRequest {
            conversation_id: None,
            owner: None,
            model_id: None,
            extracted_json: Some(extracted.to_string()),
            source_conv_id: None,
            fact_dedup_threshold: None,
            event_dedup_threshold: None,
        }))
        .await
        .unwrap();
    let outcome: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(outcome["saved"]["entities"].as_array().unwrap().len(), 1);
    assert_eq!(outcome["saved"]["facts"].as_array().unwrap().len(), 1);

    let stats_resp = svc
        .get_memory_stats(Request::new(ConsolidationGetMemoryStatsRequest {}))
        .await
        .unwrap();
    let stats = stats_resp.into_inner();
    assert_eq!(stats.entities, 1);
    assert_eq!(stats.facts, 1);
}
