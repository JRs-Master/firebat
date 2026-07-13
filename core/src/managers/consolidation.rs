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

use crate::managers::llm_service::LlmService;
use crate::managers::conversation::ConversationManager;
use crate::managers::cost::CostManager;
use crate::managers::memory_file::{MemoryEntry, MemoryFileManager};
use crate::ports::{
    IMemoryFacadePort, IVaultPort, InfraResult, LlmCallOpts, SaveEntityInput, SaveEventInput,
    SaveFactInput,
};

/// AI Assistant model 의 default — `llm::registry::assistant_default_model()` (JSON 산출).
/// 옛 `vault_keys::AI_ASSISTANT_DEFAULT_MODEL` const → JSON registry 로 이동 (Phase 5, 2026-05-13).
use crate::vault_keys::{VK_SYSTEM_AI_MODEL, VK_SYSTEM_AI_ROUTER_ENABLED};

/// 옛 TS EXTRACTION_PROMPT Rust port — 대화 → entity / fact / event JSON 추출 instruction.
const EXTRACTION_PROMPT: &str = r#"You maintain this person's long-term memory. Read the conversation and extract ONLY durable knowledge — things that stay true OUTSIDE this conversation — as JSON.

The one test that decides everything: "If this conversation were deleted, would this still be true and useful later?"
- The conversation itself is already stored in full elsewhere. NEVER record conversation activity: "the user asked/requested X", "an analysis was performed", "the assistant showed Y" — that is chat history, not memory. Every value you write must stand on its own without referring to what happened in the chat.
- NEVER record numeric time-series (price history, chart data, sensor readings) — a data cache owns those. A single current state value (a position, a level, a target) IS a fact.
- SKIP code-internal / technical / implementation conclusions (how a bug was fixed, a component's data format, an API shape) — those belong in code and docs; and development / build / approval events.
- SKIP anything another system already records (logs, schedules, calendar entries).
- Write each value from the standpoint of what helps serve this person later, in their own terms — not internal system mechanics (you may not know how the system transforms things downstream; do not assume or describe it).
- **Value accuracy**: when the conversation contains multiple versions of the same figure (a rough spoken mention, then a tool-verified or corrected value), record ONLY the most accurate final version. Tool-returned data always beats a conversational approximation. A wrong number in memory is worse than no number.

1. **entities** (subjects worth tracking — things/people/organizations/projects/strategies this person cares about): the *identity* of a recurring subject only; everything known about it goes in facts.
   - name: the full canonical name — never an abbreviation, code/ticker, or the subject combined with an attribute. Keep it identical across mentions (name plus aliases is the dedup key).
   - aliases: every alternative form of the same subject — abbreviations, codes/tickers, alternate spellings, language variants — so later mentions merge into one entity.
   - metadata: optional object of attributes.
   When a [Tracked recall graph] list is provided after the conversation, prefer recording NEW facts about those subjects and NEW subjects of similar kinds.

2. **facts** (durable statements about an entity — its state, attributes, and this person's positions/goals/decisions about it):
   - entityName: which entity (matches a name in entities)
   - content: 1-2 self-sufficient sentences — state figures, dates, outcome when present
   - factType: the kind of statement — REUSE an existing label (see the tracked-graph list) for the same kind so a state's history groups together
   - occurredAt: ms epoch — resolve relative dates ("yesterday", "next week", "this morning") against the [YYYY-MM-DD HH:MM UTC] timestamps shown in the transcript; null when no time is inferable. Never use the current/extraction time as a substitute.
   - tags: optional cross-cutting labels
   - supersede: true when this fact is a NEW VALUE of a state the entity already has (same factType — an updated figure/level/status). The previous value is retired into history.

3. **events** (something that happened or is scheduled in the WORLD at a point in time): a trade executed, a release or announcement, a decision this person made, a project/life milestone. NOT questions, requests, analyses, or anything that only happened inside the chat.
   - type: kind of occurrence — reuse the same label for the same kind
   - title: short summary / description: optional detail / occurredAt: ms epoch / entityNames: linked entity names
   - An announcement/decision usually yields BOTH: the event (it happened at a point in time) AND a fact (the resulting durable state of the entity — plan, target, position). Record both; the fact is the more useful half for later recall.

4. **lessons** (a rule that should change behavior in FUTURE, UNRELATED conversations — a durable preference or way of working):
   The bar is highest here. SKIP: replays of a single incident ("user pointed out X once"), current project state or what the person is working on right now (those are facts, not rules), duplicates of standing instructions already followed, and anything a schedule already encodes.
   - name: short kebab-case slug (also the filename and dedup key)
   - category: one of user / feedback / project / reference
   - description: one-line summary (shown in the index — keep it self-sufficient)
   - content: the reusable lesson / how-to body

Uncertainty policy: for facts and events, when something WAS stated but you are unsure it is durable, still record it — autonomous extractions enter a staging tier (not used until confirmed by repetition or review), so recording is safe. But never invent what was not stated, and never turn a single occurrence into an identity/habit/lesson.

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
    /// Model-judged: this fact is a NEW VALUE of a state the entity already has (same factType)
    /// — the previous active value is retired into history (superseded_by).
    #[serde(default)]
    pub supersede: bool,
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
    pub llm: Arc<LlmService>,
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
        llm: Arc<LlmService>,
        conversation: Arc<ConversationManager>,
        vault: Arc<dyn IVaultPort>,
        cost: Option<Arc<CostManager>>,
    ) {
        let mut guard = self.ai_hook.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(ConsolidationAiHook { llm, conversation, vault, cost });
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

        // Intelligence 자동 등록 토글 (2026-07-13 분리) — 리콜(`system:ai-router:enabled`, 기존 키
        // 유지) / 메모리(`system:memory:auto-save`, 미설정 = 리콜 값 상속 → 분리 전 동작 불변).
        // 둘 중 하나라도 ON 이면 추출은 1회 돌고(한 LLM 패스가 두 스토어 다 뽑음) 저장을
        // 스토어별로 게이트한다(아래). 어드민 직접 trigger(model_id 명시) = 토글 무시.
        let recall_on = hook
            .vault
            .get_secret(VK_SYSTEM_AI_ROUTER_ENABLED)
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false); // default off (옛 TS 와 동일)
        let memory_on = hook
            .vault
            .get_secret(crate::vault_keys::VK_SYSTEM_MEMORY_AUTO_SAVE)
            .map(|v| v == "true" || v == "1")
            .unwrap_or(recall_on);
        if model_id.is_none() && !recall_on && !memory_on {
            return Ok(ConsolidationOutcome {
                extracted: ExtractionResult::default(),
                saved: SavedIds::default(),
                skipped: 0,
            });
        }
        // manual trigger(model_id 명시)는 양 스토어 모두 저장(토글 무시 = 기존 규약).
        let (save_recall, save_memory) = if model_id.is_some() {
            (true, true)
        } else {
            (recall_on, memory_on)
        };

        // 예산 가드 — CostManager 설정되어 있으면 한도 검사. 한도 초과 시 즉시 skip
        // (백그라운드 cron 6시간마다 LLM 호출 → API 오류 / 환각 무한 재시도 → 토큰 폭주 차단).
        // 사용자 어드민 trigger (model_id 명시) 도 동일하게 가드 — 비용 폭주는 어떤 trigger 도 동일 위험.
        if let Some(cost) = &hook.cost {
            let check = cost.check_budget();
            if !check.within_budget {
                tracing::warn!(
                    reason = check.reason.as_deref().unwrap_or("budget exceeded"),
                    daily_used = check.daily_used_usd,
                    monthly_used = check.monthly_used_usd,
                    "ConsolidationManager: budget exceeded — consolidate_conversation skipped"
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
            // Too short to extract — stamp anyway so the cron stops re-picking it until new activity.
            let _ = hook
                .conversation
                .mark_consolidated(conv_id, chrono::Utc::now().timestamp_millis());
            return Ok(ConsolidationOutcome::default());
        }

        // 2. transcript 변환
        let transcript = format_transcript(messages);
        if transcript.len() < MIN_TRANSCRIPT_LEN {
            let _ = hook
                .conversation
                .mark_consolidated(conv_id, chrono::Utc::now().timestamp_millis());
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
        // Graph self-steering (A2) — show the extractor what recall already tracks so it records
        // new facts about these subjects (and new subjects of similar kinds), reuses factType
        // labels, and sets fact.supersede when a fact is a new value of a listed state.
        let ent_note = {
            let scope = if owner != "admin" && !owner.is_empty() {
                Some(owner)
            } else {
                None
            };
            let ents = self.memory.list_entities(scope, 50).await.unwrap_or_default();
            if ents.is_empty() {
                String::new()
            } else {
                let fts = self.memory.list_fact_types(scope).unwrap_or_default();
                // Incumbent values under each subject — without them the extractor cannot
                // judge that a figure in the conversation is a CORRECTION of a tracked state
                // (supersede stays false, stale values linger). Capped 3/entity.
                let mut facts_by_entity: HashMap<i64, Vec<crate::ports::EntityFactRecord>> =
                    HashMap::new();
                for e in &ents {
                    if let Ok(facts) = self.memory.entity_timeline(
                        e.id,
                        &crate::ports::TimelineOpts {
                            limit: Some(3),
                            owner: scope.map(String::from),
                            ..Default::default()
                        },
                    ) {
                        if !facts.is_empty() {
                            facts_by_entity.insert(e.id, facts);
                        }
                    }
                }
                format!(
                    "\n\n[Tracked recall graph — record NEW facts about these subjects and NEW subjects of similar kinds; REUSE the factType labels below for the same kind of statement; set fact.supersede=true when a fact is a NEW VALUE or CORRECTION of a currently tracked value shown below]\n{}",
                    crate::managers::entity::format_entity_index(&ents, &fts, &facts_by_entity)
                )
            }
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
        let full_prompt = format!("{}\n{}{}{}", prompt_with_lang, transcript, mem_note, ent_note);
        let opts = LlmCallOpts {
            model: Some(resolve_worker_model(hook.vault.as_ref(), model_id)),
            thinking_level: Some("minimal".to_string()),
            // Structured output — schema-constrained JSON so extraction survives weak worker
            // models (malformed-JSON passes observed on solar-pro3, e.g. unquoted keys mid-
            // output). Formats without response_format support ignore this (prompt-only JSON
            // as before). Schema mirrors the Extracted* serde structs 1:1.
            json_schema: Some(extraction_schema()),
            ..Default::default()
        };
        let response_text = hook.llm.ask_text(&full_prompt, &opts).await.map_err(|e| {
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
            Err(e) => {
                // Unparseable LLM output — stamp anyway: re-running the same transcript every
                // 6h repeats the same failure (new activity resets the watermark naturally).
                // Logged so a silent-zero pass is distinguishable from correct abstention.
                tracing::warn!(
                    target: "consolidation",
                    conv_id = %conv_id,
                    error = %e,
                    "extraction output unparseable — stamped & skipped"
                );
                let _ = hook
                    .conversation
                    .mark_consolidated(conv_id, chrono::Utc::now().timestamp_millis());
                return Ok(ConsolidationOutcome::default());
            }
        };

        // 5. save_extracted 위임 (이미 설정된 메서드)
        // 스토어별 게이트 — 추출은 한 패스지만 저장은 토글대로: 리콜 OFF = entity/fact/event drop,
        // 메모리 OFF = lessons drop (Intelligence 분리 토글, 2026-07-13).
        let mut extracted = extracted;
        if !save_recall {
            extracted.entities.clear();
            extracted.facts.clear();
            extracted.events.clear();
        }
        if !save_memory {
            extracted.lessons.clear();
        }
        // owner 를 쓰기 경로까지 전달 — hub 대화 정리가 admin scope 로 저장되던 누수(RECALL-2) fix. empty/"admin" → None(admin).
        let scope = if owner != "admin" && !owner.is_empty() { Some(owner) } else { None };
        let outcome = self
            .save_extracted(extracted, Some(conv_id), Some(0.92), Some(0.92), scope)
            .await?;
        // Per-conversation outcome — "clean abstention (0 saved)" vs "parse failure" vs real
        // extraction must be tellable from journalctl (실측 verification depends on it).
        tracing::info!(
            target: "consolidation",
            conv_id = %conv_id,
            entities = outcome.saved.entities.len(),
            facts = outcome.saved.facts.len(),
            events = outcome.saved.events.len(),
            skipped = outcome.skipped,
            "extraction pass done"
        );
        // Success — watermark so the cron only revisits this conversation on new activity.
        // (Toggle-OFF / budget-guard early returns above intentionally do NOT stamp.)
        let _ = hook
            .conversation
            .mark_consolidated(conv_id, chrono::Utc::now().timestamp_millis());
        Ok(outcome)
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
                    // Auto-upsert — the model referenced an entity it didn't list in entities[].
                    // Silently dropping the fact loses knowledge (observed: orphan events with no
                    // entity, facts skipped wholesale). save_entity is upsert + cosine dedup(0.92),
                    // so a minimal name-only entity is safe and merges with later richer saves.
                    _ => match self
                        .memory
                        .save_entity(SaveEntityInput {
                            name: f.entity_name.clone(),
                            entity_type: String::new(),
                            aliases: vec![],
                            metadata: None,
                            source_conv_id: source_conv_id.map(String::from),
                            dedup_threshold: Some(0.92),
                            owner: owner.map(String::from),
                        })
                        .await
                    {
                        Ok((id, _)) => {
                            entity_id_by_name.insert(f.entity_name.clone(), id);
                            Some(id)
                        }
                        Err(_) => None,
                    },
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
                    // Cron extraction = staging: not user-authored, starts below the promote
                    // threshold; repeated observations (dedup bumps) promote it.
                    supersede: f.supersede,
                    explicit: false,
                    confidence: Some(0.5),
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
                if name.trim().is_empty() {
                    continue;
                }
                if let Some(id) = entity_id_by_name.get(name).copied() {
                    entity_ids.push(id);
                } else if let Ok(Some(rec)) = self.memory.find_entity_by_name(name) {
                    entity_id_by_name.insert(name.clone(), rec.id);
                    entity_ids.push(rec.id);
                } else if let Ok((id, _)) = self
                    .memory
                    .save_entity(SaveEntityInput {
                        // Auto-upsert (mirror of the facts loop) — no more orphan events whose
                        // entity link silently vanished because entities[] omitted the name.
                        name: name.clone(),
                        entity_type: String::new(),
                        aliases: vec![],
                        metadata: None,
                        source_conv_id: source_conv_id.map(String::from),
                        dedup_threshold: Some(0.92),
                        owner: owner.map(String::from),
                    })
                    .await
                {
                    entity_id_by_name.insert(name.clone(), id);
                    entity_ids.push(id);
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
                    explicit: false,
                    confidence: Some(0.5), // staging (see facts above)
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
        // 인라인(메인 모델 memory_save)이 주 경로 — 이건 메인이 놓친 implicit 교훈을 cron 이 보강.
        // 재관측 = 승격 신호 (2026-07-13, Recall B4 미러): 같은 name 이 다시 추출되면 내용은 최신으로
        // 갱신하되 confidence +0.15(cap 0.95) — 0.7 도달 시 인덱스 주입(= Recall 과 같은 재관측 2회
        // 자동 승격). 옛 동작(무조건 0.5 덮어쓰기)은 재관측이 승격 신호를 못 내는 write-only limbo.
        // 사용자 작성/명시 저장분(confidence 1.0)은 cron 이 건드리지 않는다 — F8 출처 우선.
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
                    // read = Err when absent (fs miss) — treat any error as "no prior sighting".
                    let existing_conf = mf.read(owner, &l.name).await.ok().map(|e| e.confidence);
                    if matches!(existing_conf, Some(c) if c >= 1.0) {
                        continue; // user-authored/explicit — cron never overwrites
                    }
                    let confidence = match existing_conf {
                        Some(c) => (c + 0.15).min(0.95), // re-observed → promote toward 0.7
                        None => 0.5,                     // first sighting = staging
                    };
                    let entry = MemoryEntry {
                        category: l.category.clone(),
                        name: l.name.clone(),
                        description: l.description.clone(),
                        content: l.content.clone(),
                        confidence,
                    };
                    if let Err(e) = mf.save(owner, &entry).await {
                        // Observability — a silently dropped lesson made "extraction ran but
                        // nothing saved" indistinguishable from correct abstention.
                        tracing::warn!(target: "consolidation", lesson = %l.name, error = %e, "lesson save failed");
                    }
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
    pub fn get_memory_stats(&self, owner: Option<&str>) -> InfraResult<MemoryStats> {
        Ok(MemoryStats {
            entities: self.memory.count_entities(owner)?,
            facts: self.memory.count_facts(owner)?,
            events: self.memory.count_events(owner)?,
            entities_by_type: self.memory.count_entities_by_type(owner)?,
            events_by_type: self.memory.count_events_by_type(owner)?,
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

        // Watermark-filtered pick: only conversations with NEW activity since their last
        // consolidation pass (updated_at > last_consolidated_at). The old unconditional
        // "recent inactive 10" re-extracted the same conversations every 6h (duplicate
        // events + wasted LLM/CLI quota).
        let conversations = hook
            .conversation
            .list_needing_consolidation(owner, cutoff, limit);

        let mut processed = 0usize;
        let mut total_saved = 0usize;
        let mut total_skipped = 0usize;
        for conv_id in conversations {
            match self.consolidate_conversation(owner, &conv_id, None).await {
                Ok(outcome) => {
                    processed += 1;
                    total_saved += outcome.saved.entities.len()
                        + outcome.saved.facts.len()
                        + outcome.saved.events.len();
                    total_skipped += outcome.skipped as usize;
                }
                Err(e) => {
                    // 단일 실패는 다음 대화로 진행 (옛 TS 1:1) — 단 로그는 남긴다(무음 진단 불가 방지).
                    tracing::warn!(target: "consolidation", conv_id = %conv_id, error = %e, "conversation consolidation failed");
                }
            }
        }
        tracing::info!(
            target: "consolidation",
            owner = %owner,
            processed,
            total_saved,
            total_skipped,
            "consolidation cron pass done"
        );

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
        hook.llm.ask_text(prompt, opts).await
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
///
/// Time anchors: without message timestamps the extractor has NO idea when the conversation
/// happened (the cron runs hours later) — "어제"/"다음주"/even "오늘" can't resolve, so events
/// were stamped with the extraction time instead of the actual occurrence. A `[YYYY-MM-DD
/// HH:MM UTC]` line is emitted whenever the minute changes (deduped — keeps the transcript
/// lean); the prompt instructs resolving relative dates against these anchors into occurredAt.
fn format_transcript(messages: &[serde_json::Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut last_stamp = String::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let role_label = match role {
            "user" => "사용자",
            "assistant" => "AI",
            _ => continue,
        };
        let raw = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
        // firebat-render fence(X: render 가 content 에 상주) → 텍스트 값만 (추출 transcript 에 raw JSON 안 섞이게).
        let content = crate::managers::ai::render_exec::fence_to_plaintext(raw);
        if content.trim().is_empty() {
            continue;
        }
        let truncated = if content.chars().count() > MESSAGE_TRIM_LIMIT {
            let prefix: String = content.chars().take(MESSAGE_TRIM_LIMIT).collect();
            format!("{prefix}...(생략)")
        } else {
            content.to_string()
        };
        let stamp = m
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
            .unwrap_or_default();
        if !stamp.is_empty() && stamp != last_stamp {
            lines.push(format!("[{stamp}]"));
            last_stamp = stamp;
        }
        lines.push(format!("{role_label}: {truncated}"));
    }
    lines.join("\n\n")
}

/// Worker 모델 해석 (Stage 3) — 답변 후 추출/consolidation 이 쓸 모델.
/// Worker model = explicit (admin manual trigger) > CURRENT MAIN MODEL > registry fallback.
///
/// 2026-07-13 단순화 — the assistant model picker was removed from the UI ("현재 모델 고정"
/// 사용자 확정): extraction is json_schema-forced so any main model is safe, and per-step
/// cheap-worker delegation lives in pipeline LLM_TRANSFORM `model` instead of a global knob.
/// `VK_SYSTEM_AI_ASSISTANT_MODEL` is deliberately IGNORED here — a stale vault value from the
/// old picker must not silently override the main model (Rust first, then UI removal).
fn resolve_worker_model(vault: &dyn IVaultPort, explicit: Option<&str>) -> String {
    if let Some(m) = explicit.map(str::trim).filter(|v| !v.is_empty()) {
        return m.to_string();
    }
    let main = vault.get_secret(VK_SYSTEM_AI_MODEL).unwrap_or_default();
    let main = main.trim();
    if !main.is_empty() {
        return main.to_string();
    }
    crate::llm::registry::assistant_default_model().to_string()
}

/// JSON Schema for the extraction output — mirrors `ExtractionResult`/`Extracted*` serde
/// structs 1:1 (strict mode: every property required, nullable via `["T","null"]` unions —
/// live-verified on solar-pro3). `metadata` (free-form) is intentionally omitted: strict
/// schemas can't express it, and serde's `#[serde(default)]` fills `None`.
fn extraction_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "entities": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"},
                "type": {"type": "string"},
                "aliases": {"type": "array", "items": {"type": "string"}}
            }, "required": ["name", "type", "aliases"], "additionalProperties": false}},
            "facts": {"type": "array", "items": {"type": "object", "properties": {
                "entityName": {"type": "string"},
                "content": {"type": "string"},
                "factType": {"type": ["string", "null"]},
                "occurredAt": {"type": ["integer", "null"]},
                "tags": {"type": "array", "items": {"type": "string"}},
                "supersede": {"type": "boolean"}
            }, "required": ["entityName", "content", "factType", "occurredAt", "tags", "supersede"], "additionalProperties": false}},
            "events": {"type": "array", "items": {"type": "object", "properties": {
                "type": {"type": "string"},
                "title": {"type": "string"},
                "description": {"type": ["string", "null"]},
                "occurredAt": {"type": ["integer", "null"]},
                "entityNames": {"type": "array", "items": {"type": "string"}}
            }, "required": ["type", "title", "description", "occurredAt", "entityNames"], "additionalProperties": false}},
            "lessons": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"},
                "category": {"type": "string"},
                "description": {"type": "string"},
                "content": {"type": "string"}
            }, "required": ["name", "category", "description", "content"], "additionalProperties": false}}
        },
        "required": ["entities", "facts", "events", "lessons"],
        "additionalProperties": false
    })
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
