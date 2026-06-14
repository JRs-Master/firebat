//! ConsolidationManager — Recall, Consolidation engine (자동 누적).
//!
//! 옛 TS `core/managers/consolidation-manager.ts` Rust 재구현 (Phase B-12 minimum).
//!
//! Phase B-12 minimum:
//! - save_extracted — 미리 추출된 entity / fact / event JSON 일괄 저장 (+entityName 자동 매핑)
//! - get_memory_stats — 4-tier 통계 (총수 + byType 분포)
//! - cleanup_expired — 만료 fact/event 일괄 정리
//!
//! Phase B-16+ 후속: LLM 자동 추출 (consolidate_conversation) 활성 — AiManager + ILlmPort 설정된 후.
//! 옛 TS 의 EXTRACTION_PROMPT + askLlmText + JSON 파싱 패턴 그대로 재현.

use std::collections::HashMap;
use std::sync::Arc;

use crate::managers::ai::AiManager;
use crate::managers::conversation::ConversationManager;
use crate::managers::cost::CostManager;
use crate::managers::memory_file::{MemoryEntry, MemoryFileManager};
use crate::ports::{
    IMemoryFacadePort, IVaultPort, InfraResult, LlmCallOpts, SaveEntityInput, SaveEventInput,
    SaveFactInput,
};

/// AI Assistant model 의 default — `llm::registry::assistant_default_model()` (JSON 산출).
/// 옛 `vault_keys::AI_ASSISTANT_DEFAULT_MODEL` const → JSON registry 로 이동 (Phase 5, 2026-05-13).
use crate::vault_keys::{VK_SYSTEM_AI_ASSISTANT_MODEL, VK_SYSTEM_AI_MODEL, VK_SYSTEM_AI_ROUTER_ENABLED};

/// 옛 TS EXTRACTION_PROMPT Rust port — 대화 → entity / fact / event JSON 추출 instruction.
const EXTRACTION_PROMPT: &str = r#"You organize conversation memory. Read the conversation and extract information worth tracking, as JSON.

