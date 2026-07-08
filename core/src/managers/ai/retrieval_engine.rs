//! RetrievalEngine — 통합 회상(retrieval): history + Recall(엔티티·사실·사건) + Library 병렬 검색.
//!
//! 사용자 query → 병렬 검색 (history + entities + events + entity_facts) → 통합
//! contextSummary 반환. AiManager 가 시스템 프롬프트에 `<RETRIEVED_CONTEXT>` 섹션 prepend.
//!
//! vs HistoryResolver:
//!   - HistoryResolver: search_history 만 (대화 raw, spread 판정)
//!   - RetrievalEngine: 통합 회상 (history + Recall + Library). HistoryResolver 결과
//!     포함 후 entity/event/fact 추가.
//!
//! Token budget — limits 설정되어 있으면 그대로, 미설정 시 default. 빈 결과 자동 skip.
//! 도메인 무관 — 4 source 검색 후 통합 (사용자 워크플로우 별 추상화 X).

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::managers::conversation::{ConversationManager, SearchHistoryOpts};
use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::managers::library::LibraryManager;
use crate::ports::{
    EntityFactRecord, EntitySearchOpts, EventSearchOpts, FactSearchOpts, LibraryHit, TimelineOpts,
};

/// 매 source 별 limit. 옛 TS `RetrievalLimits` 1:1.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// library_chunks 영역 매치 (default 5) — Phase 1 (2026-05-17 신설).
    /// 매 Reference 영역 의 매 chunk 영역 cosine 매치 → top-K.
    pub library: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalStats {
    pub history: usize,
    pub entities: usize,
    pub facts: usize,
    pub events: usize,
    pub library: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    /// 통합 컨텍스트 — system prompt prepend 용. 빈 문자열이면 모든 source 0.
    #[serde(rename = "contextSummary")]
    pub context_summary: String,
    /// 디버그 — 각 source 의 매칭 수
    pub stats: RetrievalStats,
    /// Library 매치된 hit 영역 (Phase 1 단계 8.4, 2026-05-17) — 답변 외부에 SourceTags
    /// 뱃지로 노출. context_summary 안에 텍스트로 들어간 `[Source: ...]` 와 별개로 metadata 로 전달.
    /// 답변 본문에는 인용 표기 하지 마라는 시스템 prompt 룰과 짝.
    #[serde(rename = "libraryHits", default)]
    pub library_hits: Vec<LibraryHit>,
}

#[derive(Debug, Clone, Default)]
pub struct RetrieveOpts {
    pub query: String,
    pub owner: Option<String>,
    pub current_conv_id: Option<String>,
    pub limits: RetrievalLimits,
    /// Library 검색 영역 제한 — 명시되면 그 Reference ID 만 cosine 매치 대상.
    /// 빈 Vec 또는 None = 무제한 (옛 admin 흐름 — owner 영역 전체 Reference).
    /// hub 컨텍스트 안에서 instance.allowed_references 만 검색하기 위함.
    pub reference_filter: Option<Vec<String>>,
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
    library: Option<Arc<LibraryManager>>,
    /// 섀도우 임베더 (Upstage 등) — 운영엔 안 쓰고, history 회상 결과를 같은 쿼리로 병렬 재임베딩해
    /// E5 vs 섀도우 순위·점수를 로그로 비교(A/B 평가 전용, 2026-07 무료기간). None = 비활성.
    shadow: Option<Arc<dyn crate::ports::IEmbedderPort>>,
}

impl RetrievalEngine {
    pub fn new() -> Self {
        Self {
            conversation: None,
            entity: None,
            episodic: None,
            library: None,
            shadow: None,
        }
    }

