//! ConsolidationManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::consolidation::{
    ConsolidationManager, ExtractedEntity, ExtractedEvent, ExtractedFact, ExtractionResult,
};
use firebat_core::managers::entity::EntityManager;
use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::managers::memory_facade::MemoryFacade;
use firebat_core::ports::{IEntityPort, IEpisodicPort, IMemoryFacadePort};
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

fn make_manager() -> (ConsolidationManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let adapter = Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    let entity_port: Arc<dyn IEntityPort> = adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = adapter;
    let entity_mgr = Arc::new(EntityManager::new(entity_port));
    let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
    let memory: Arc<dyn IMemoryFacadePort> = Arc::new(MemoryFacade::new(entity_mgr, episodic_mgr));
    (ConsolidationManager::new(memory), dir)
}

#[tokio::test]
async fn save_extracted_creates_entities_and_facts() {
    let (mgr, _dir) = make_manager();
    let extracted = ExtractionResult {
        entities: vec![ExtractedEntity {
            name: "삼성전자".to_string(),
            entity_type: "stock".to_string(),
            aliases: vec!["005930".to_string()],
            metadata: None,
        }],
        facts: vec![ExtractedFact {
            entity_name: "삼성전자".to_string(),
            content: "1주 매수".to_string(),
            fact_type: Some("transaction".to_string()),
            occurred_at: Some(1_700_000_000_000),
            tags: vec![],
        }],
        events: vec![ExtractedEvent {
            event_type: "page_publish".to_string(),
            title: "주간 시황".to_string(),
            description: None,
            occurred_at: Some(1_700_001_000_000),
            entity_names: vec!["삼성전자".to_string()],
        }],
    };
    let outcome = mgr
        .save_extracted(extracted, Some("c1"), Some(0.92), Some(0.92))
        .await
        .unwrap();
    assert_eq!(outcome.saved.entities.len(), 1);
    assert_eq!(outcome.saved.facts.len(), 1);
    assert_eq!(outcome.saved.events.len(), 1);
    assert_eq!(outcome.skipped, 0);
}

#[tokio::test]
async fn missing_entity_name_skips_fact() {
    let (mgr, _dir) = make_manager();
    let extracted = ExtractionResult {
        entities: vec![],
        facts: vec![ExtractedFact {
            entity_name: "없는엔티티".to_string(),
            content: "데이터".to_string(),
            fact_type: None,
            occurred_at: None,
            tags: vec![],
        }],
        events: vec![],
    };
    let outcome = mgr
        .save_extracted(extracted, None, None, None)
        .await
        .unwrap();
    assert_eq!(outcome.saved.facts.len(), 0);
    assert_eq!(outcome.skipped, 1);
}

#[tokio::test]
async fn memory_stats_aggregates_async() {
    let (mgr, _dir) = make_manager();
    let extracted = ExtractionResult {
        entities: vec![
            ExtractedEntity {
                name: "A".to_string(),
                entity_type: "stock".to_string(),
                ..Default::default()
            },
            ExtractedEntity {
                name: "B".to_string(),
                entity_type: "person".to_string(),
                ..Default::default()
            },
        ],
        facts: vec![],
        events: vec![ExtractedEvent {
            event_type: "page_publish".to_string(),
            title: "t".to_string(),
            description: None,
            occurred_at: Some(1),
            entity_names: vec![],
        }],
    };
    mgr.save_extracted(extracted, None, None, None).await.unwrap();
    let stats = mgr.get_memory_stats().unwrap();
    assert_eq!(stats.entities, 2);
    assert_eq!(stats.events, 1);
    assert!(stats
        .entities_by_type
        .iter()
        .any(|(t, c)| t == "stock" && *c == 1));
}
