//! RetrievalEngine — 메모리 시스템 4-tier 통합 검색.
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
//! 도메인 무관 — 4 source 검색 후 통합 (사용자 워크플로우 별 추상화 X).

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

// Tests 이관 — `infra/tests/ai_retrieval_engine_test.rs` (integration test).
// private field (`e.entity`, `e.episodic`) 직접 access 대신 test 가 manager Arc 사본 보존하여
// 검증 — public API 만 사용. inline 유지 0건.