    /// 섀도우 임베더 주입 — history 회상 A/B 비교 로그 활성. 운영 임베딩(E5)엔 영향 0.
    pub fn with_shadow(mut self, shadow: Arc<dyn crate::ports::IEmbedderPort>) -> Self {
        self.shadow = Some(shadow);
        self
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

    /// Library 영역 (Phase 1, 2026-05-17) — 매 query 시점 매 Reference 영역 의 매 chunk 영역
    /// cosine 매치 → top-K → `<LIBRARY_CONTEXT>` 영역 prepend.
    pub fn with_library(mut self, library: Arc<LibraryManager>) -> Self {
        self.library = Some(library);
        self
    }

    /// 라이브러리 얇은 인덱스(이름+설명) — 자동주입(청크) 대신 상시 노출용. AI 가 보고 search_library 결정.
    /// owner 자료 + extra_ids(hub allowed_references = admin 공유) 병합. library 미설정 시 None.
    pub async fn library_index(&self, owner: &str, extra_ids: &[String]) -> Option<String> {
        let lib = self.library.as_ref()?;
        lib.index(owner, extra_ids)
            .await
            .ok()
            .filter(|s| !s.trim().is_empty())
    }

    /// Tracked-entities thin index for `<TRACKED_ENTITIES>` per-turn injection — graph
    /// self-steering (mirrors `library_index`): the model sees what recall already tracks so it
    /// reuses factType labels, supersedes state updates, and records subjects of similar kinds.
    /// Cheap: empty-query listing (no embeddings). None when no entity handle or empty graph.
    pub async fn entity_index(&self, owner: &str) -> Option<String> {
        let entity = self.entity.as_ref()?;
        let ents = entity
            .search_entities(crate::ports::EntitySearchOpts {
                query: String::new(),
                entity_type: None,
                limit: Some(50),
                offset: None,
                owner: Some(owner.to_string()),
            })
            .await
            .ok()?;
        if ents.is_empty() {
            return None;
        }
        let fact_types = entity.list_fact_types(Some(owner)).unwrap_or_default();
        // Active values per subject (promoted only — TimelineOpts default excludes staging/
        // superseded) so the model can spot when a new figure is a CORRECTION of a tracked
        // state — supersede judgment needs the incumbent value. Capped 3/entity.
        let mut facts_by_entity: std::collections::HashMap<
            i64,
            Vec<crate::ports::EntityFactRecord>,
        > = std::collections::HashMap::new();
        for e in &ents {
            if let Ok(facts) = entity.get_entity_timeline(
                e.id,
                crate::ports::TimelineOpts {
                    limit: Some(3),
                    owner: Some(owner.to_string()),
                    ..Default::default()
                },
            ) {
                if !facts.is_empty() {
                    facts_by_entity.insert(e.id, facts);
                }
            }
        }
        let body =
            crate::managers::entity::format_entity_index(&ents, &fact_types, &facts_by_entity);
        if body.trim().is_empty() {
            None
        } else {
            Some(body)
        }
    }

    /// 사용자 query → 4 source 병렬 검색 → 통합 contextSummary.
    /// 옛 TS retrieve(opts) 1:1.
    pub async fn retrieve(&self, opts: &RetrieveOpts) -> RetrievalResult {
        let query = opts.query.trim();
        if query.is_empty() {
            return RetrievalResult::default();
        }

        // limits resolve — opts.limits 우선, 미설정 시 default.
        let lim = ResolvedLimits {
            history: opts.limits.history.unwrap_or(5),
            entities: opts.limits.entities.unwrap_or(3),
            facts: opts.limits.facts.unwrap_or(5),
            events: opts.limits.events.unwrap_or(5),
            facts_per_entity: opts.limits.facts_per_entity.unwrap_or(3),
            library: opts.limits.library.unwrap_or(5),
        };

        // 5 source 병렬 검색 — tokio::join! (Promise.all 1:1)
        // Library 영역 (Phase 1, 2026-05-17) — admin 영역 모든 Reference 영역 cosine 매치.
        // 옛 chat 영역 = 매 Reference 자동 검색 (사용자 결정 영역 = 통합 영역).
        let history_fut = self.search_history_safe(query, opts, &lim);
        let entities_fut = self.search_entities_safe(query, opts.owner.as_deref(), &lim);
        let facts_fut = self.search_facts_safe(query, opts.owner.as_deref(), &lim);
        let events_fut = self.search_events_safe(query, opts.owner.as_deref(), &lim);
        let library_fut = self.search_library_safe(query, opts, &lim);
        let (history, entities, facts, events, library_hits) =
            tokio::join!(history_fut, entities_fut, facts_fut, events_fut, library_fut);

        // 섀도우 A/B — history 회상 결과를 Upstage 등으로 병렬 재임베딩해 E5 와 순위·점수 비교(백그라운드,
        // 턴 지연 0). 운영은 위 E5 결과 그대로 사용. 섀도우 미주입(운영 기본) 시 no-op.
        if let (Some(shadow), false) = (&self.shadow, history.is_empty()) {
            Self::spawn_shadow_history_compare(shadow.clone(), query.to_string(), &history);
        }

        let mut sections: Vec<String> = Vec::new();
        let mut stats = RetrievalStats::default();

        // 1) Conversation history
        if !history.is_empty() {
            stats.history = history.len();
            let mut lines = vec![format!("[Related past conversations ({})]", history.len())];
            for m in &history {
                let role_label = if m.role == "user" { "User" } else { "AI" };
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
                                owner: opts.owner.clone(), // hub 턴이면 그 owner 로 — admin 타임라인 누출 방지
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

        // 5) Library — Phase 1 (2026-05-17). 매 chunk cosine 매치 결과 + Source / page 명시 (citation).
        //    AI 답변 시점에 인용 부분을 표기 (사용자 fact-check 용).
        if !library_hits.is_empty() {
            stats.library = library_hits.len();
            let mut lines = vec![format!("[관련 자료 ({}건)]", library_hits.len())];
            for h in &library_hits {
                let page_label = h
                    .page_number
                    .map(|p| format!(", p.{}", p))
                    .unwrap_or_default();
                lines.push(format!(
                    "- [Source: {} ({}{}), score={:.3}]",
                    h.source_name, h.reference_name, page_label, h.score
                ));
                let preview = slice_chars(&h.content, 300);
                lines.push(format!("    {}", preview));
            }
            sections.push(lines.join("\n"));
        }

        if sections.is_empty() {
            return RetrievalResult {
                context_summary: String::new(),
                stats,
                library_hits,
            };
        }

        let context_summary = format!(
            "<RETRIEVED_CONTEXT>\n{}\n</RETRIEVED_CONTEXT>",
            sections.join("\n\n")
        );
        RetrievalResult {
            context_summary,
            stats,
            library_hits,
        }
    }

    /// 섀도우 A/B (백그라운드) — E5 가 뽑은 history 후보를 shadow 임베더로 같은 쿼리 재임베딩 →
    /// shadow 공간 cosine 재순위 → E5 순위·점수 vs shadow 순위·점수를 한 줄 JSON 으로 로그
    /// (target="embed_shadow"). `journalctl -u firebat | grep embed_shadow` 로 비교. 운영 무영향.
    fn spawn_shadow_history_compare(
        shadow: Arc<dyn crate::ports::IEmbedderPort>,
        query: String,
        history: &[crate::managers::conversation::HistorySearchMatch],
    ) {
        // 후보 = (미리보기, E5 점수, E5 순위) — history 는 이미 E5 점수 내림차순.
        let cands: Vec<(String, f32)> = history
            .iter()
            .map(|h| (h.content_preview.chars().take(120).collect::<String>(), h.score))
            .collect();
        tokio::spawn(async move {
            let qv = match shadow.embed_query(&query).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(target: "embed_shadow", error = %e, "shadow embed_query failed");
                    return;
                }
            };
            // 각 후보를 shadow 로 임베딩 → shadow cosine.
            let mut rows: Vec<(usize, String, f32, f32)> = Vec::with_capacity(cands.len());
            for (e5_rank, (preview, e5_score)) in cands.iter().enumerate() {
                let pv = match shadow.embed_passage(preview).await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(target: "embed_shadow", error = %e, "shadow embed_passage failed");
                        return;
                    }
                };
                let up = shadow.cosine(&qv, &pv);
                rows.push((e5_rank, preview.clone(), *e5_score, up));
            }
            // shadow 점수 내림차순 = shadow 순위.
            let mut by_up: Vec<usize> = (0..rows.len()).collect();
            by_up.sort_by(|&a, &b| rows[b].3.partial_cmp(&rows[a].3).unwrap_or(std::cmp::Ordering::Equal));
            let mut up_rank_of = vec![0usize; rows.len()];
            for (up_rank, &idx) in by_up.iter().enumerate() {
                up_rank_of[idx] = up_rank;
            }
            let items: Vec<serde_json::Value> = rows
                .iter()
                .enumerate()
                .map(|(i, (e5_rank, preview, e5_score, up_score))| {
                    serde_json::json!({
                        "preview": preview,
                        "e5_rank": e5_rank,
                        "e5_score": (*e5_score * 1000.0).round() / 1000.0,
                        "up_rank": up_rank_of[i],
                        "up_score": (*up_score * 1000.0).round() / 1000.0,
                    })
                })
                .collect();
            let payload = serde_json::json!({
                "query": query,
                "shadow": shadow.version(),
                "results": items,
            });
            tracing::info!(target: "embed_shadow", data = %payload, "history A/B");
        });
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
        owner: Option<&str>,
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
                owner: owner.map(String::from), // 누락 시 adapter 가 'admin' 기본 → hub 턴이 admin 엔티티 읽던 root
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
        owner: Option<&str>,
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
                owner: owner.map(String::from), // 누락 시 adapter 가 'admin' 기본 → hub 턴이 admin 사실 읽던 root
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
        owner: Option<&str>,
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
                owner: owner.map(String::from), // 누락 시 adapter 가 'admin' 기본 → hub 턴이 admin 이벤트 읽던 root
                ..Default::default()
            })
            .await
        {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }

    /// Library 영역 (Phase 1, 2026-05-17) — 매 query 시점 admin 영역 매 Reference 영역
    /// 의 매 chunk 영역 cosine 매치 → top library.
    async fn search_library_safe(
        &self,
        query: &str,
        opts: &RetrieveOpts,
        lim: &ResolvedLimits,
    ) -> Vec<crate::ports::LibraryHit> {
        if lim.library == 0 {
            return Vec::new();
        }
        let Some(library) = &self.library else {
            return Vec::new();
        };
        let owner = opts.owner.as_deref().unwrap_or("admin");
        // hub = 본인(owner) 자료 ∪ admin 공유(allowed_references). MCP search_library 와 동일 패리티.
        //   - None(admin) = owner 전체 Reference (옛 흐름)
        //   - Some(N)(hub) = 본인 owner 전체 + 공유 ID N 개 병합 (위젯 챗봇이 본인+admin 지식베이스 둘 다)
        //   - Some(빈)(hub, 공유 0) = 본인 것만 (옛엔 Some(empty)→0 이라 본인 자료도 검색 안 되던 버그)
        let mut hits = library
            .search(owner, &[], query, lim.library)
            .await
            .unwrap_or_default();
        if let Some(ids) = &opts.reference_filter {
            if !ids.is_empty() {
                let shared = library
                    .search(owner, ids, query, lim.library)
                    .await
                    .unwrap_or_default();
                hits.extend(shared);
                hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                hits.truncate(lim.library);
            }
        }
        hits
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
    library: usize,
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
