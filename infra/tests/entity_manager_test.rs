//! EntityManager integration test — 옛 core 의 inline `#[cfg(test)] mod tests` 이관.
//!
//! Phase B-4 cutover 후 dev-dep cyclic (core ← infra ← core) 회피 위해 integration test 로
//! 이동. core crate 가 `pub` 노출하는 메서드만 호출 가능 — private fn 사용 test 는 inline 유지.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::entity::EntityManager;
use firebat_core::ports::{IEntityPort, SaveEntityInput, SaveFactInput};
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

fn make_manager() -> (EntityManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let port: Arc<dyn IEntityPort> =
        Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    (EntityManager::new(port), dir)
}

#[tokio::test]
async fn retrieve_context_links_entity_and_facts() {
    let (mgr, _dir) = make_manager();
    let (eid, _) = mgr
        .save_entity(SaveEntityInput {
            name: "삼성전자".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    mgr.save_fact(SaveFactInput {
        entity_id: eid,
        content: "1주 매수".to_string(),
        occurred_at: Some(1_700_000_000_000),
        ..Default::default()
    })
    .await
    .unwrap();

    let result = mgr.retrieve_context("삼성", 5, 5).await.unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].0.name, "삼성전자");
    assert_eq!(result[0].1.len(), 1);
}

#[tokio::test]
async fn retrieve_context_empty_query_returns_empty() {
    let (mgr, _dir) = make_manager();
    let result = mgr.retrieve_context("   ", 5, 5).await.unwrap();
    assert!(result.is_empty());
}
