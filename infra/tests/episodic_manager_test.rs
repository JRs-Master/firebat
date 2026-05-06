//! EpisodicManager integration test — 옛 core 의 inline `#[cfg(test)] mod tests` 이관.
//!
//! Phase B-4 cutover 후 dev-dep cyclic 회피.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::ports::{IEpisodicPort, ListRecentOpts, SaveEventInput};
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

fn make_manager() -> (EpisodicManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let port: Arc<dyn IEpisodicPort> =
        Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    (EpisodicManager::new(port), dir)
}

#[tokio::test]
async fn save_search_recent() {
    let (mgr, _dir) = make_manager();
    mgr.save_event(SaveEventInput {
        event_type: "page_publish".to_string(),
        title: "p1".to_string(),
        occurred_at: Some(1_000),
        ..Default::default()
    })
    .await
    .unwrap();
    mgr.save_event(SaveEventInput {
        event_type: "page_publish".to_string(),
        title: "p2".to_string(),
        occurred_at: Some(2_000),
        ..Default::default()
    })
    .await
    .unwrap();
    let recent = mgr
        .list_recent_events(ListRecentOpts {
            event_type: Some("page_publish".to_string()),
            limit: Some(10),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(recent.len(), 2);
    assert!(recent[0].occurred_at >= recent[1].occurred_at);
}