What to keep — judge by this principle, not by a fixed list of kinds:
- KEEP: stable, re-referenceable information that will help you serve this person better when you encounter it again later.
- SKIP: things that only matter in the moment, unverified guesses, and anything a system already records elsewhere (logs, schedules, the conversation itself).
- SKIP code-internal / technical / implementation conclusions (how a bug was fixed, a component's data format, an API shape) — those belong in code and docs, not this person's memory; and development / build / approval events (bug fixes, page saves, deployments).
- DO NOT generalize from a single mention. Record what was explicitly stated, but never infer a durable identity, habit, or preference from one occurrence — a one-off action is not a pattern. If something is *inferred* (not stated) and appears only once, omit it.
- When uncertain, omit. A missing memory is recoverable by asking again; a wrong one silently misleads future actions. Prefer empty arrays over speculation — precision over recall.
- Write each value from the standpoint of what helps serve this person later, in their own terms — not internal system mechanics (you may not know how the system transforms things downstream; do not assume or describe it).
The four shapes below are *how* to store, not *what* to store — decide what with the principle above. Classify freely; do not force any preset category.

1. **entities** (subjects worth tracking): the *identity* of a recurring subject. An entity is just who/what it is; everything you know about it goes in facts, not here.
   - name: the full canonical name of the subject — never an abbreviation, code/ticker, or the subject combined with an attribute. Keep it identical across mentions, since name plus aliases is the dedup key.
   - aliases: every alternative form of the same subject — abbreviations, codes, alternate spellings, language variants. Put each here so later mentions merge into one entity instead of creating duplicates.
   - metadata: optional object of attributes

2. **facts** (statements linked to an entity — this is where classification lives):
   - entityName: which entity (matches a name in entities)
   - content: 1-2 natural sentences — state time, figures, outcome when present
   - factType: the kind of statement — this is how an entity's facts are grouped. Reuse the same label for the same kind so they group together; keep it consistent across mentions.
   - occurredAt: ms epoch (only when a clear time is stated; omit otherwise)
   - tags: optional array for cross-cutting labels that span fact types. A fact may carry several.

3. **events** (something that happened or is scheduled at a point in time and is worth recalling later):
   - type: free-form classification natural to the event
   - title: short summary
   - description: optional detail
   - occurredAt: ms epoch
   - entityNames: array of linked entity names

4. **lessons** (durable operational knowledge — preferences and ways of working that will apply again):
   - name: short kebab-case slug (also the filename and dedup key)
   - category: one of user / feedback / project / reference
   - description: one-line summary (shown in the index — keep it self-sufficient)
   - content: the reusable lesson / how-to body

**Language — IMPORTANT**: this extracted content is shown to the user, so write every human-readable value in {LANG}: entity `name` (use its {LANG} form when the subject has one — but keep proper codes/tickers as `aliases`), fact `content`, event `title`/`description`, lesson `description`/`content`, and `factType`/`type` labels. Keep these EXACTLY as-is regardless of language: lesson `category` (must stay one of user / feedback / project / reference), lesson `name` (kebab-case ascii slug — it is the filename and dedup key), `aliases` (codes / tickers / alternate spellings), and all JSON keys.

Response format (exactly this structure, no other text):
{"entities": [...], "facts": [...], "events": [...], "lessons": [...]}

Empty categories must be empty arrays.

Conversation:
"#;

/// 메시지 1개당 trim 한도 (옛 TS 와 동일 — 1500자).
const MESSAGE_TRIM_LIMIT: usize = 1500;
/// 최소 transcript 길이 — 너무 짧으면 추출 안 함.
const MIN_TRANSCRIPT_LEN: usize = 50;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntity {
    pub name: String,
    // 엔티티 = 정체성(이름+별칭). 분류는 사실 type/태그에. type 은 휴면(선택) — 없으면 빈 문자열.
    #[serde(rename = "type", default)]
    pub entity_type: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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

/// 운영 교훈 (data/memory 로 저장) — entity/fact 와 별개로 MemoryFileManager 에 누적.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedLesson {
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    #[serde(default)]
    pub entities: Vec<ExtractedEntity>,
    #[serde(default)]
    pub facts: Vec<ExtractedFact>,
    #[serde(default)]
    pub events: Vec<ExtractedEvent>,
    #[serde(default)]
    pub lessons: Vec<ExtractedLesson>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationOutcome {
    pub extracted: ExtractionResult,
    pub saved: SavedIds,
    pub skipped: usize,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedIds {
    pub entities: Vec<SavedEntity>,
    pub facts: Vec<SavedFact>,
    pub events: Vec<SavedEvent>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedEntity {
    pub id: i64,
    pub name: String,
    pub created: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFact {
    pub id: i64,
    #[serde(rename = "entityId")]
    pub entity_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedEvent {
    pub id: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
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
    /// Recall facade — Entity + Episodic 통합 port (BIBLE 매니저 간 직접 호출 금지 정정).
    /// 옛 `entity_mgr` + `episodic_mgr` 직접 의존 → trait object 로 추출 (2026-05-06).
    memory: Arc<dyn IMemoryFacadePort>,
    /// AI hook (옵션, 늦게 설정할 수 있게 Mutex) — consolidate_conversation 의 LLM 자동 추출.
    /// 미설정 시 LLM 추출 비활성, save_extracted 만 가능.
    /// AiManager 설정된 후 set_ai_hook 으로 등록 (Arc 안에서도 가능).
    ai_hook: std::sync::Mutex<Option<ConsolidationAiHook>>,
    /// MemoryFileManager (옵션) — extract_exchange 의 운영 교훈(lessons) 저장 대상.
    /// 늦게 바인딩(set_memory_file). 미설정 시 lessons skip (Recall 만 저장).
    memory_file: std::sync::Mutex<Option<Arc<MemoryFileManager>>>,
}

/// AI 의존성 묶음 — ConversationManager (대화 fetch) + AiManager (LLM 호출) + Vault (AI Assistant
/// model lookup). consolidate_conversation 의 비용 절감 — 메인 채팅 모델 (Claude Sonnet 등) 가 아니라
/// AI Assistant 의 fast/cheap 모델 (`vault_keys::AI_ASSISTANT_DEFAULT_MODEL`, ~$0.001/대화).
///
/// `cost` (옵션) — 설정되어 있으면 LLM 호출 전 `check_budget()` 으로 한도 검사. 한도 초과 시 즉시 skip
/// (백그라운드 cron 의 무한 LLM 폭주 차단). 옵션이라 옛 호환 유지 — 미설정 시 옛 동작 그대로.
#[derive(Clone)]
pub struct ConsolidationAiHook {
    pub ai: Arc<AiManager>,
    pub conversation: Arc<ConversationManager>,
    pub vault: Arc<dyn IVaultPort>,
    pub cost: Option<Arc<CostManager>>,
}

impl ConsolidationManager {
    pub fn new(memory: Arc<dyn IMemoryFacadePort>) -> Self {
        Self {
            memory,
            ai_hook: std::sync::Mutex::new(None),
            memory_file: std::sync::Mutex::new(None),
        }
    }

    /// AI hook 저장 — consolidate_conversation 의 LLM 자동 추출 활성.
    /// AiManager 설정된 후 호출 (Arc 안에서도 OK — Mutex 설정).
    /// `cost` 설정되어 있으면 LLM 호출 전 한도 검사 (백그라운드 cron 폭주 차단).
    pub fn set_ai_hook(
        &self,
        ai: Arc<AiManager>,
        conversation: Arc<ConversationManager>,
        vault: Arc<dyn IVaultPort>,
        cost: Option<Arc<CostManager>>,
    ) {
        let mut guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(ConsolidationAiHook { ai, conversation, vault, cost });
    }

    /// MemoryFileManager 설정 — extract_exchange 의 lessons 저장 활성. 미설정 시 lessons skip.
    pub fn set_memory_file(&self, memory_file: Arc<MemoryFileManager>) {
        let mut guard = self.memory_file.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(memory_file);
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
            return Err(crate::i18n::t("core.error.consolidation.hook_unset", None, &[]));
        };

        // AI Assistant 토글 검사 — `system:ai-router:enabled` 가 false 면 자동 추출 skip.
        // 사용자가 의식적으로 끄면 매 6시간 cron 자동 호출도 비활성 (비용 통제 + 의도 존중).
        // 어드민이 직접 trigger 시 — model_id 명시 설정했으면 토글 무시 (manual override).
        if model_id.is_none() {
            let enabled = hook
                .vault
                .get_secret(VK_SYSTEM_AI_ROUTER_ENABLED)
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

        // 예산 가드 — CostManager 설정되어 있으면 한도 검사. 한도 초과 시 즉시 skip
        // (백그라운드 cron 6시간마다 LLM 호출 → API 오류 / 환각 무한 재시도 → 토큰 폭주 차단).
        // 사용자 어드민 trigger (model_id 명시) 도 동일하게 가드 — 비용 폭주는 어떤 trigger 도 동일 위험.
        if let Some(cost) = &hook.cost {
            let check = cost.check_budget();
            if !check.within_budget {
                tracing::warn!(
                    reason = check.reason.as_deref().unwrap_or("한도 초과"),
                    daily_used = check.daily_used_usd,
                    monthly_used = check.monthly_used_usd,
                    "ConsolidationManager: 예산 한도 초과 — consolidate_conversation skip"
                );
                return Ok(ConsolidationOutcome {
                    extracted: ExtractionResult::default(),
                    saved: SavedIds::default(),
                    skipped: 0,
                });
            }
        }

        // 1. 대화 fetch
        let conv = hook.conversation.get(owner, conv_id).ok_or_else(|| {
            crate::i18n::t(
                "core.error.consolidation.conversation_not_found",
                None,
                &[("id", conv_id)],
            )
        })?;
        let messages = conv.messages.as_array().ok_or_else(|| {
            crate::i18n::t("core.error.consolidation.messages_not_array", None, &[])
        })?;
        if messages.len() < 2 {
            return Ok(ConsolidationOutcome::default());
        }

        // 2. transcript 변환
        let transcript = format_transcript(messages);
        if transcript.len() < MIN_TRANSCRIPT_LEN {
            return Ok(ConsolidationOutcome::default());
        }

        // 3. LLM 호출 — model_id 미설정 시 AI Assistant model 자동 사용 (메인 채팅 모델 X).
        // Vault `system:ai-router:model` (default = `vault_keys::AI_ASSISTANT_DEFAULT_MODEL`)
        // → 메인 채팅 모델 (Claude Sonnet 등) 이 아닌 fast/cheap 모델로 비용 절감 (~$0.001/대화).
        // B(dedup) — 기존 운영 메모리 인덱스를 worker 에 보여 lessons 중복 방지(같은 교훈 = 같은 name 갱신).
        let mem_index = {
            let mf = {
                let guard = self.memory_file.lock().unwrap_or_else(|p| p.into_inner());
                guard.clone()
            };
            match mf {
                Some(mf) => {
                    let scope = if owner != "admin" && !owner.is_empty() {
                        Some(owner)
                    } else {
                        None
                    };
                    mf.get_index(scope).await.unwrap_or_default()
                }
                None => String::new(),
            }
        };
        let mem_note = if mem_index.trim().is_empty() {
            String::new()
        } else {
            format!(
                "\n\n[이미 저장된 운영 메모리 — lessons 추출 시 같은 교훈이면 같은 name 으로 갱신(중복 생성 금지)]\n{mem_index}"
            )
        };
        // 추출 결과(엔티티·사실·사건·교훈)는 사용자 노출 콘텐츠라 사용자 설정 언어로 작성하게 지시.
        // (시스템 프롬프트 자체는 영어 유지 — 글로벌 영어 룰. 산출물 산문만 사용자 언어.)
        let lang_code = crate::i18n::current_default_lang();
        let lang_name = match lang_code.as_str() {
            "ko" => "Korean (한국어)",
            "en" => "English",
            _ => lang_code.as_str(),
        };
        let prompt_with_lang = EXTRACTION_PROMPT.replace("{LANG}", lang_name);
        let full_prompt = format!("{}\n{}{}", prompt_with_lang, transcript, mem_note);
        let opts = LlmCallOpts {
            model: Some(resolve_worker_model(hook.vault.as_ref(), model_id)),
            thinking_level: Some("minimal".to_string()),
            ..Default::default()
        };
        let response_text = hook.ai.ask_text(&full_prompt, &opts).await.map_err(|e| {
            crate::i18n::t(
                "core.error.consolidation.llm_call_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;

        // 4. JSON 파싱 (코드 블록 fence 제거)
        let cleaned = strip_json_fence(&response_text);
        let extracted: ExtractionResult = match serde_json::from_str(&cleaned) {
            Ok(v) => v,
            Err(_) => return Ok(ConsolidationOutcome::default()),
        };

        // 5. save_extracted 위임 (이미 설정된 메서드)
        // owner 를 쓰기 경로까지 전달 — hub 대화 정리가 admin scope 로 저장되던 누수(RECALL-2) fix. empty/"admin" → None(admin).
        let scope = if owner != "admin" && !owner.is_empty() { Some(owner) } else { None };
        self.save_extracted(extracted, Some(conv_id), Some(0.92), Some(0.92), scope)
            .await
    }

    /// 미리 추출된 JSON → entity / fact / event 일괄 save.
    /// LLM 추출은 Phase B-16+ AiManager 설정된 후 활성. 이 메서드는 그 시점에도 그대로 재사용.
    pub async fn save_extracted(
        &self,
        extracted: ExtractionResult,
        source_conv_id: Option<&str>,
        fact_dedup_threshold: Option<f64>,
        event_dedup_threshold: Option<f64>,
        owner: Option<&str>, // 추출 entity/fact/event 저장 scope — hub 면 그 owner, admin 이면 None (RECALL-2 cross-tenant write fix)
    ) -> InfraResult<ConsolidationOutcome> {
        let mut saved = SavedIds::default();
        let mut skipped: usize = 0;
        let mut entity_id_by_name: HashMap<String, i64> = HashMap::new();

        // 1. Entities — saveEntity 가 upsert 라 중복 자연 처리
        for e in &extracted.entities {
            // 엔티티 = 이름이 정체성. type 은 휴면(선택)이라 비어도 저장.
            if e.name.trim().is_empty() {
                skipped += 1;
                continue;
            }
            match self
                .memory
                .save_entity(SaveEntityInput {
                    name: e.name.clone(),
                    entity_type: e.entity_type.clone(),
                    aliases: e.aliases.clone(),
                    metadata: e.metadata.clone(),
                    source_conv_id: source_conv_id.map(String::from),
                    dedup_threshold: Some(0.92),
                    owner: owner.map(String::from),
                })
                .await
            {
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
                None => match self.memory.find_entity_by_name(&f.entity_name) {
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
            match self
                .memory
                .save_fact(SaveFactInput {
                    entity_id,
                    content: f.content.clone(),
                    fact_type: f.fact_type.clone(),
                    occurred_at: f.occurred_at,
                    tags: f.tags.clone(),
                    source_conv_id: source_conv_id.map(String::from),
                    ttl_days: None,
                    dedup_threshold: fact_dedup_threshold,
                    owner: owner.map(String::from), // 호출자 owner 전달 — hub 대화 추출물이 admin scope 로 저장되던 것 fix
                })
                .await
            {
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
                } else if let Ok(Some(rec)) = self.memory.find_entity_by_name(name) {
                    entity_id_by_name.insert(name.clone(), rec.id);
                    entity_ids.push(rec.id);
                }
            }
            match self
                .memory
                .save_event(SaveEventInput {
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
                    owner: owner.map(String::from),
                })
                .await
            {
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

        // 4. Lessons → MemoryFileManager (Memory 운영지식). 자동 추출의 Memory 측 백스톱.
        // memory_file 미설정(또는 lessons 없음) 이면 skip. owner scope. name 충돌 시 덮어쓰기.
        // 인라인(메인 모델 memory_save)이 주 경로 — 이건 메인이 놓친 implicit 교훈을 cron 이 보강.
        if !extracted.lessons.is_empty() {
            let mf = {
                let guard = self.memory_file.lock().unwrap_or_else(|p| p.into_inner());
                guard.clone()
            };
            if let Some(mf) = mf {
                for l in &extracted.lessons {
                    if l.name.trim().is_empty() || l.content.trim().is_empty() {
                        continue;
                    }
                    let entry = MemoryEntry {
                        category: l.category.clone(),
                        name: l.name.clone(),
                        description: l.description.clone(),
                        content: l.content.clone(),
                    };
                    let _ = mf.save(owner, &entry).await;
                }
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
            entities: self.memory.count_entities()?,
            facts: self.memory.count_facts()?,
            events: self.memory.count_events()?,
            entities_by_type: self.memory.count_entities_by_type()?,
            events_by_type: self.memory.count_events_by_type()?,
        })
    }

    /// 24시간 cron 호출용 — 만료 fact + event 일괄 정리.
    pub fn cleanup_all_expired(&self) -> InfraResult<(i64, i64)> {
        let facts = self.memory.cleanup_expired_facts()?;
        let events = self.memory.cleanup_expired_events()?;
        Ok((facts, events))
    }

    /// 비활성 대화 자동 consolidation — cron 6시간마다 호출.
    /// 옛 TS Core.consolidateInactiveConversations 1:1 port.
    ///
    /// `inactivity_ms` (default 1시간) 지난 대화만 처리. `limit_per_run` (default 10) 까지만 —
    /// 한 번에 LLM 비용 폭주 방지. 이미 정리된 fact/event 는 dedup 으로 자동 skip.
    pub async fn consolidate_inactive_conversations(
        &self,
        owner: Option<&str>,
        inactivity_ms: Option<i64>,
        limit_per_run: Option<usize>,
    ) -> InactiveConsolidationResult {
        let owner = owner.unwrap_or("admin");
        let inactivity = inactivity_ms.unwrap_or(60 * 60_000);
        let limit = limit_per_run.unwrap_or(10);
        let cutoff = chrono::Utc::now().timestamp_millis() - inactivity;

        let hook = {
            let guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        let Some(hook) = hook else {
            return InactiveConsolidationResult::default();
        };

        let mut conversations: Vec<(String, i64)> = hook
            .conversation
            .list(owner)
            .into_iter()
            .filter_map(|c| {
                let updated = if c.updated_at > 0 {
                    c.updated_at
                } else {
                    c.created_at
                };
                if updated < cutoff {
                    Some((c.id, updated))
                } else {
                    None
                }
            })
            .collect();
        conversations.sort_by(|a, b| b.1.cmp(&a.1));
        conversations.truncate(limit);

        let mut processed = 0usize;
        let mut total_saved = 0usize;
        let mut total_skipped = 0usize;
        for (conv_id, _) in conversations {
            match self.consolidate_conversation(owner, &conv_id, None).await {
                Ok(outcome) => {
                    processed += 1;
                    total_saved += outcome.saved.entities.len()
                        + outcome.saved.facts.len()
                        + outcome.saved.events.len();
                    total_skipped += outcome.skipped as usize;
                }
                Err(_) => {
                    // 단일 실패는 다음 대화로 진행 (옛 TS 1:1)
                }
            }
        }

        InactiveConsolidationResult {
            processed,
            total_saved,
            total_skipped,
        }
    }

    /// 일반 LLM text 호출 — 옛 TS Core.askLlmText 1:1 port. AiManager 설정되어 있을 때만 작동.
    pub async fn ask_llm_text(
        &self,
        prompt: &str,
        opts: &crate::ports::LlmCallOpts,
    ) -> InfraResult<String> {
        let hook = {
            let guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        let Some(hook) = hook else {
            return Err(crate::i18n::t(
                "core.error.consolidation.hook_unset_short",
                None,
                &[],
            ));
        };
        hook.ai.ask_text(prompt, opts).await
    }
}

/// `consolidate_inactive_conversations` 결과 — 옛 TS 동등 (processed / totalSaved / totalSkipped).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InactiveConsolidationResult {
    pub processed: usize,
    #[serde(rename = "totalSaved")]
    pub total_saved: usize,
    #[serde(rename = "totalSkipped")]
    pub total_skipped: usize,
}

// Tests 이관 — `infra/tests/consolidation_manager_test.rs` (integration test).

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

/// Worker 모델 해석 (Stage 3) — 답변 후 추출/consolidation 이 쓸 모델.
/// 우선순위: explicit(어드민 수동 trigger) > AI Assistant 설정 > 스마트 기본.
/// - `"current"` sentinel → 메인 채팅 모델(`VK_SYSTEM_AI_MODEL`; CLI 메인 = 구독 무료).
/// - 설정 비었고 메인이 CLI → 메인(무료가 기본). 메인이 API → assistant_default(저비용).
/// 메인 모델로 추출하면 CLI 구독은 비용 0, API 는 비싸므로 저비용 모델이 기본 — "부담없이 켜기".
fn resolve_worker_model(vault: &dyn IVaultPort, explicit: Option<&str>) -> String {
    if let Some(m) = explicit.map(str::trim).filter(|v| !v.is_empty()) {
        return m.to_string();
    }
    let assistant = vault.get_secret(VK_SYSTEM_AI_ASSISTANT_MODEL).unwrap_or_default();
    let assistant = assistant.trim();
    let main = vault.get_secret(VK_SYSTEM_AI_MODEL).unwrap_or_default();
    let main = main.trim();
    if assistant == "current" {
        // 명시 sentinel — 메인 모델 사용 (API 메인이어도 사용자 선택 존중).
        if !main.is_empty() {
            return main.to_string();
        }
    } else if !assistant.is_empty() {
        return assistant.to_string();
    } else if !main.is_empty() && main_is_cli(main) {
        // 미설정 + CLI 메인 → 메인(구독 무료)이 기본. (API 메인은 아래 저비용 default 로.)
        return main.to_string();
    }
    crate::llm::registry::assistant_default_model().to_string()
}

/// 모델 id 가 CLI 포맷(cli-claude-code / cli-codex / cli-gemini)인지 — registry lookup.
fn main_is_cli(id: &str) -> bool {
    crate::llm::registry::current()
        .find_model(id)
        .map(|m| m.format.starts_with("cli-"))
        .unwrap_or(false)
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
