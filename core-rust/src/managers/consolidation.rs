//! ConsolidationManager — 메모리 4-tier Phase 4 (자동 누적 엔진).
//!
//! 옛 TS `core/managers/consolidation-manager.ts` Rust 재구현 (Phase B-12 minimum).
//!
//! Phase B-12 minimum:
//! - save_extracted — 미리 추출된 entity / fact / event JSON 일괄 저장 (+entityName 자동 매핑)
//! - get_memory_stats — 4-tier 통계 (총수 + byType 분포)
//! - cleanup_expired — 만료 fact/event 일괄 정리
//!
//! Phase B-16+ 후속: LLM 자동 추출 (consolidate_conversation) 활성 — AiManager + ILlmPort 박힌 후.
//! 옛 TS 의 EXTRACTION_PROMPT + askLlmText + JSON 파싱 패턴 그대로 재현.

use std::collections::HashMap;
use std::sync::Arc;

use crate::managers::ai::AiManager;
use crate::managers::conversation::ConversationManager;
use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::ports::{
    IVaultPort, InfraResult, LlmCallOpts, SaveEntityInput, SaveEventInput, SaveFactInput,
};

/// AI Assistant model 의 default — Vault `system:ai-router:model` 미박힘 시 폴백.
/// 옛 TS AI_ASSISTANT_MODELS[0] (gemini-3.1-flash-lite-preview / gpt-5-nano 같은 싼 fast 모델).
const AI_ASSISTANT_DEFAULT_MODEL: &str = "gpt-5-nano";

/// 옛 TS EXTRACTION_PROMPT Rust port — 대화 → entity / fact / event JSON 추출 instruction.
const EXTRACTION_PROMPT: &str = r#"당신은 대화 메모리 정리 도우미입니다. 다음 대화를 읽고 추적할 가치 있는 정보를 JSON 으로 추출하세요.

추출 카테고리:
1. **entities** (추적 대상): 종목·인물·프로젝트·개념·이벤트. 대화에 명시 등장한 것만.
   - name: 정식 명칭 (한국어 / 영어 OK)
   - type: stock / company / person / project / concept / event 자유
   - aliases: 별칭·약자 (선택, 배열)
   - metadata: ticker / industry / sector 같은 부가 (선택, 객체)

2. **facts** (사실): entity 에 link 된 시간 stamped 사실.
   - entityName: 어느 entity 의 fact (entities 의 name 과 일치)
   - content: 자연어 1-2 문장 — 시간·수치·결과 명시
   - factType: recommendation / transaction / analysis / observation / event / report 자유
   - occurredAt: ms epoch (대화에서 명확한 시간 언급 시. 미박혀있으면 미포함)
   - tags: 자유 태그 (배열)

3. **events** (사건): 시간순 사건. 사용자 액션·자동매매·발행·트리거 등.
   - type: cron_trigger / page_publish / transaction / user_action / analysis 자유
   - title: 짧은 요약
   - description: 상세 (선택)
   - occurredAt: ms epoch
   - entityNames: link 할 entity 이름 배열

추출 안 할 것:
- 잡담·인사·기술 질문
- 추측·가정 (확인 안 된)
- 메타 발화 (모델 변경·설정 같은 시스템 운영)

JSON 응답 형식 (정확히 이 구조, 그 외 텍스트 금지):
{"entities": [...], "facts": [...], "events": [...]}

빈 카테고리는 빈 배열.

대화:
"#;

