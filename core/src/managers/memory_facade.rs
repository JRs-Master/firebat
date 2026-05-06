//! MemoryFacade — `IMemoryFacadePort` 의 EntityManager + EpisodicManager wrapper.
//!
//! ConsolidationManager 가 두 매니저를 직접 의존하던 BIBLE 위반 (매니저 간 직접 호출) 정정.
//! Facade pattern 으로 4-tier memory (history + entities + facts + events) 의 통계·정리
//! 메서드만 trait 으로 격리. Mutation (saveEntity / saveEvent / etc) 은 각 매니저 직접 호출
//! (Core facade gRPC service 가 외부 진입점).
//!
//! 향후 multi-tenant SaaS / 외부 사용자 진입 시점에 Memory 매니저 차원 단일 facade
//! (CommandManager) 로 흡수 가능 — trait 그대로 유지.
//!
//! 2026-05-06 박힘 (Phase B-4 cutover audit 결과 회색 지대 #3 정리).
//!
//! WARNING: 의존 그래프상 ConsolidationManager → MemoryFacade → EntityManager + EpisodicManager.
//! 즉 facade 자체는 Core 내부에서 어댑터처럼 동작 (concrete struct 보유) — 단 ConsolidationManager
//! 측에서는 `Arc<dyn IMemoryFacadePort>` trait object 만 의존하므로 hexagonal 정신 회복.

use std::sync::Arc;

use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::ports::{
    EntityRecord, IMemoryFacadePort, InfraResult, SaveEntityInput, SaveEventInput, SaveFactInput,
};

pub struct MemoryFacade {
    entity: Arc<EntityManager>,
    episodic: Arc<EpisodicManager>,
}

impl MemoryFacade {
    pub fn new(entity: Arc<EntityManager>, episodic: Arc<EpisodicManager>) -> Self {
        Self { entity, episodic }
    }
}

#[async_trait::async_trait]
impl IMemoryFacadePort for MemoryFacade {
    fn count_entities(&self) -> InfraResult<i64> {
        self.entity.count_entities()
    }
    fn count_facts(&self) -> InfraResult<i64> {
        self.entity.count_facts()
    }
    fn count_events(&self) -> InfraResult<i64> {
        self.episodic.count_events()
    }
    fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        self.entity.count_entities_by_type()
    }
    fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        self.episodic.count_events_by_type()
    }
    fn cleanup_expired_facts(&self) -> InfraResult<i64> {
        self.entity.cleanup_expired()
    }
    fn cleanup_expired_events(&self) -> InfraResult<i64> {
        self.episodic.cleanup_expired()
    }

    fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>> {
        self.entity.find_entity_by_name(name)
    }
    async fn save_entity(&self, input: SaveEntityInput) -> InfraResult<(i64, bool)> {
        self.entity.save_entity(input).await
    }
    async fn save_fact(&self, input: SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)> {
        self.entity.save_fact(input).await
    }
    async fn save_event(&self, input: SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)> {
        self.episodic.save_event(input).await
    }
}
