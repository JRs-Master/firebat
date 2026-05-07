//! Integration tests for `core::managers::ai::retrieval_engine::RetrievalEngine`.
//! Phase B-post audit E4 — inline tests 이관.
//!
//! 옛 inline tests 가 `e.entity` / `e.episodic` private field 직접 access 했으나, test helper 가
//! Arc 사본 보존하여 public API 만으로 검증 — inline 유지 0건.

use std::sync::Arc;

use firebat_core::managers::ai::retrieval_engine::{
    RetrievalEngine, RetrievalLimits, RetrieveOpts,
};
use firebat_core::managers::conversation::ConversationManager;
use firebat_core::managers::entity::EntityManager;
use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::ports::{
    IDatabasePort, IEmbedderPort, IEntityPort, IEpisodicPort, SaveEntityInput, SaveEventInput,
    SaveFactInput,
};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::embedder::StubEmbedderAdapter;
use firebat_infra::adapters::memory::SqliteMemoryAdapter;

/// Engine + entity manager + episodic manager 묶음 — test 가 manager Arc 사본 보존해 검증 가능.
struct EngineFixture {
    engine: RetrievalEngine,
    entity: Arc<EntityManager>,
    episodic: Arc<EpisodicManager>,
    _dir: tempfile::TempDir,
}

async fn make_fixture() -> EngineFixture {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let conv = Arc::new(ConversationManager::new(db));

    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let memory_adapter = Arc::new(
        SqliteMemoryAdapter::new(dir.path().join("memory.db"))
            .unwrap()
            .with_embedder(embedder),
    );
    let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter;
    let entity_mgr = Arc::new(EntityManager::new(entity_port));
    let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));

    let engine = RetrievalEngine::new()
        .with_conversation(conv)
        .with_entity(entity_mgr.clone())
        .with_episodic(episodic_mgr.clone());
    EngineFixture {
        engine,
        entity: entity_mgr,
        episodic: episodic_mgr,
        _dir: dir,
    }
}

#[tokio::test]
async fn empty_query_returns_empty_result() {
    let f = make_fixture().await;
    let r = f.engine.retrieve(&RetrieveOpts::default()).await;
    assert_eq!(r.context_summary, "");
    assert_eq!(r.stats.history, 0);
    assert_eq!(r.stats.entities, 0);
}

#[tokio::test]
async fn no_matches_returns_empty_summary() {
    let f = make_fixture().await;
    let r = f
        .engine
        .retrieve(&RetrieveOpts {
            query: "totally-nonexistent-query-xyz".to_string(),
            ..Default::default()
        })
        .await;
    assert_eq!(r.context_summary, "");
}

#[tokio::test]
async fn entity_match_appears_in_summary() {
    let f = make_fixture().await;
    f.entity
        .save_entity(SaveEntityInput {
            name: "삼성전자".to_string(),
            entity_type: "stock".to_string(),
            aliases: vec!["005930".to_string()],
            ..Default::default()
        })
        .await
        .unwrap();
    let r = f
        .engine
        .retrieve(&RetrieveOpts {
            query: "삼성".to_string(),
            ..Default::default()
        })
        .await;
    assert!(r.stats.entities >= 1, "entity 매칭 안 됨");
    assert!(r.context_summary.contains("MEMORY_CONTEXT"));
    assert!(r.context_summary.contains("관련 엔티티"));
    assert!(r.context_summary.contains("삼성전자"));
}

#[tokio::test]
async fn entity_with_facts_timeline_appended() {
    let f = make_fixture().await;
    let (eid, _) = f
        .entity
        .save_entity(SaveEntityInput {
            name: "삼성".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    for i in 0..3 {
        f.entity
            .save_fact(SaveFactInput {
                entity_id: eid,
                content: format!("매수 {}건", i),
                fact_type: Some("transaction".to_string()),
                occurred_at: Some(1_700_000_000_000 + i * 86_400_000),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    let r = f
        .engine
        .retrieve(&RetrieveOpts {
            query: "삼성".to_string(),
            limits: RetrievalLimits {
                facts_per_entity: Some(3),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
    // entity 라인 안에 timeline fact 들이 박혀있음
    assert!(r.context_summary.contains("매수"));
    assert!(r.context_summary.contains("[transaction]"));
}

#[tokio::test]
async fn events_match_appears_with_iso_date() {
    let f = make_fixture().await;
    f.episodic
        .save_event(SaveEventInput {
            event_type: "page_publish".to_string(),
            title: "주간 시황 발행".to_string(),
            description: Some("KOSPI 분석".to_string()),
            who: Some("cron".to_string()),
            occurred_at: Some(1_700_000_000_000),
            ..Default::default()
        })
        .await
        .unwrap();
    let r = f
        .engine
        .retrieve(&RetrieveOpts {
            query: "주간 시황".to_string(),
            ..Default::default()
        })
        .await;
    assert!(r.stats.events >= 1);
    assert!(r.context_summary.contains("관련 사건"));
    assert!(r.context_summary.contains("[page_publish]"));
    assert!(r.context_summary.contains("(cron)"));
    // ISO date 박혀있음 (`2023-11-` prefix — 1_700_000_000_000 = 2023-11-14)
    assert!(r.context_summary.contains("2023-11-"));
}

#[tokio::test]
async fn limits_zero_disables_source() {
    let f = make_fixture().await;
    f.entity
        .save_entity(SaveEntityInput {
            name: "테스트".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    // limits.entities=0 박으면 entity 검색 skip
    let r = f
        .engine
        .retrieve(&RetrieveOpts {
            query: "테스트".to_string(),
            limits: RetrievalLimits {
                entities: Some(0),
                facts: Some(0),
                events: Some(0),
                history: Some(0),
                ..Default::default()
            },
            ..Default::default()
        })
        .await;
    assert_eq!(r.stats.entities, 0);
    assert_eq!(r.context_summary, "");
}

#[tokio::test]
async fn missing_dependencies_silent_skip() {
    // 모든 의존성 미박음 — silent fail (옛 TS 동등)
    let e = RetrievalEngine::new();
    let r = e
        .retrieve(&RetrieveOpts {
            query: "삼성".to_string(),
            ..Default::default()
        })
        .await;
    assert_eq!(r.stats.history, 0);
    assert_eq!(r.stats.entities, 0);
    assert_eq!(r.stats.facts, 0);
    assert_eq!(r.stats.events, 0);
    assert_eq!(r.context_summary, "");
}