/// 메시지 1개당 trim 한도 (옛 TS 와 동일 — 1500자).
const MESSAGE_TRIM_LIMIT: usize = 1500;
/// 최소 transcript 길이 — 너무 짧으면 추출 안 함.
const MIN_TRANSCRIPT_LEN: usize = 50;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractedEntity {
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractedFact {
    #[serde(rename = "entityName")]
    pub entity_name: String,
    pub content: String,
    #[serde(rename = "factType", default, skip_serializing_if = "Option::is_none")]
    pub fact_type: Option<String>,
    #[serde(rename = "occurredAt", default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "occurredAt", default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<i64>,
    #[serde(rename = "entityNames", default)]
    pub entity_names: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ExtractionResult {
    #[serde(default)]
    pub entities: Vec<ExtractedEntity>,
    #[serde(default)]
    pub facts: Vec<ExtractedFact>,
    #[serde(default)]
    pub events: Vec<ExtractedEvent>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ConsolidationOutcome {
    pub extracted: ExtractionResult,
    pub saved: SavedIds,
    pub skipped: usize,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SavedIds {
    pub entities: Vec<SavedEntity>,
    pub facts: Vec<SavedFact>,
    pub events: Vec<SavedEvent>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SavedEntity {
    pub id: i64,
    pub name: String,
    pub created: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SavedFact {
    pub id: i64,
    #[serde(rename = "entityId")]
    pub entity_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SavedEvent {
    pub id: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct MemoryStats {
    pub entities: i64,
    pub facts: i64,
    pub events: i64,
    #[serde(rename = "entitiesByType")]
    pub entities_by_type: Vec<(String, i64)>,
    #[serde(rename = "eventsByType")]
    pub events_by_type: Vec<(String, i64)>,
}

pub struct ConsolidationManager {
    entity_mgr: Arc<EntityManager>,
    episodic_mgr: Arc<EpisodicManager>,
    /// AI hook (옵션, 늦게 박을 수 있게 Mutex) — consolidate_conversation 의 LLM 자동 추출.
    /// 미박힘 시 LLM 추출 비활성, save_extracted 만 가능.
    /// AiManager 박힌 후 set_ai_hook 으로 박음 (Arc 안에서도 가능).
    ai_hook: std::sync::Mutex<Option<ConsolidationAiHook>>,
}

/// AI 의존성 묶음 — ConversationManager (대화 fetch) + AiManager (LLM 호출) + Vault (AI Assistant
/// model lookup). consolidate_conversation 의 비용 절감 — 메인 채팅 모델 (Claude Sonnet) 가 아니라
/// AI Assistant 의 fast/cheap 모델 (gpt-5-nano / gemini-flash-lite, ~$0.001/대화).
#[derive(Clone)]
pub struct ConsolidationAiHook {
    pub ai: Arc<AiManager>,
    pub conversation: Arc<ConversationManager>,
    pub vault: Arc<dyn IVaultPort>,
}

impl ConsolidationManager {
    pub fn new(entity_mgr: Arc<EntityManager>, episodic_mgr: Arc<EpisodicManager>) -> Self {
        Self {
            entity_mgr,
            episodic_mgr,
            ai_hook: std::sync::Mutex::new(None),
        }
    }

    /// AI hook 박음 — consolidate_conversation 의 LLM 자동 추출 활성.
    /// AiManager 박힌 후 호출 (Arc 안에서도 OK — Mutex 박힘).
    pub fn set_ai_hook(
        &self,
        ai: Arc<AiManager>,
        conversation: Arc<ConversationManager>,
        vault: Arc<dyn IVaultPort>,
    ) {
        let mut guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(ConsolidationAiHook { ai, conversation, vault });
    }

    /// 대화 1개 자동 정리 — 옛 TS consolidateConversation 1:1 port.
    /// 1. 대화 fetch
    /// 2. 메시지 → transcript (사용자/AI 만, 1500자 trim)
    /// 3. AiManager.ask_text(EXTRACTION_PROMPT + transcript) — JSON 응답
    /// 4. JSON 파싱 (코드 블록 fence 제거)
    /// 5. save_extracted 위임
    pub async fn consolidate_conversation(
        &self,
        owner: &str,
        conv_id: &str,
        model_id: Option<&str>,
    ) -> InfraResult<ConsolidationOutcome> {
        let hook = {
            let guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        let Some(hook) = hook else {
            return Err("ConsolidationAiHook 미박음 — set_ai_hook 으로 AiManager + ConversationManager 박아야 LLM 자동 추출 활성".to_string());
        };

        // AI Assistant 토글 검사 — `system:ai-router:enabled` 가 false 면 자동 추출 skip.
        // 사용자가 의식적으로 끄면 매 6시간 cron 자동 호출도 비활성 (비용 통제 + 의도 존중).
        // 어드민이 직접 trigger 시 — model_id 명시 박았으면 토글 무시 (manual override).
        if model_id.is_none() {
            let enabled = hook
                .vault
                .get_secret("system:ai-router:enabled")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false); // default off (옛 TS 와 동일)
            if !enabled {
                return Ok(ConsolidationOutcome {
                    extracted: ExtractionResult::default(),
                    saved: SavedIds::default(),
                    skipped: 0,
                });
            }
        }

        // 1. 대화 fetch
        let conv = hook
            .conversation
            .get(owner, conv_id)
            .ok_or_else(|| format!("대화 없음: {}", conv_id))?;
        let messages = conv
            .messages
            .as_array()
            .ok_or_else(|| "messages 가 array 아님".to_string())?;
        if messages.len() < 2 {
            return Ok(ConsolidationOutcome::default());
        }

        // 2. transcript 변환
        let transcript = format_transcript(messages);
        if transcript.len() < MIN_TRANSCRIPT_LEN {
            return Ok(ConsolidationOutcome::default());
        }

        // 3. LLM 호출 — model_id 미박힘 시 AI Assistant model 자동 사용 (메인 채팅 모델 X).
        // Vault `system:ai-router:model` (default gpt-5-nano) → 메인 채팅 모델 (Claude Sonnet 등)
        // 가 아니라 fast/cheap 모델로 비용 절감 (~$0.001/대화).
        let resolved_model = model_id.map(String::from).or_else(|| {
            hook.vault
                .get_secret("system:ai-router:model")
                .filter(|v| !v.is_empty())
        });
        let full_prompt = format!("{}\n{}", EXTRACTION_PROMPT, transcript);
        let opts = LlmCallOpts {
            model: Some(
                resolved_model.unwrap_or_else(|| AI_ASSISTANT_DEFAULT_MODEL.to_string()),
            ),
            thinking_level: Some("minimal".to_string()),
            ..Default::default()
        };
        let response_text = hook
            .ai
            .ask_text(&full_prompt, &opts)
            .await
            .map_err(|e| format!("LLM 호출 실패: {e}"))?;

        // 4. JSON 파싱 (코드 블록 fence 제거)
        let cleaned = strip_json_fence(&response_text);
        let extracted: ExtractionResult = match serde_json::from_str(&cleaned) {
            Ok(v) => v,
            Err(_) => return Ok(ConsolidationOutcome::default()),
        };

        // 5. save_extracted 위임 (이미 박힌 메서드)
        self.save_extracted(extracted, Some(conv_id), Some(0.92), Some(0.92))
    }

    /// 미리 추출된 JSON → entity / fact / event 일괄 save.
    /// LLM 추출은 Phase B-16+ AiManager 박힌 후 활성. 이 메서드는 그 시점에도 그대로 재사용.
    pub fn save_extracted(
        &self,
        extracted: ExtractionResult,
        source_conv_id: Option<&str>,
        fact_dedup_threshold: Option<f64>,
        event_dedup_threshold: Option<f64>,
    ) -> InfraResult<ConsolidationOutcome> {
        let mut saved = SavedIds::default();
        let mut skipped: usize = 0;
        let mut entity_id_by_name: HashMap<String, i64> = HashMap::new();

        // 1. Entities — saveEntity 가 upsert 라 중복 자연 처리
        for e in &extracted.entities {
            if e.name.trim().is_empty() || e.entity_type.trim().is_empty() {
                skipped += 1;
                continue;
            }
            match self.entity_mgr.save_entity(SaveEntityInput {
                name: e.name.clone(),
                entity_type: e.entity_type.clone(),
                aliases: e.aliases.clone(),
                metadata: e.metadata.clone(),
                source_conv_id: source_conv_id.map(String::from),
            }) {
                Ok((id, created)) => {
                    entity_id_by_name.insert(e.name.clone(), id);
                    saved.entities.push(SavedEntity {
                        id,
                        name: e.name.clone(),
                        created,
                    });
                }
                Err(_) => skipped += 1,
            }
        }

        // 2. Facts — entityName 으로 entity 조회 (캐시 우선, 없으면 find_entity_by_name)
        for f in &extracted.facts {
            if f.entity_name.trim().is_empty() || f.content.trim().is_empty() {
                skipped += 1;
                continue;
            }
            let entity_id = match entity_id_by_name.get(&f.entity_name).copied() {
                Some(id) => Some(id),
                None => match self.entity_mgr.find_entity_by_name(&f.entity_name) {
                    Ok(Some(rec)) => {
                        entity_id_by_name.insert(f.entity_name.clone(), rec.id);
                        Some(rec.id)
                    }
                    _ => None,
                },
            };
            let Some(entity_id) = entity_id else {
                skipped += 1;
                continue;
            };
            match self.entity_mgr.save_fact(SaveFactInput {
                entity_id,
                content: f.content.clone(),
                fact_type: f.fact_type.clone(),
                occurred_at: f.occurred_at,
                tags: f.tags.clone(),
                source_conv_id: source_conv_id.map(String::from),
                ttl_days: None,
                dedup_threshold: fact_dedup_threshold,
            }) {
                Ok((id, was_skipped, _)) => {
                    if was_skipped {
                        skipped += 1;
                    } else {
                        saved.facts.push(SavedFact {
                            id,
                            entity_id,
                            content: f.content.clone(),
                        });
                    }
                }
                Err(_) => skipped += 1,
            }
        }

        // 3. Events — entity_names → entity_ids 변환
        for ev in &extracted.events {
            if ev.event_type.trim().is_empty() || ev.title.trim().is_empty() {
                skipped += 1;
                continue;
            }
            let mut entity_ids: Vec<i64> = Vec::new();
            for name in &ev.entity_names {
                if let Some(id) = entity_id_by_name.get(name).copied() {
                    entity_ids.push(id);
                } else if let Ok(Some(rec)) = self.entity_mgr.find_entity_by_name(name) {
                    entity_id_by_name.insert(name.clone(), rec.id);
                    entity_ids.push(rec.id);
                }
            }
            match self.episodic_mgr.save_event(SaveEventInput {
                event_type: ev.event_type.clone(),
                title: ev.title.clone(),
                description: ev.description.clone(),
                who: None,
                context: None,
                occurred_at: ev.occurred_at,
                entity_ids,
                source_conv_id: source_conv_id.map(String::from),
                ttl_days: None,
                dedup_threshold: event_dedup_threshold,
            }) {
                Ok((id, was_skipped, _)) => {
                    if was_skipped {
                        skipped += 1;
                    } else {
                        saved.events.push(SavedEvent {
                            id,
                            event_type: ev.event_type.clone(),
                            title: ev.title.clone(),
                        });
                    }
                }
                Err(_) => skipped += 1,
            }
        }

        Ok(ConsolidationOutcome {
            extracted,
            saved,
            skipped,
        })
    }

    /// 어드민 health stats — 4-tier 누적 상태 표시용.
    pub fn get_memory_stats(&self) -> InfraResult<MemoryStats> {
        Ok(MemoryStats {
            entities: self.entity_mgr.count_entities()?,
            facts: self.entity_mgr.count_facts()?,
            events: self.episodic_mgr.count_events()?,
            entities_by_type: self.entity_mgr.count_entities_by_type()?,
            events_by_type: self.episodic_mgr.count_events_by_type()?,
        })
    }

    /// 24시간 cron 호출용 — 만료 fact + event 일괄 정리.
    pub fn cleanup_all_expired(&self) -> InfraResult<(i64, i64)> {
        let facts = self.entity_mgr.cleanup_expired()?;
        let events = self.episodic_mgr.cleanup_expired()?;
        Ok((facts, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::memory::SqliteMemoryAdapter;
    use crate::ports::{IEntityPort, IEpisodicPort};

    fn manager() -> ConsolidationManager {
        let adapter = Arc::new(SqliteMemoryAdapter::new_in_memory().unwrap());
        let entity_port: Arc<dyn IEntityPort> = adapter.clone();
        let episodic_port: Arc<dyn IEpisodicPort> = adapter;
        let entity_mgr = Arc::new(EntityManager::new(entity_port));
        let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
        ConsolidationManager::new(entity_mgr, episodic_mgr)
    }

    #[test]
    fn save_extracted_creates_entities_and_facts() {
        let mgr = manager();
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
            .unwrap();
        assert_eq!(outcome.saved.entities.len(), 1);
        assert_eq!(outcome.saved.facts.len(), 1);
        assert_eq!(outcome.saved.events.len(), 1);
        assert_eq!(outcome.skipped, 0);
    }

    #[test]
    fn missing_entity_name_skips_fact() {
        let mgr = manager();
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
        let outcome = mgr.save_extracted(extracted, None, None, None).unwrap();
        assert_eq!(outcome.saved.facts.len(), 0);
        assert_eq!(outcome.skipped, 1);
    }

    #[test]
    fn memory_stats_aggregates() {
        let mgr = manager();
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
        mgr.save_extracted(extracted, None, None, None).unwrap();
        let stats = mgr.get_memory_stats().unwrap();
        assert_eq!(stats.entities, 2);
        assert_eq!(stats.events, 1);
        assert!(stats.entities_by_type.iter().any(|(t, c)| t == "stock" && *c == 1));
    }
}

/// 메시지 배열 → LLM 입력용 transcript. 사용자/AI 만, 1500자 trim.
fn format_transcript(messages: &[serde_json::Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let role_label = match role {
            "user" => "사용자",
            "assistant" => "AI",
            _ => continue,
        };
        let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if content.trim().is_empty() {
            continue;
        }
        let truncated = if content.chars().count() > MESSAGE_TRIM_LIMIT {
            let prefix: String = content.chars().take(MESSAGE_TRIM_LIMIT).collect();
            format!("{prefix}...(생략)")
        } else {
            content.to_string()
        };
        lines.push(format!("{role_label}: {truncated}"));
    }
    lines.join("\n\n")
}

/// ```json ... ``` 코드 블록 fence 제거. JSON 파싱 직전 호출.
fn strip_json_fence(raw: &str) -> String {
    let trimmed = raw.trim();
    // ```json ... ``` 또는 ``` ... ``` 매칭
    if let Some(rest) = trimmed.strip_prefix("```json") {
        if let Some(inner) = rest.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        if let Some(inner) = rest.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }
    trimmed.to_string()
}

impl Default for ExtractedEntity {
    fn default() -> Self {
        Self {
            name: String::new(),
            entity_type: String::new(),
            aliases: vec![],
            metadata: None,
        }
    }
}
