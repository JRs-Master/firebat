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

use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::ports::{InfraResult, SaveEntityInput, SaveEventInput, SaveFactInput};

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
}

impl ConsolidationManager {
    pub fn new(entity_mgr: Arc<EntityManager>, episodic_mgr: Arc<EpisodicManager>) -> Self {
        Self {
            entity_mgr,
            episodic_mgr,
        }
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
