//! RetrievalEngine — 메모리 시스템 4-tier 통합 검색 (Phase 5).
//!
//! 옛 TS `core/managers/ai/retrieval-engine.ts` 1:1 Rust port.
//!
//! 사용자 query → 병렬 검색 (history + entities + events + entity_facts) → 통합
//! contextSummary 반환. AiManager 가 시스템 프롬프트에 `<MEMORY_CONTEXT>` 섹션 prepend.
//!
//! vs HistoryResolver:
//!   - HistoryResolver: search_history 만 (대화 raw, spread 판정)
//!   - RetrievalEngine: 4-tier 통합 (history + 메모리 시스템). HistoryResolver 결과
//!     포함 후 entity/event/fact 추가.
//!
//! Token budget — limits 박혀 있으면 그대로, 미박힘 시 default. 빈 결과 자동 skip.
//! 일반 로직: 도메인 (자동매매·블로그 etc) 무관 — 4 source 검색 후 통합.

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::managers::conversation::{ConversationManager, SearchHistoryOpts};
use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::ports::{
    EntityFactRecord, EntitySearchOpts, EventSearchOpts, FactSearchOpts, TimelineOpts,
};

/// 매 source 별 limit. 옛 TS `RetrievalLimits` 1:1.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RetrievalLimits {
    /// search_history 매치 (default 5)
    pub history: Option<usize>,
    /// entity 검색 결과 (default 3)
    pub entities: Option<usize>,
    /// entity_facts 검색 결과 (default 5)
    pub facts: Option<usize>,
    /// events 검색 결과 (default 5)
    pub events: Option<usize>,
    /// 매 entity 의 timeline 추가 fact 수 (default 3)
    #[serde(rename = "factsPerEntity")]
    pub facts_per_entity: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RetrievalStats {
    pub history: usize,
    pub entities: usize,
    pub facts: usize,
    pub events: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RetrievalResult {
    /// 통합 컨텍스트 — system prompt prepend 용. 빈 문자열이면 모든 source 0.
    #[serde(rename = "contextSummary")]
    pub context_summary: String,
    /// 디버그 — 각 source 의 매칭 수
    pub stats: RetrievalStats,
}

#[derive(Debug, Clone, Default)]
pub struct RetrieveOpts {
    pub query: String,
    pub owner: Option<String>,
    pub current_conv_id: Option<String>,
    pub limits: RetrievalLimits,
}

const HISTORY_PREVIEW_MAX: usize = 200;
const FACT_PREVIEW_MAX: usize = 200;
const FACT_TIMELINE_PREVIEW: usize = 150;
const EVENT_DESC_PREVIEW: usize = 100;
const ENTITY_ALIAS_MAX: usize = 3;

pub struct RetrievalEngine {
    conversation: Option<Arc<ConversationManager>>,
    entity: Option<Arc<EntityManager>>,
    episodic: Option<Arc<EpisodicManager>>,
}

impl RetrievalEngine {
    pub fn new() -> Self {
        Self {
            conversation: None,
            entity: None,
            episodic: None,
        }
    }

    pub fn with_conversation(mut self, conversation: Arc<ConversationManager>) -> Self {
        self.conversation = Some(conversation);
        self
    }

    pub fn with_entity(mut self, entity: Arc<EntityManager>) -> Self {
        self.entity = Some(entity);
        self
    }

    pub fn with_episodic(mut self, episodic: Arc<EpisodicManager>) -> Self {
        self.episodic = Some(episodic);
        self
    }

    /// 사용자 query → 4 source 병렬 검색 → 통합 contextSummary.
    /// 옛 TS retrieve(opts) 1:1.
    pub async fn retrieve(&self, opts: &RetrieveOpts) -> RetrievalResult {
        let query = opts.query.trim();
        if query.is_empty() {
            return RetrievalResult::default();
        }

        // limits resolve — opts.limits 우선, 미박음 시 default.
        let lim = ResolvedLimits {
            history: opts.limits.history.unwrap_or(5),
            entities: opts.limits.entities.unwrap_or(3),
            facts: opts.limits.facts.unwrap_or(5),
            events: opts.limits.events.unwrap_or(5),
            facts_per_entity: opts.limits.facts_per_entity.unwrap_or(3),
        };

        // 4 source 병렬 검색 — tokio::join! (Promise.all 1:1)
        let history_fut = self.search_history_safe(query, opts, &lim);
        let entities_fut = self.search_entities_safe(query, &lim);
        let facts_fut = self.search_facts_safe(query, &lim);
        let events_fut = self.search_events_safe(query, &lim);
        let (history, entities, facts, events) =
            tokio::join!(history_fut, entities_fut, facts_fut, events_fut);

        let mut sections: Vec<String> = Vec::new();
        let mut stats = RetrievalStats::default();

        // 1) Conversation history
        if !history.is_empty() {
            stats.history = history.len();
            let mut lines = vec![format!("[관련 과거 대화 ({}건)]", history.len())];
            for m in &history {
                let role_label = if m.role == "user" { "사용자" } else { "AI" };
                let preview = slice_chars(&m.content_preview, HISTORY_PREVIEW_MAX);
                lines.push(format!("- [{}]: {}", role_label, preview));
            }
            sections.push(lines.join("\n"));
        }

        // 2) Entities — 매 entity 마다 최근 timeline (factsPerEntity)
        if !entities.is_empty() {
            stats.entities = entities.len();
            let mut lines = vec![format!("[관련 엔티티 ({}건)]", entities.len())];
            for e in &entities {
                let mut line = format!("- {} ({})", e.name, e.entity_type);
                if !e.aliases.is_empty() {
                    let aliases: Vec<String> = e
                        .aliases
                        .iter()
                        .take(ENTITY_ALIAS_MAX)
                        .cloned()
                        .collect();
                    line.push_str(&format!(" [별칭: {}]", aliases.join(", ")));
                }
                if e.fact_count > 0 {
                    line.push_str(&format!(" · {}개 사실", e.fact_count));
                }
                // Timeline — 짧게 (entity 별 추가 호출)
                if lim.facts_per_entity > 0 {
                    if let Some(entity) = &self.entity {
                        if let Ok(timeline) = entity.get_entity_timeline(
                            e.id,
                            TimelineOpts {
                                limit: Some(lim.facts_per_entity),
                                order_by: Some("occurredAt".to_string()),
                                ..Default::default()
                            },
                        ) {
                            for f in &timeline {
                                line.push('\n');
                                line.push_str("    ");
                                line.push_str(&format_fact_compact(f, FACT_TIMELINE_PREVIEW));
                            }
                        }
                    }
                }
                lines.push(line);
            }
            sections.push(lines.join("\n"));
        }

        // 3) Facts — entity 무관 횡단 검색
        if !facts.is_empty() {
            stats.facts = facts.len();
            let mut lines = vec![format!("[관련 사실 ({}건)]", facts.len())];
            for f in &facts {
                lines.push(format!("- {}", format_fact_compact(f, FACT_PREVIEW_MAX)));
            }
            sections.push(lines.join("\n"));
        }

        // 4) Events — 시간순 사건
        if !events.is_empty() {
            stats.events = events.len();
            let mut lines = vec![format!("[관련 사건 ({}건)]", events.len())];
            for e in &events {
                lines.push(format_event_line(e));
            }
            sections.push(lines.join("\n"));
        }

        if sections.is_empty() {
            return RetrievalResult {
                context_summary: String::new(),
                stats,
            };
        }

        let context_summary = format!(
            "<MEMORY_CONTEXT>\n{}\n</MEMORY_CONTEXT>",
            sections.join("\n\n")
        );
        RetrievalResult {
            context_summary,
            stats,
        }
    }

    async fn search_history_safe(
        &self,
        query: &str,
        opts: &RetrieveOpts,
        lim: &ResolvedLimits,
    ) -> Vec<crate::managers::conversation::HistorySearchMatch> {
        if lim.history == 0 {
            return Vec::new();
        }
        let Some(conv) = &self.conversation else {
            return Vec::new();
        };
        let Some(owner) = &opts.owner else {
            return Vec::new();
        };
        match conv
            .search_history(
                owner,
                query,
                SearchHistoryOpts {
                    current_conv_id: opts.current_conv_id.clone(),
                    limit: Some(lim.history),
                    min_score: Some(0.5),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(matches) => matches,
            Err(_) => Vec::new(),
        }
    }

    async fn search_entities_safe(
        &self,
        query: &str,
        lim: &ResolvedLimits,
    ) -> Vec<crate::ports::EntityRecord> {
        if lim.entities == 0 {
            return Vec::new();
        }
        let Some(entity) = &self.entity else {
            return Vec::new();
        };
        match entity
            .search_entities(EntitySearchOpts {
                query: query.to_string(),
                limit: Some(lim.entities),
                ..Default::default()
            })
            .await
        {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }

    async fn search_facts_safe(
        &self,
        query: &str,
        lim: &ResolvedLimits,
    ) -> Vec<EntityFactRecord> {
        if lim.facts == 0 {
            return Vec::new();
        }
        let Some(entity) = &self.entity else {
            return Vec::new();
        };
        match entity
            .search_facts(FactSearchOpts {
                query: query.to_string(),
                limit: Some(lim.facts),
                ..Default::default()
            })
            .await
        {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }

    async fn search_events_safe(
        &self,
        query: &str,
        lim: &ResolvedLimits,
    ) -> Vec<crate::ports::EventRecord> {
        if lim.events == 0 {
            return Vec::new();
        }
        let Some(episodic) = &self.episodic else {
            return Vec::new();
        };
        match episodic
            .search_events(EventSearchOpts {
                query: query.to_string(),
                limit: Some(lim.events),
                ..Default::default()
            })
            .await
        {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }
}

impl Default for RetrievalEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
struct ResolvedLimits {
    history: usize,
    entities: usize,
    facts: usize,
    events: usize,
    facts_per_entity: usize,
}

/// `YYYY-MM-DD [type] content` (옛 TS 1:1).
fn format_fact_compact(f: &EntityFactRecord, max_content: usize) -> String {
    let date_str = f
        .occurred_at
        .and_then(|ts| Utc.timestamp_millis_opt(ts).single())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let type_label = f
        .fact_type
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|t| format!("[{}] ", t))
        .unwrap_or_default();
    let content = slice_chars(&f.content, max_content);
    format!(
        "{}{}{}",
        if date_str.is_empty() {
            String::new()
        } else {
            format!("{} ", date_str)
        },
        type_label,
        content
    )
}

/// `YYYY-MM-DD HH:MM [type] (who) title — desc` (옛 TS 1:1).
fn format_event_line(e: &crate::ports::EventRecord) -> String {
    let date_str = Utc
        .timestamp_millis_opt(e.occurred_at)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let who_label = e
        .who
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|w| format!(" ({})", w))
        .unwrap_or_default();
    let desc = e
        .description
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|d| format!(" — {}", slice_chars(d, EVENT_DESC_PREVIEW)))
        .unwrap_or_default();
    format!(
        "- {} [{}]{} {}{}",
        date_str, e.event_type, who_label, e.title, desc
    )
}

fn slice_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::database::SqliteDatabaseAdapter;
    use firebat_infra::adapters::embedder::StubEmbedderAdapter;
    use firebat_infra::adapters::memory::SqliteMemoryAdapter;
    use crate::ports::{
        IDatabasePort, IEmbedderPort, IEntityPort, IEpisodicPort, SaveEntityInput, SaveEventInput,
        SaveFactInput,
    };

    async fn make_engine() -> RetrievalEngine {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let conv = Arc::new(ConversationManager::new(db));

        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let memory_adapter = Arc::new(
            SqliteMemoryAdapter::new_in_memory()
                .unwrap()
                .with_embedder(embedder),
        );
        let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
        let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter;
        let entity_mgr = Arc::new(EntityManager::new(entity_port));
        let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));

        RetrievalEngine::new()
            .with_conversation(conv)
            .with_entity(entity_mgr)
            .with_episodic(episodic_mgr)
    }

    #[tokio::test]
    async fn empty_query_returns_empty_result() {
        let e = make_engine().await;
        let r = e.retrieve(&RetrieveOpts::default()).await;
        assert_eq!(r.context_summary, "");
        assert_eq!(r.stats.history, 0);
        assert_eq!(r.stats.entities, 0);
    }

    #[tokio::test]
    async fn no_matches_returns_empty_summary() {
        let e = make_engine().await;
        let r = e
            .retrieve(&RetrieveOpts {
                query: "totally-nonexistent-query-xyz".to_string(),
                ..Default::default()
            })
            .await;
        assert_eq!(r.context_summary, "");
    }

    #[tokio::test]
    async fn entity_match_appears_in_summary() {
        let e = make_engine().await;
        // Entity 박음
        if let Some(entity) = &e.entity {
            entity
                .save_entity(SaveEntityInput {
                    name: "삼성전자".to_string(),
                    entity_type: "stock".to_string(),
                    aliases: vec!["005930".to_string()],
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        let r = e
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
        let e = make_engine().await;
        // Entity + 3 facts 박음
        let entity_mgr = e.entity.as_ref().unwrap();
        let (eid, _) = entity_mgr
            .save_entity(SaveEntityInput {
                name: "삼성".to_string(),
                entity_type: "stock".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        for i in 0..3 {
            entity_mgr
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
        let r = e
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
        let e = make_engine().await;
        if let Some(episodic) = &e.episodic {
            episodic
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
        }
        let r = e
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
        let e = make_engine().await;
        // entity 박음
        if let Some(entity) = &e.entity {
            entity
                .save_entity(SaveEntityInput {
                    name: "테스트".to_string(),
                    entity_type: "stock".to_string(),
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        // limits.entities=0 박으면 entity 검색 skip
        let r = e
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
}
