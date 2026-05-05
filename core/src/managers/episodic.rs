//! EpisodicManager — 메모리 4-tier Phase 2 (Episodic tier).
//!
//! 옛 TS `core/managers/episodic-manager.ts` Rust 재구현. 시간순 사건 추적 +
//! Entity 와 m2m link.

use std::sync::Arc;

use crate::ports::{
    EventRecord, EventSearchOpts, IEpisodicPort, InfraResult, ListRecentOpts, SaveEventInput,
    UpdateEventPatch,
};

pub struct EpisodicManager {
    port: Arc<dyn IEpisodicPort>,
}

impl EpisodicManager {
    pub fn new(port: Arc<dyn IEpisodicPort>) -> Self {
        Self { port }
    }

    pub async fn save_event(
        &self,
        input: SaveEventInput,
    ) -> InfraResult<(i64, bool, Option<f64>)> {
        self.port.save_event(&input).await
    }

    pub fn update_event(&self, id: i64, patch: UpdateEventPatch) -> InfraResult<()> {
        self.port.update_event(id, &patch)
    }

    pub fn delete_event(&self, id: i64) -> InfraResult<()> {
        self.port.remove_event(id)
    }

    pub fn get_event(&self, id: i64) -> InfraResult<Option<EventRecord>> {
        self.port.get_event(id)
    }

    pub async fn search_events(&self, opts: EventSearchOpts) -> InfraResult<Vec<EventRecord>> {
        self.port.search_events(&opts).await
    }

    pub fn list_recent_events(&self, opts: ListRecentOpts) -> InfraResult<Vec<EventRecord>> {
        self.port.list_recent_events(&opts)
    }

    pub async fn list_events_by_entity(
        &self,
        entity_id: i64,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> InfraResult<Vec<EventRecord>> {
        self.port
            .search_events(&EventSearchOpts {
                entity_id: Some(entity_id),
                limit,
                offset,
                ..Default::default()
            })
            .await
    }

    pub fn link_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()> {
        self.port.link_event_entity(event_id, entity_id)
    }

    pub fn unlink_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()> {
        self.port.unlink_event_entity(event_id, entity_id)
    }

    pub fn cleanup_expired(&self) -> InfraResult<i64> {
        self.port.cleanup_expired_events()
    }

    pub fn count_events(&self) -> InfraResult<i64> {
        self.port.count_events()
    }

    pub fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        self.port.count_events_by_type()
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::memory::SqliteMemoryAdapter;

    fn manager() -> EpisodicManager {
        let port: Arc<dyn IEpisodicPort> = Arc::new(SqliteMemoryAdapter::new_in_memory().unwrap());
        EpisodicManager::new(port)
    }

    #[tokio::test]
    async fn save_search_recent() {
        let mgr = manager();
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
}
