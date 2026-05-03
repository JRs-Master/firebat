//! EntityManager — 메모리 4-tier Phase 1 (Entity tier).
//!
//! 옛 TS `core/managers/entity-manager.ts` Rust 재구현. 종목·인물·프로젝트 단위 영속 추적.
//! IEntityPort 위 thin facade — 매니저는 자체 추가 로직 없이 어댑터에 위임.

use std::sync::Arc;

use crate::ports::{
    EntityFactRecord, EntityRecord, EntitySearchOpts, FactSearchOpts, IEntityPort, InfraResult,
    SaveEntityInput, SaveFactInput, TimelineOpts, UpdateEntityPatch, UpdateFactPatch,
};

pub struct EntityManager {
    port: Arc<dyn IEntityPort>,
}

impl EntityManager {
    pub fn new(port: Arc<dyn IEntityPort>) -> Self {
        Self { port }
    }

    pub async fn save_entity(&self, input: SaveEntityInput) -> InfraResult<(i64, bool)> {
        self.port.save_entity(&input).await
    }

    pub fn update_entity(&self, id: i64, patch: UpdateEntityPatch) -> InfraResult<()> {
        self.port.update_entity(id, &patch)
    }

    pub fn delete_entity(&self, id: i64) -> InfraResult<()> {
        self.port.remove_entity(id)
    }

    pub fn get_entity(&self, id: i64) -> InfraResult<Option<EntityRecord>> {
        self.port.get_entity(id)
    }

    pub fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>> {
        self.port.find_entity_by_name(name)
    }

    pub async fn search_entities(
        &self,
        opts: EntitySearchOpts,
    ) -> InfraResult<Vec<EntityRecord>> {
        self.port.search_entities(&opts).await
    }

    pub async fn save_fact(&self, input: SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)> {
        self.port.save_fact(&input).await
    }

    pub fn update_fact(&self, id: i64, patch: UpdateFactPatch) -> InfraResult<()> {
        self.port.update_fact(id, &patch)
    }

    pub fn delete_fact(&self, id: i64) -> InfraResult<()> {
        self.port.remove_fact(id)
    }

    pub fn get_fact(&self, id: i64) -> InfraResult<Option<EntityFactRecord>> {
        self.port.get_fact(id)
    }

    pub fn get_entity_timeline(
        &self,
        entity_id: i64,
        opts: TimelineOpts,
    ) -> InfraResult<Vec<EntityFactRecord>> {
        self.port.list_facts_by_entity(entity_id, &opts)
    }

    pub async fn search_facts(
        &self,
        opts: FactSearchOpts,
    ) -> InfraResult<Vec<EntityFactRecord>> {
        self.port.search_facts(&opts).await
    }

    /// 자연어 query → 매칭 entity + 해당 entity 의 최근 fact (timeline).
    /// Phase 5 RetrievalEngine 의 base — 현재는 명시 호출 / Phase B-15+ 자동 prepend 패턴.
    pub async fn retrieve_context(
        &self,
        query: &str,
        entity_limit: usize,
        facts_per_entity: usize,
    ) -> InfraResult<Vec<(EntityRecord, Vec<EntityFactRecord>)>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let entity_limit = entity_limit.clamp(1, 20);
        let facts_per_entity = facts_per_entity.clamp(1, 50);
        let entities = self
            .port
            .search_entities(&EntitySearchOpts {
                query: query.to_string(),
                limit: Some(entity_limit),
                ..Default::default()
            })
            .await?;
        let mut out = Vec::new();
        for entity in entities {
            let timeline = self
                .port
                .list_facts_by_entity(
                    entity.id,
                    &TimelineOpts {
                        limit: Some(facts_per_entity),
                        order_by: Some("occurredAt".to_string()),
                        ..Default::default()
                    },
                )
                .unwrap_or_default();
            out.push((entity, timeline));
        }
        Ok(out)
    }

    pub fn cleanup_expired(&self) -> InfraResult<i64> {
        self.port.cleanup_expired_facts()
    }

    pub fn count_entities(&self) -> InfraResult<i64> {
        self.port.count_entities()
    }

    pub fn count_facts(&self) -> InfraResult<i64> {
        self.port.count_facts()
    }

    pub fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        self.port.count_entities_by_type()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::memory::SqliteMemoryAdapter;

    fn manager() -> EntityManager {
        let port: Arc<dyn IEntityPort> = Arc::new(SqliteMemoryAdapter::new_in_memory().unwrap());
        EntityManager::new(port)
    }

    #[tokio::test]
    async fn retrieve_context_links_entity_and_facts() {
        let mgr = manager();
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
        let mgr = manager();
        let result = mgr.retrieve_context("   ", 5, 5).await.unwrap();
        assert!(result.is_empty());
    }
}
