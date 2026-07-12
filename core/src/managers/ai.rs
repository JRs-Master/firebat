//! AiManager — User AI / Code Assistant / AI Assistant orchestrator.
//!
//! 옛 TS `core/managers/ai-manager.ts` (1249줄, 6 collaborator 분리 후) Rust 재구현.
//! Phase B-16 minimum: shape 설정 + Function Calling 도구 dispatch 흐름. 실 LLM 호출은 Phase B-17+.
//!
//! Phase B-17+ 후속:
//! - 시스템 프롬프트 빌더 (옛 TS prompt-builder.ts)
//! - 도구 정의 빌드 — 정적 27개 + 동적 sysmod_* + mcp_* 외부 도구 (60초 캐시)
//! - history resolver (search_history 자동 주입 — needs_previous_context 라우터)
//! - tool dispatcher — 도구 종류별 핸들러 분기 → ToolManager 위임
//! - result processor — sanitizeBlock / sanitizeReply / Markdown 표·헤더 자동 변환
//! - LLM 8 format 어댑터 와이어링

pub mod prompt_builder;
pub mod system_context;
pub mod history_resolver;
pub mod tool_dispatcher;
pub mod result_processor;
pub mod retrieval_engine;
pub mod tool_router;
pub mod plan_mode;
pub mod code_assist;
// 옛 llm/ 에 설정되어 있던 순수 검색 index — infra 의존 0건이라 core (managers/ai) 로 이동.
pub mod component_registry;
pub mod render_exec;
pub mod component_search_index;
pub mod tool_search_index;
pub mod dynamic_tools;
// #search-tool — 공용 시맨틱 카탈로그 엔진(S1) + 모듈 액션 카탈로그(S2) + 도메인 카탈로그
// (skills/templates/pages/media — 수백 개 스케일 대비 시맨틱 발견).
pub mod semantic_catalog;
pub mod action_catalog;
pub mod domain_catalogs;

use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::mpsc;

/// 도구 이름 → 한국어 진행 라벨. streaming step event 의 description 으로 사용.
/// 옛 TS chat stream route 의 toolLabel 영역 1:1.
fn tool_label(name: &str) -> String {
    match name {
        "execute" => "모듈 실행 중".to_string(),
        "mcp_call" => "외부 서비스 연결 중".to_string(),
        "network_request" => "API 호출 중".to_string(),
        "write_file" => "파일 저장 중".to_string(),
        "read_file" => "파일 읽는 중".to_string(),
        "save_page" => "페이지 저장 중".to_string(),
        "delete_page" => "페이지 삭제 중".to_string(),
        "schedule_task" => "스케줄 등록 중".to_string(),
        "cancel_cron_job" => "스케줄 해제 중".to_string(),
        "run_task" => "파이프라인 실행 중".to_string(),
        "plan" => "계획 정리 중".to_string(),
        "request_secret" => "API 키 요청".to_string(),
        "suggest" => "선택지 제시".to_string(),
        "render_iframe" => "iframe 위젯 렌더링 중".to_string(),
        "list_dir" => "폴더 목록 조회 중".to_string(),
        "list_pages" => "페이지 목록 조회 중".to_string(),
        "get_page" => "페이지 조회 중".to_string(),
        "delete_file" => "파일 삭제 중".to_string(),
        "list_cron_jobs" => "스케줄 목록 조회 중".to_string(),
        "search_history" => "과거 대화 검색 중".to_string(),
        "image_gen" => "이미지 생성 중".to_string(),
        "save_entity" | "save_event" | "save_entity_fact" => "메모리 저장 중".to_string(),
        n if n.starts_with("sysmod_") => format!("시스템 모듈 실행 중 ({})", &n["sysmod_".len()..]),
        n if n.starts_with("mcp_") => "외부 서비스 연결 중".to_string(),
        n if n.starts_with("render_") => "컴포넌트 렌더링 중".to_string(),
        n => n.to_string(),
    }
}

/// AI streaming event — process_with_tools_opts_with_emit 가 매 단계 시점 채널로 전송.
/// gRPC server-stream impl 가 mpsc → tonic Stream 매핑 수행.
#[derive(Debug, Clone)]
pub enum AiStreamEvent {
    /// 매 turn 의 reasoning text 또는 thinking 영역.
    /// `event_type`: "text" | "thinking"
    Chunk { event_type: String, content: String },
    /// 도구 호출 진행 — start / done / error.
    Step {
        name: String,
        status: String,
        description: Option<String>,
        error_message: Option<String>,
    },
}

use crate::managers::ai::history_resolver::HistoryResolver;
use crate::managers::ai::prompt_builder::PromptBuilder;
use crate::managers::ai::system_context::SystemContextGatherer;
use crate::managers::ai::tool_dispatcher::ToolDispatcher;
use crate::managers::conversation::ConversationManager;
use crate::managers::cost::CostManager;
use crate::managers::module::ModuleManager;
use crate::managers::tool::{ToolListFilter, ToolManager};
use crate::ports::{
    AiRequestOpts, ILlmPort, ILogPort, IVaultPort, InfraResult, LlmCallOpts, LlmToolResponse,
    ToolCall, ToolDefinition, ToolResult,
};
use crate::utils::pending_tools::create_pending_scoped;
use crate::utils::render_map::render_tool_map;
use crate::utils::tool_cache::{
    get_cached_tool_result, set_cached_tool_result, tool_cache_key,
};

/// admin 채팅 + cron agent 모두 25 동일 (사용자 결정, 2026-05-09).
/// 옛 TS 의 admin=10 / cron=25 분리 → 25 통일. 큰 작업 (블로그·자동매매·데이터 수집)
/// 시 admin 도 sysmod 다중 호출 + save_page 충분 보장.
const MAX_TOOL_TURNS_ADMIN: usize = 25;
const MAX_TOOL_TURNS_CRON: usize = 25;
/// 도구 호출 turn — JSON 스키마 정확 준수. 옛 TS 1:1.
const TEMP_TOOL_TURN: f64 = 0.2;
/// 최종 응답 turn — 자연스럽고 풍부한 표현. 옛 TS 1:1.
const TEMP_FINAL_TURN: f64 = 0.85;

// 옛 is_simple_chat fast path 폐기 (2026-05-11) — 길이 / 키워드 휴리스틱 기반은 일반 fix
// 가 안 됨. 짧은 query 가 fast path 로 빠져 도구 schema 가 누락 → "삼성전자 현재가 얼마야" 같은
// 자연 query 가 sysmod 호출 못 하던 root cause. 새 keyword 추가는 또 다른 개별 fix.
// 진짜 일반 = 도구 schema 항상 제공하고 LLM 자체 판단 위임. 토큰 비용 약간 ↑ 단 정확성 ↑.

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub reply: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<serde_json::Value>,
    #[serde(rename = "executedActions", default, skip_serializing_if = "Vec::is_empty")]
    pub executed_actions: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<serde_json::Value>,
    /// 승인 대기 중인 도구 호출 — 옛 TS `pendingActions` 1:1.
    /// `{planId, name, summary, args, status?, originalRunAt?}` 형식.
    /// 사용자가 ✓승인 누르면 `consume_pending(planId)` 으로 실제 실행.
    #[serde(rename = "pendingActions", default, skip_serializing_if = "Vec::is_empty")]
    pub pending_actions: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The tool loop burned MAX_TOOL_TURNS without a natural finish — the reply is the honest
    /// fallback text, not a completed task. `error` stays None (chat renders it as a normal
    /// message), so unattended callers (cron) MUST check this flag: a task that never reached
    /// its final action (e.g. the telegram send) is a failure, not a success (2026-07-09 실측 —
    /// 날씨 cron 이 25 라운드 소진으로 발송 못 했는데 로그는 "성공").
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exhausted: bool,
    /// F2 fired: a round's tool calls were all rejected (cap/duplicate thrash) and the next round
    /// ran with tools stripped to force a wrap-up answer. The reply is legible text, but the task's
    /// final action (send/save/notify) may never have executed — so unattended callers (cron) must
    /// treat this as a failure too. Without this flag the forced wrap-up counts as a natural finish
    /// (`exhausted` stays false) and the silent-success class F3 killed comes right back.
    #[serde(rename = "forcedFinal", default, skip_serializing_if = "std::ops::Not::not")]
    pub forced_final: bool,
    #[serde(rename = "modelId", default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(rename = "costUsd", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// 도구 호출 결과 요약 (성공/실패 모두) — Frontend 에러 뱃지 UI 채널.
    /// 옛 TS 의 에러 뱃지 표시 메커니즘 1:1 — executedActions (이름만) 보완.
    #[serde(rename = "toolResults", default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<crate::ports::ToolResultSummary>,
    /// Library Phase 1 단계 8.4 (2026-05-17) — RetrievalEngine 가 매 query 시점 매칭한
    /// Library hit metadata. 답변 본문엔 출처 표기 없이 (system prompt 룰), 대신
    /// frontend 가 SourceTags 뱃지로 그려 클릭 → LibrarySourceModal 영역 노출.
    #[serde(rename = "libraryHits", default, skip_serializing_if = "Vec::is_empty")]
    pub library_hits: Vec<crate::ports::LibraryHit>,
    /// Project Builder — 활성 빌드 세션 상태 (frontend stepper/만료 표시용, conv 단위 조회).
    /// build_session::BuildSession 직렬화 ({id, convId?, tier?, step, status, ...}).
    #[serde(rename = "buildSession", default, skip_serializing_if = "Option::is_none")]
    pub build_session: Option<serde_json::Value>,
    /// 리버스엔지니어링 관측 — tool-loop 라운드별 reasoning + 호출 도구 + 실패 여부.
    /// 프론트는 안 읽는다(순수 사후 판독용). 실시간 thinkingText 는 답변 완료 시 "답변 완료"
    /// 라벨로 덮여 사라지므로, "이 도구를 이 인자로 부르기 직전 무슨 생각을 했나"를 DB
    /// data_json 에 라운드 단위로 남긴다 (2026-07-08: 똥멍청이 LLM 실패 원인 사후 분석 인프라).
    /// 형식: `[{round, reasoning, tools:[names], failed:bool}]`.
    #[serde(rename = "reasoningTrace", default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_trace: Vec<serde_json::Value>,
    /// Reasoning behind the FINAL answer of a turn that ended with NO tool call. reasoning_trace
    /// only captures tool-calling rounds, so a turn that answers directly (e.g. fabricating data
    /// without searching — the 배재고 case) leaves it empty. Captured from the concluding round's
    /// thinking_text so the "why didn't it use a tool" failure is readable post-hoc (the live
    /// thinkingText is overwritten by the "답변 완료" label on completion, so the DB loses it).
    #[serde(rename = "finalReasoning", default, skip_serializing_if = "Option::is_none")]
    pub final_reasoning: Option<String>,
}

impl AiResponse {
    /// Canonical `message.data` payload — the single source for every persistence and
    /// transport surface (streaming result event, hub_messages, admin conversations).
    /// It is a superset so neither admin nor hub drifts: `blocks` and `buildSession` are
    /// read from `data`, while the badges (executedActions/toolResults/libraryHits/
    /// suggestions/pendingActions) are mirrored here too so hub's data_json round-trips
    /// (mapHubMessages reconstructs the message from data alone). Every key is always
    /// emitted (unlike the struct's skip_serializing_if) so the shape stays stable.
    pub fn message_data_json(&self) -> serde_json::Value {
        serde_json::json!({
            "blocks": self.blocks,
            "executedActions": self.executed_actions,
            "toolResults": self.tool_results,
            "suggestions": self.suggestions,
            "pendingActions": self.pending_actions,
            "libraryHits": self.library_hits,
            "buildSession": self.build_session,
            "reasoningTrace": self.reasoning_trace,
            "finalReasoning": self.final_reasoning,
            // 사후 판독: 이 응답을 낸 모델 (똥멍청이 Solar vs 똑똑이 Sonnet 추론 비교 —
            // 옛엔 llm_costs 테이블 조인해야 알았음). reasoningTrace 라운드별 model 과 짝.
            "model": self.model_id,
        })
    }

    /// Wire JSON for a result event: the serialized response plus the canonical `data`
    /// object, so every transport (admin/hub, unary/stream) exposes one message-data shape
    /// and consumers persist `data` verbatim instead of re-deriving it (the source of the
    /// buildSession/libraryHits drift between the two paths).
    pub fn to_result_json(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = v.as_object_mut() {
            obj.insert("data".to_string(), self.message_data_json());
        }
        v.to_string()
    }
}

/// AiResponse 안 모든 사용자 노출 string 필드 안 시크릿 / 토큰 마스킹. process_with_tools_opts
/// 종료 직전 단일 게이트 — 외부 API 응답 본문 안 api-key / customer-id / Bearer / JWT / sk-* /
/// AIza* / Telegram bot token 등이 도구 결과 / 에러 메시지 / reply / blocks 안에 그대로 흘러가
/// 사용자 채팅 화면 노출되는 사고 차단.
fn redact_response(mut r: AiResponse) -> AiResponse {
    use crate::utils::redactor::{redact_string, redact_value, redact_value_content};
    r.reply = redact_string(&r.reply);
    if let Some(ref err) = r.error.clone() {
        r.error = Some(redact_string(err));
    }
    // AI 가 만든 렌더 콘텐츠 — 값 패턴만 마스킹(키 이름 마스킹 X). 'tokens' 등 콘텐츠 필드명이
    // 시크릿 needle 과 겹쳐 멀쩡한 컴포넌트가 통째 [REDACTED] 되던 false-positive 차단.
    r.blocks = r.blocks.into_iter().map(|v| redact_value_content(&v)).collect();
    r.executed_actions = r.executed_actions.into_iter().map(|v| redact_value_content(&v)).collect();
    r.suggestions = r.suggestions.into_iter().map(|v| redact_value_content(&v)).collect();
    r.pending_actions = r.pending_actions.into_iter().map(|v| redact_value_content(&v)).collect();
    // tool 결과/입력 = 외부 API 데이터 → strict(키 이름 마스킹 유지).
    r.tool_results = r
        .tool_results
        .into_iter()
        .map(|mut t| {
            if let Some(ref err) = t.error.clone() {
                t.error = Some(redact_string(err));
            }
            if let Some(input) = t.input.clone() {
                t.input = Some(redact_value(&input));
            }
            t
        })
        .collect();
    r
}

pub struct AiManager {
    llm: Arc<dyn ILlmPort>,
    tools: Arc<ToolManager>,
    log: Arc<dyn ILogPort>,
    /// 시스템 프롬프트 builder (옵션) — Vault 설정된 채로 설정. 미설정 시 base prompt 만.
    prompt_builder: Option<PromptBuilder>,
    /// 시스템 컨텍스트 gatherer (옵션) — sysmod / user module / MCP 동적 description 주입.
    /// 미설정 시 시스템 프롬프트에 컨텍스트 추가 안 됨 (base prompt 만).
    context_gatherer: Option<Arc<SystemContextGatherer>>,
    /// History resolver (옵션) — 옛 TS history-resolver.ts Rust port. opts.conversation_id 설정되어 있으면
    /// 자동 recent N 메시지 컨텍스트 prepend. IEmbedderPort 설정된 후 임베딩 spread 판정 활성.
    history_resolver: Option<HistoryResolver>,
    /// CostManager (옵션) — LLM 호출 후 자동 비용 누적. 옛 TS ai-manager.ts:1260
    /// `core.recordLlmCost(usage)` 패턴 1:1 port. 미설정 시 비용 누적 비활성.
    cost: Option<Arc<CostManager>>,
    /// ToolDispatcher (옵션) — approval gate (check_needs_approval + pre_validate_pending_args).
    /// 설정되어 있으면 destructive 도구 (write_file/save_page 덮어쓰기 / delete_* / schedule_task /
    /// cancel_cron_job) 호출 시 즉시 실행 X → pending 으로 등록. 옛 TS ai-manager.ts approval flow 1:1.
    /// 미설정 시 모든 도구 즉시 실행 (현재 default — 회귀 안전).
    dispatcher: Option<Arc<ToolDispatcher>>,
    /// ConversationManager (옵션) — CLI session resume 위해 직접 참조. 설정되어 있고 model 이 `cli-` 로
    /// 시작 + opts.conversation_id 설정되어 있으면 자동 resume_session_id 주입 + 첫 응답의 session_id
    /// 영속화. 옛 TS ai-manager.ts:914-924 1:1.
    conversation: Option<Arc<ConversationManager>>,
    /// DynamicToolRegistry (옵션) — sysmod_* / mcp_* 동적 도구 자동 등록 + 60초 cache.
    /// 설정되어 있으면 process_with_tools_opts 시작 시 refresh 호출 — 옛 TS buildToolDefinitions 1:1.
    /// 미설정 시 정적 도구 (`tool_registry::register_core_tools`) 만 LLM 노출.
    dynamic_tools: Option<Arc<dynamic_tools::DynamicToolRegistry>>,
    /// Vault 참조 (옵션) — process_with_tools_opts 진입 시점에 `system:internal-mcp-token`
    /// 자동 조회해 LlmCallOpts.mcp_token 주입. CLI 모델 (Claude Code / Codex / Gemini) 이
    /// 자체 MCP loop 에서 Firebat MCP server 인증할 때 사용. 미설정 시 토큰 주입 없음.
    vault: Option<Arc<dyn IVaultPort>>,
    /// IConfigPort (옵션) — std::env::var 직접 호출 추상화 (2026-05-13 Hexagonal 정공).
    /// FIREBAT_MCP_BASE_URL 등 env 영역 read. 미설정 시 env 조회 안 함 (Vault / hardcoded fallback 동작).
    config_port: Option<Arc<dyn crate::ports::IConfigPort>>,
    /// RetrievalEngine (옵션) — 매 사용자 query 시점 4-tier 통합 회상 (history + entities +
    /// facts + events) → context_summary → 시스템 프롬프트 `<RETRIEVED_CONTEXT>` 영역 prepend.
    /// vault 의 `system:ai-router:enabled` 토글 검사 — ConsolidationManager 와 동일 토글 통합 제어
    /// (옛 사용자 결정 2026-05-17). 미설정 또는 토글 false 시 호출 skip.
    retrieval_engine: Option<Arc<retrieval_engine::RetrievalEngine>>,
    /// IMediaPort (옵션) — opts.image 가 slug URL (`/user/attachments/<filename>` 또는
    /// `/user/media/<slug>.<ext>`) 형태일 때 fs read + base64 data URL 변환을 수행하는 layer.
    /// 옛 frontend = base64 data URL 직접 전송이었는데 2026-05-11 commit `6af42b2` 후 slug URL
    /// 전송 방식으로 전환. LLM adapter (cli_image_helper 등) 의 base64 가정 코드는 그대로
    /// 남아 있어 slug URL 그대로 가면 decode fail → LLM API "could not be processed" 결과.
    /// 본 layer 가 LLM 호출 전 image 부분을 data URL 형태로 강제 변환.
    media: Option<Arc<dyn crate::ports::IMediaPort>>,
    /// MemoryFileManager (옵션) — data/memory 운영 메모리 인덱스를 매 턴 시스템 프롬프트에
    /// `<OPERATIONAL_MEMORY>` 로 prepend. ai-router 토글과 무관하게 항상 주입 (큐레이트 운영지식은
    /// CLAUDE.md 처럼 늘 효력). 현재 owner=="admin" 만 주입 (hub 는 게이트 OFF). 미설정 시 주입 skip.
    memory_file: Option<Arc<crate::managers::memory_file::MemoryFileManager>>,
    /// SkillFileManager (옵션) — 스킬 인덱스(`<SKILLS_AVAILABLE>`)를 매 턴 시스템 프롬프트에 주입.
    /// 메모리와 달리 인덱스(슬러그+설명)만 상시, 본문은 온디맨드(get_skill). 미설정 시 주입 skip.
    skill_file: Option<Arc<crate::managers::skill_file::SkillFileManager>>,
    /// SysmodCacheAdapter (옵션) — firebat-render fence 의 `dataCacheKey` props 를 서버에서
    /// 캐시 records 로 치환(주입). 모델이 큰 배열을 손으로 베끼지 않게(truncation·날조 차단 +
    /// cache_read 왕복 토큰 절감). 미설정 시 dataCacheKey 미해석(모델 제공 data 만 사용).
    sysmod_cache: Option<Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>>,
    /// Intent Agent S0 — shadow-mode TurnBrief 재료 (registration 시 카탈로그 Arc 공유).
    /// S0 = 계산·기록만(행동 0): 매 턴 쿼리를 액션/스킬 카탈로그와 E5 매칭한 shortlist 를
    /// 실제 디스패치와 대조해 recall 을 journal(target=intent_shadow) 에 남긴다 — L2 세계
    /// 좁히기의 임계·정확도를 실측으로 확정하기 위한 선행 측정 (plan Intent Agent 섹션).
    intent_actions: Option<Arc<crate::managers::ai::action_catalog::ModuleActionCatalog>>,
    intent_skills: Option<Arc<crate::managers::ai::semantic_catalog::RefreshingCatalog>>,
}

impl AiManager {
    pub fn new(
        llm: Arc<dyn ILlmPort>,
        tools: Arc<ToolManager>,
        log: Arc<dyn ILogPort>,
    ) -> Self {
        Self {
            llm,
            tools,
            log,
            prompt_builder: None,
            context_gatherer: None,
            history_resolver: None,
            cost: None,
            dispatcher: None,
            conversation: None,
            dynamic_tools: None,
            vault: None,
            config_port: None,
            retrieval_engine: None,
            media: None,
            memory_file: None,
            skill_file: None,
            sysmod_cache: None,
            intent_actions: None,
            intent_skills: None,
        }
    }

    /// SysmodCacheAdapter 설정 — fence `dataCacheKey` 서버측 데이터 주입 활성.
    pub fn with_sysmod_cache(
        mut self,
        cache: Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>,
    ) -> Self {
        self.sysmod_cache = Some(cache);
        self
    }

    /// MemoryFileManager 설정 — data/memory 운영 메모리 인덱스 항상 주입 (토글 무관, owner=="admin").
    /// 미설정 시 주입 skip.
    pub fn with_memory_file(
        mut self,
        memory_file: Arc<crate::managers::memory_file::MemoryFileManager>,
    ) -> Self {
        self.memory_file = Some(memory_file);
        self
    }

    /// SkillFileManager 설정 — 스킬 인덱스(`<SKILLS_AVAILABLE>`) 매 턴 주입. 미설정 시 skip.
    pub fn with_skill_file(
        mut self,
        skill_file: Arc<crate::managers::skill_file::SkillFileManager>,
    ) -> Self {
        self.skill_file = Some(skill_file);
        self
    }


    /// IMediaPort 설정 — opts.image 가 slug URL 일 때 fs read + base64 data URL 변환 활성.
    /// 미설정 시 변환 skip (옛 동작 — base64 가정 코드 그대로).
    pub fn with_media(mut self, media: Arc<dyn crate::ports::IMediaPort>) -> Self {
        self.media = Some(media);
        self
    }

    /// opts.image 가 slug URL (`/user/attachments/<filename>` 또는 `/user/media/<slug>.<ext>`)
    /// 일 때 fs read + base64 data URL 변환 수행. 해당 형태가 아니거나 변환 fail 시 옛 값 그대로.
    /// LLM adapter (cli_image_helper / anthropic 등) 의 base64 가정 코드 호환.
    async fn resolve_image_to_data_url(&self, image: &str) -> Option<String> {
        // 이미 base64 data URL 형태 — 변환 불필요
        if image.starts_with("data:") {
            return Some(image.to_string());
        }
        let media = self.media.as_ref()?;
        // 채팅 임시 첨부 (`/user/attachments/<filename>`)
        if let Some(filename) = image.strip_prefix("/user/attachments/") {
            if let Ok(Some((binary, content_type))) =
                media.read_temp_attachment(filename).await
            {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&binary);
                return Some(format!("data:{};base64,{}", content_type, b64));
            }
            return None;
        }
        // 갤러리 (`/user/media/<slug>.<ext>`) — slug 영역 추출 후 read RPC 호출
        if let Some(rest) = image.strip_prefix("/user/media/") {
            let slug = rest.rsplit_once('.').map(|(s, _)| s).unwrap_or(rest);
            if let Ok(Some((binary, content_type, _record))) = media.read(slug).await {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&binary);
                return Some(format!("data:{};base64,{}", content_type, b64));
            }
            return None;
        }
        None
    }

    /// RetrievalEngine 설정 — 매 사용자 query 시점 4-tier 통합 검색 + 시스템 프롬프트 prepend.
    /// vault 의 `system:ai-router:enabled` 토글 검사 — false 시 skip. ConsolidationManager 와
    /// 동일 토글 통합 제어 (recall + consolidation 단일 토글).
    pub fn with_retrieval_engine(
        mut self,
        engine: Arc<retrieval_engine::RetrievalEngine>,
    ) -> Self {
        self.retrieval_engine = Some(engine);
        self
    }

    /// IConfigPort 설정 — std::env::var 직접 호출 추상화 (2026-05-13 Hexagonal 정공).
    /// FIREBAT_MCP_BASE_URL 등 env 영역 read. 미설정 시 env 무관 (Vault / hardcoded fallback 만 동작).
    pub fn with_config_port(mut self, config: Arc<dyn crate::ports::IConfigPort>) -> Self {
        self.config_port = Some(config);
        self
    }

    /// Vault 설정 — process_with_tools_opts 진입 시점에 `system:internal-mcp-token` 자동
    /// 조회해 LlmCallOpts.mcp_token 주입. CLI 3종 (Claude Code / Codex / Gemini) +
    /// MCP connector 지원 API (Anthropic / OpenAI Responses) 가 자체 MCP loop 에서
    /// Firebat MCP server 인증할 때 사용. 미설정 시 토큰 주입 없음.
    pub fn with_vault(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
    }

    /// Sub-agent parallel toggle — vault-backed (key inherited from the TS-era feature).
    /// Default OFF: each sub-agent is a full LLM run, so the toggle is a cost safety net.
    pub fn is_sub_agent_enabled(&self) -> bool {
        self.vault
            .as_ref()
            .and_then(|v| v.get_secret(crate::vault_keys::VK_SYSTEM_SUB_AGENT_ENABLED))
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false)
    }

    pub fn set_sub_agent_enabled(&self, enabled: bool) -> bool {
        self.vault
            .as_ref()
            .map(|v| {
                v.set_secret(
                    crate::vault_keys::VK_SYSTEM_SUB_AGENT_ENABLED,
                    if enabled { "true" } else { "false" },
                )
            })
            .unwrap_or(false)
    }

    /// spawn_subagent — parallel decomposition delegation (TS `dde3026a`/`7c95639c` Rust re-port).
    ///
    /// Registered POST-Arc (call from main.rs after `Arc::new(ai_manager)`), NOT in core
    /// tool_registry: the handler re-enters AiManager itself, so it captures a `Weak` self
    /// reference — builder-time registration has no Arc yet, and tool_registry must not know
    /// AiManager (it would also break the GHA registered-tool-count assertion).
    ///
    /// Parallelism = the tool takes a `tasks` ARRAY and fans out internally
    /// (`buffer_unordered`) — zero dispatcher surgery, and the model states the whole batch in
    /// one call. Each task runs `process_with_tools_opts` with an EMPTY history (isolation)
    /// and default LlmCallOpts → the adapter resolves the MAIN model (decomposition delegation
    /// = main-tier by design; the cheap-worker axis lives in pipeline LLM_TRANSFORM instead).
    ///
    /// Recursion guard: FC path = hard (effective_tools gate on `ai_opts.sub_agent`).
    /// Hosted-MCP/CLI sub-runs can still see the MCP-side tool, so the description carries the
    /// prohibition (TS-era approach) — depth beyond 1 is discouraged, not fatal.
    pub fn register_spawn_subagent_tool(self: &Arc<Self>) {
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "spawn_subagent".to_string(),
            description: "Delegate INDEPENDENT sub-tasks to isolated sub-agents that run in parallel (each is a full agent run on the main model, with tools, empty history). Use for large decomposable work (e.g. researching several subjects at once) — one call with ALL tasks in the `tasks` array; do NOT call this tool once per task. Not for small single-step work (call the tool directly instead). NEVER call spawn_subagent from within a sub-agent task prompt (no recursion). Approval-gated tools are rejected inside sub-agents.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "independent sub-tasks (max 8) — executed in parallel",
                        "items": {
                            "type": "object",
                            "properties": {
                                "prompt": { "type": "string", "description": "full self-contained instruction for this sub-agent (it sees NO conversation history)" },
                                "label": { "type": "string", "description": "short name for the result row" }
                            },
                            "required": ["prompt"]
                        }
                    }
                },
                "required": ["tasks"]
            }),
            source: "core".to_string(),
        });
        let weak = Arc::downgrade(self);
        self.tools.register_handler(
            "spawn_subagent",
            crate::managers::tool::make_handler(move |args| {
                let weak = weak.clone();
                async move {
                    let mgr = weak
                        .upgrade()
                        .ok_or_else(|| "AI manager unavailable".to_string())?;
                    // Second guard (TS 1:1) — the exposure filter can be bypassed by direct
                    // MCP calls or stale history; the toggle must hold at dispatch too.
                    if !mgr.is_sub_agent_enabled() {
                        return Err(
                            "spawn_subagent is disabled — enable the Sub-agent toggle in settings first."
                                .to_string(),
                        );
                    }
                    let tasks: Vec<(String, String)> = args
                        .get("tasks")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|t| {
                                    let prompt = t.get("prompt")?.as_str()?.trim().to_string();
                                    if prompt.is_empty() {
                                        return None;
                                    }
                                    let label = t
                                        .get("label")
                                        .and_then(|l| l.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    Some((prompt, label))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if tasks.is_empty() {
                        return Err(
                            "spawn_subagent needs tasks: [{\"prompt\": \"...\", \"label\"?}] — at least one non-empty prompt."
                                .to_string(),
                        );
                    }
                    if tasks.len() > 8 {
                        return Err(format!(
                            "too many tasks ({}) — max 8 per call. Merge related sub-tasks or run a second batch after this one.",
                            tasks.len()
                        ));
                    }
                    // Concurrency cap: CLI main model = OS process per run (950MB server) → 2.
                    // API models are network-bound → 4.
                    let main_model = mgr
                        .vault
                        .as_ref()
                        .and_then(|v| v.get_secret(crate::vault_keys::VK_SYSTEM_AI_MODEL))
                        .unwrap_or_default();
                    let is_cli = crate::llm::registry::current()
                        .find_model(&main_model)
                        .map(|m| m.format.starts_with("cli-"))
                        .unwrap_or(false);
                    let cap = if is_cli { 2 } else { 4 };
                    mgr.log.info(&format!(
                        "[AiManager] spawn_subagent: {} task(s), concurrency {}",
                        tasks.len(),
                        cap
                    ));
                    use futures_util::stream::StreamExt;
                    let mut results: Vec<(usize, serde_json::Value)> =
                        futures_util::stream::iter(tasks.into_iter().enumerate().map(
                            |(i, (prompt, label))| {
                                let mgr = mgr.clone();
                                async move {
                                    let ai_opts = crate::ports::AiRequestOpts {
                                        sub_agent: true,
                                        ..Default::default()
                                    };
                                    let res = mgr
                                        .process_with_tools_opts(
                                            &prompt,
                                            &[],
                                            &LlmCallOpts::default(),
                                            &ai_opts,
                                        )
                                        .await;
                                    let row = match res {
                                        Ok(r) => {
                                            // Reply capped — sub-agent output feeds the parent's
                                            // context; a runaway essay must not blow the window.
                                            let reply: String = r.reply.chars().take(4000).collect();
                                            let actions: Vec<String> = r
                                                .executed_actions
                                                .iter()
                                                .filter_map(|a| {
                                                    a.as_str()
                                                        .map(str::to_string)
                                                        .or_else(|| {
                                                            a.get("name")
                                                                .and_then(|n| n.as_str())
                                                                .map(str::to_string)
                                                        })
                                                })
                                                .collect();
                                            serde_json::json!({
                                                "label": label,
                                                "reply": reply,
                                                "actions": actions,
                                                "incomplete": r.exhausted || r.forced_final,
                                            })
                                        }
                                        Err(e) => serde_json::json!({
                                            "label": label,
                                            "error": e,
                                        }),
                                    };
                                    (i, row)
                                }
                            },
                        ))
                        .buffer_unordered(cap)
                        .collect()
                        .await;
                    results.sort_by_key(|(i, _)| *i);
                    Ok(serde_json::json!({
                        "success": true,
                        "results": results.into_iter().map(|(_, r)| r).collect::<Vec<_>>(),
                    }))
                }
            }),
        );
    }

    /// DynamicToolRegistry 설정한 채로 부팅 — sysmod_* / mcp_* 자동 등록 활성.
    pub fn with_dynamic_tools(
        mut self,
        registry: Arc<dynamic_tools::DynamicToolRegistry>,
    ) -> Self {
        self.dynamic_tools = Some(registry);
        self
    }

    /// ToolDispatcher 설정한 채로 부팅 — approval gate (write_file/save_page 덮어쓰기 / delete_* /
    /// schedule_task / cancel_cron_job) 활성. cron agent 모드는 우회 (server-side 실행).
    pub fn with_tool_dispatcher(mut self, dispatcher: Arc<ToolDispatcher>) -> Self {
        self.dispatcher = Some(dispatcher);
        self
    }

    /// ConversationManager 설정한 채로 부팅 — CLI session resume 활성 (model 이 `cli-` 로 시작 + 대화
    /// ID 설정되어 있을 때). 옛 TS getCliSession / setCliSession 1:1.
    pub fn with_conversation_manager(mut self, conversation: Arc<ConversationManager>) -> Self {
        self.conversation = Some(conversation);
        self
    }

    /// `search_components(query)` 도구 등록 — 옛 TS search_components handler 1:1.
    /// IEmbedderPort 설정되어 있을 때만 호출. ToolManager 에 직접 register_handler.
    ///
    /// 사용 예 (Rust):
    /// ```ignore
    /// let ai = AiManager::new(llm, tools, log)
    ///     .register_search_components_tool(embedder.clone());
    /// // AI 가 `search_components({"query": "주식 차트"})` 호출 시 top-5 컴포넌트 + propsSchema 반환
    /// ```
    pub fn register_search_components_tool(
        self,
        embedder: Arc<dyn crate::ports::IEmbedderPort>,
        cache_port: Arc<dyn crate::ports::IEmbedderCachePort>,
    ) -> Self {
        let embedder_clone = embedder.clone();
        let cache_clone = cache_port.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let embedder = embedder_clone.clone();
            let cache = cache_clone.clone();
            async move {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);
                let opts = crate::managers::ai::component_search_index::ComponentSearchOpts { limit };
                let matches =
                    crate::managers::ai::component_search_index::query(embedder.clone(), cache.clone(), &query, opts)
                        .await?;
                Ok(serde_json::json!({
                    "components": matches,
                    "count": matches.len(),
                }))
            }
        });
        self.tools.register_handler("search_components", handler);
        // 도구 schema 도 등록 — LLM 에게 노출.
        self.tools
            .register(crate::managers::tool::ToolDefinition {
                name: "search_components".to_string(),
                description: "사용자 발화 → 관련 render_* 컴포넌트 top-K 반환 (이름 + 설명 + propsSchema). render(name, props) 호출 전에 어떤 컴포넌트가 적합한지 검색 시 사용.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "검색 쿼리 (사용자 발화 또는 컴포넌트 의도)",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "반환 개수 (default 5)",
                        }
                    },
                    "required": ["query"],
                }),
                source: "core".to_string(),
            });
        self
    }

    /// Module action catalog tools (#search-tool S2) — progressive disclosure for big sysmods
    /// (korea-invest 275 / kiwoom 200+ action enums). `search_module_actions` = cross-module
    /// semantic candidates → `get_action_schema` = exact params + call envelope. Registered as
    /// source="core" so register_builtin_tools auto-syncs both to hosted MCP (dual-registry rule).
    pub fn register_action_catalog_tools(
        mut self,
        catalog: Arc<crate::managers::ai::action_catalog::ModuleActionCatalog>,
    ) -> Self {
        /// Widget scoping for the discovery tools (search_module_actions / get_action_schema):
        /// which modules a hub-WIDGET visitor may see in results. Reuses the SINGLE shared policy
        /// (hub_context::permits_tool — the same one the FC tool filter and the MCP dispatch gate
        /// use), so this is not a new parallel rule. hub-TENANT (full_tools = admin-clone) and admin
        /// see everything. Context = injected args (_hubScope/_allowedSysmods/_fullTools — present
        /// on both FC and MCP, same injection as the other discovery tools) with a task-local
        /// fallback for the MCP path.
        fn hub_module_allowed(args: &serde_json::Value, module: &str) -> bool {
            let is_hub = args
                .get("_hubScope")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false)
                || crate::utils::hub_context::is_hub_context_active();
            if !is_hub {
                return true; // admin (root) — unrestricted
            }
            if args.get("_fullTools").and_then(|v| v.as_bool()).unwrap_or(false)
                || crate::utils::hub_context::active_full_tools()
            {
                return true; // hub-tenant = admin-clone, sees all
            }
            let allowed: Vec<String> = args
                .get("_allowedSysmods")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .or_else(crate::utils::hub_context::active_allowed_sysmods)
                .unwrap_or_default();
            crate::utils::hub_context::permits_tool(&format!("sysmod_{module}"), &allowed)
        }
        // Intent Agent S0 — 같은 카탈로그를 shadow TurnBrief 계산에도 공유 (행동 0, 측정 전용).
        self.intent_actions = Some(catalog.clone());
        let cat = catalog.clone();
        let search_handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = cat.clone();
            async move {
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
                // The catalog covers a FIXED set of modules — say so in every response.
                // Silence made models retry a search that could never succeed (2026-07-07:
                // "toss-invest create-order" ×9 — toss had no catalog, so the results never
                // contained it and the model kept searching in disbelief).
                let cataloged: Vec<String> = cat
                    .cataloged_modules()
                    .await
                    .into_iter()
                    .filter(|m| hub_module_allowed(&args, m))
                    .collect();
                // Module filter dialect absorb: strip sysmod_ prefix + underscore↔hyphen
                // ("sysmod_toss_invest" ≡ "toss-invest" — models see underscore tool names).
                let module = args
                    .get("module")
                    .and_then(|v| v.as_str())
                    .map(|s| {
                        let m = s.trim_start_matches("sysmod_").to_string();
                        if cataloged.contains(&m) {
                            m
                        } else {
                            let h = m.replace('_', "-");
                            if cataloged.contains(&h) { h } else { m }
                        }
                    });
                if let Some(m) = module.as_deref() {
                    if !cataloged.contains(&m.to_string()) {
                        return Ok(serde_json::json!({
                            "actions": [],
                            "count": 0,
                            "catalogedModules": cataloged,
                            "note": format!(
                                "module '{m}' has NO action catalog — searching will NEVER find its actions. \
                                 Call the module tool (sysmod_{m}) directly; its own description/enum + input \
                                 validation errors will guide you (or consult get_module_config)."
                            ),
                        }));
                    }
                }
                let (mut rows, all_oov, dropped) =
                    cat.search_analyzed(&query, module.as_deref(), limit.clamp(1, 20)).await?;
                if all_oov {
                    // Zero-signal query (every token is a subject name / OOV for the catalog) —
                    // returning junk top-K here fed the death spiral (junk looks like results →
                    // the model re-searches variations until the cap, 2026-07-11/12 실측 3턴).
                    return Ok(serde_json::json!({
                        "actions": [],
                        "count": 0,
                        "error": format!(
                            "Query {:?} contains no capability words — it looks like a subject \
                             name only. Actions are searched by WHAT they do (e.g. 일봉 차트, \
                             잔고 조회, 실시간 체결), never by a subject's name. Re-search with a \
                             capability description, and resolve the subject's code with a \
                             lookup/list action — then pass it as a parameter.",
                            dropped.join(" ")
                        ),
                    }));
                }
                // Widget scoping — a hub-widget visitor only sees modules in its allowlist
                // (cross-module search could otherwise reveal admin-only modules).
                rows.retain(|r| {
                    r.get("module")
                        .and_then(|v| v.as_str())
                        .map(|m| hub_module_allowed(&args, m))
                        .unwrap_or(true)
                });
                let mut resp = serde_json::json!({
                    "actions": rows,
                    "count": rows.len(),
                    "next": "Rows with kind=\"action\": call get_action_schema(module, action) for exact params + call envelope before invoking. Rows with kind=\"stream\": this is a live realtime subscription — call stream_watch_start({module, stream, args}) and render the returned topic with a live_chart / live_feed component (a REST action can only give a static snapshot, never live data). Identifiers are MODULE-SCOPED — an action/stream belongs only to the module in its own row; never reuse a name from one module on another. Only the catalogedModules are searchable — an action of any OTHER module will never appear here; call that module directly instead of re-searching.",
                });
                // catalogedModules only on cross-module searches — a module-scoped search already
                // resolved its module; repeating the 18-name list every call is token noise.
                if module.is_none() {
                    resp["catalogedModules"] = serde_json::json!(cataloged);
                }
                Ok(resp)
            }
        });
        self.tools.register_handler("search_module_actions", search_handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "search_module_actions".to_string(),
            description: "Semantic search over module ACTIONS (broker/API modules with hundreds of cryptic action IDs). Describe what data/operation you need in natural language → ranked candidates across all cataloged modules (or one module via `module`). NEVER guess an action ID for a large module — search first, then call get_action_schema for exact params. Results flag requiresApproval (real-money orders).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "what you need, in natural language. Pack synonyms (Korean + English) of the capability into ONE query — e.g. \"일봉 일별 차트 캔들 daily candle\" — one rich query beats several terse retries. Never put a subject name (company/stock/region) in it." },
                    "module": { "type": "string", "description": "optional module name to scope the search (e.g. kiwoom, korea-invest)" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"],
            }),
            source: "core".to_string(),
        });
        let cat2 = catalog.clone();
        let schema_handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = cat2.clone();
            async move {
                let raw_module = args
                    .get("module")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches("sysmod_")
                    .to_string();
                // Dialect absorb — underscore↔hyphen module name (search handler와 동일).
                let module = if cat.has_module(&raw_module).await {
                    raw_module
                } else {
                    let h = raw_module.replace('_', "-");
                    if cat.has_module(&h).await { h } else { raw_module }
                };
                // Widget scoping — do not reveal a module's action schema to a hub-widget visitor
                // whose allowlist excludes it (same shared policy as the search filter).
                if !hub_module_allowed(&args, &module) {
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": format!("module '{module}' is not available in this workspace."),
                    }));
                }
                let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
                match cat.schema(&module, &action).await {
                    Some(s) => Ok(s),
                    // Two very different misses (2026-07-07 실측): an uncataloged MODULE must not
                    // be pointed back at search — search can never find it, so that hint created
                    // an infinite schema→search→schema loop. Only a bad ACTION of a cataloged
                    // module should re-search.
                    None if !cat.has_module(&module).await => Ok(serde_json::json!({
                        "success": false,
                        "error": format!(
                            "module '{m}' has NO action catalog — do NOT search for it (search_module_actions will never list it). \
                             Call the module tool (sysmod_{m}) directly with its documented action; its input validation errors \
                             will guide you, and get_module_config('{m}') shows the full input schema.",
                            m = module
                        ),
                    })),
                    None => {
                        // Did-you-mean — a bad action id of a cataloged module used to bounce the
                        // model back to search (another round, more loop fuel). Resolve the near
                        // matches right here: one dead-end becomes the next step.
                        let close = cat
                            .search(&action, Some(&module), 3)
                            .await
                            .unwrap_or_default();
                        Ok(serde_json::json!({
                            "success": false,
                            "error": format!(
                                "no catalog entry for {}:{} — this action id does not exist; do not invent IDs and do not retry it.",
                                module, action
                            ),
                            "didYouMean": close,
                            "next": "Pick one of didYouMean (kind=\"stream\" → stream_watch_start; kind=\"action\" → get_action_schema then call), or search_module_actions with completely different words.",
                        }))
                    }
                }
            }
        });
        // Discovery tools are the thrash-prone class (2026-07-07: search ×19 burned a whole
        // turn) — cap per turn. Generous for legitimate multi-topic turns (표+차트+주문 ≈ 3-6).
        // 6→8 (2026-07-12 18차): 4-부품 복합(차트+스트림+메신저+전일종가)의 정당 검색 수요가
        // 6 을 넘는 첫 실측 — 문서화된 인상 트리거("정당 수요가 캡에 막힌 첫 실측에서 올림").
        self.tools.set_per_turn_limit("search_module_actions", 8);
        self.tools.set_per_turn_limit("get_action_schema", 8);
        // Discovery classification rides per_turn_limit declarations — an UNDECLARED discovery
        // tool leaks into the action class (19차 실측: get_module_config 성공이 "grounded
        // action succeeded"로 집계 → stall 재개방 + 날조 배너 억제 + 원장 DONE 오염).
        self.tools.set_per_turn_limit("get_module_config", 4);
        self.tools.register_handler("get_action_schema", schema_handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "get_action_schema".to_string(),
            description: "Exact detail for ONE module action found via search_module_actions: parameter names + descriptions, an example, and the module's call envelope (how to shape the tool call). Call this before invoking an unfamiliar action of a large module — do not guess params.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "module": { "type": "string", "description": "module name (e.g. kiwoom, korea-invest)" },
                    "action": { "type": "string", "description": "action id from search_module_actions (e.g. ka10081)" }
                },
                "required": ["module", "action"],
            }),
            source: "core".to_string(),
        });
        self
    }

    /// Domain discovery catalogs (#search-tool 확장) — skills/templates/pages/media 시맨틱 검색.
    /// search_skills·search_media 는 core 등록(substring 판)을 **오버라이드**(register_handler =
    /// HashMap insert = last wins; MCP auto-sync 프록시는 ToolManager dispatch 위임이라 자동 전파).
    /// search_templates·search_pages 는 신설. 전부 source="core" = hosted MCP auto-sync.
    ///
    /// Owner scoping: 인덱스 = system + admin 코퍼스만(스케일 주체). hub 세션은 skills=["system:"]
    /// / 나머지=[](빈 결과) — admin 자료 누수 0, per-session 임베딩 churn 0 (hub 자기 자료는
    /// list/index 도구가 커버, 세션 자료는 원래 소수).
    pub fn register_discovery_search_tools(
        mut self,
        skills: Arc<crate::managers::skill_file::SkillFileManager>,
        templates: Arc<crate::managers::template::TemplateManager>,
        pages: Arc<crate::managers::page::PageManager>,
        media_mgr: Arc<crate::managers::media::MediaManager>,
        embedder: Arc<dyn crate::ports::IEmbedderPort>,
        cache_port: Arc<dyn crate::ports::IEmbedderCachePort>,
    ) -> Self {
        use crate::managers::ai::domain_catalogs::*;
        use crate::managers::ai::semantic_catalog::RefreshingCatalog;
        const TTL: std::time::Duration = std::time::Duration::from_secs(300);

        fn is_hub_call(args: &serde_json::Value) -> bool {
            args.get("_hubScope")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        }
        fn q_of(args: &serde_json::Value) -> String {
            args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string()
        }
        fn lim_of(args: &serde_json::Value) -> usize {
            (args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize).clamp(1, 20)
        }

        // ── search_skills (semantic 승격 — 옛 substring 판 오버라이드) ──
        let skill_cat = Arc::new(RefreshingCatalog::new(
            "skill-catalog",
            embedder.clone(),
            cache_port.clone(),
            Arc::new(SkillCatalogSource { skills }),
            TTL,
        ));
        // Intent Agent S0 — 스킬 카탈로그도 shadow TurnBrief 공유 (측정 전용).
        self.intent_skills = Some(skill_cat.clone());
        let sc = skill_cat.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = sc.clone();
            async move {
                let scopes: Vec<String> = if is_hub_call(&args) {
                    vec!["system:".into()]
                } else {
                    vec!["system:".into(), "admin:".into()]
                };
                let hits = cat.query(&q_of(&args), lim_of(&args), Some(&scopes)).await?;
                let rows: Vec<serde_json::Value> = hits
                    .into_iter()
                    .map(|m| serde_json::json!({
                        "slug": m.extra.get("slug").cloned().unwrap_or_default(),
                        "name": m.name,
                        "kind": m.extra.get("kind").cloned().unwrap_or_default(),
                        "description": m.description,
                        "score": m.score,
                    }))
                    .collect();
                Ok(serde_json::json!({ "skills": rows, "count": rows.len(), "next": "get_skill(slug) for the full manual" }))
            }
        });
        self.tools.register_handler("search_skills", handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "search_skills".to_string(),
            description: "Semantic search over skill manuals (case playbooks — how to use tools/templates for a task). Describe the task in natural language; matches by meaning, not just substring. Use when the <SKILLS_AVAILABLE> index is truncated or the right slug isn't obvious. Next: get_skill(slug).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "task description (natural language)" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"],
            }),
            source: "core".to_string(),
        });

        // ── search_templates (신설) ──
        let tpl_cat = Arc::new(RefreshingCatalog::new(
            "template-catalog",
            embedder.clone(),
            cache_port.clone(),
            Arc::new(TemplateCatalogSource { templates }),
            TTL,
        ));
        let tc = tpl_cat.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = tc.clone();
            async move {
                let scopes: Vec<String> = if is_hub_call(&args) { vec![] } else { vec!["admin:".into()] };
                let hits = cat.query(&q_of(&args), lim_of(&args), Some(&scopes)).await?;
                let rows: Vec<serde_json::Value> = hits
                    .into_iter()
                    .map(|m| serde_json::json!({
                        "slug": m.extra.get("slug").cloned().unwrap_or_default(),
                        "name": m.name,
                        "description": m.description,
                        "tags": m.extra.get("tags").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                        "score": m.score,
                    }))
                    .collect();
                Ok(serde_json::json!({ "templates": rows, "count": rows.len(), "next": "get_template(slug) for the spec skeleton" }))
            }
        });
        self.tools.register_handler("search_templates", handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "search_templates".to_string(),
            description: "Semantic search over page templates (reusable page skeletons). Describe the page you need (e.g. daily stock report, weekly weather digest); matches name/description/tags by meaning. Use before building a recurring-format page — prefer a matching template over building from scratch. Next: get_template(slug).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "what kind of page you need" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"],
            }),
            source: "core".to_string(),
        });

        // ── search_pages (신설) ──
        let page_cat = Arc::new(RefreshingCatalog::new(
            "page-catalog",
            embedder.clone(),
            cache_port.clone(),
            Arc::new(PageCatalogSource { pages }),
            TTL,
        ));
        let pc = page_cat.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = pc.clone();
            async move {
                let scopes: Vec<String> = if is_hub_call(&args) { vec![] } else { vec!["admin:".into()] };
                let hits = cat.query(&q_of(&args), lim_of(&args), Some(&scopes)).await?;
                let rows: Vec<serde_json::Value> = hits
                    .into_iter()
                    .map(|m| serde_json::json!({
                        "slug": m.extra.get("slug").cloned().unwrap_or_default(),
                        "title": m.name,
                        "project": m.extra.get("project").cloned().unwrap_or_default(),
                        "status": m.extra.get("status").cloned().unwrap_or_default(),
                        "score": m.score,
                    }))
                    .collect();
                Ok(serde_json::json!({ "pages": rows, "count": rows.len(), "next": "get_page(slug) for the full spec" }))
            }
        });
        self.tools.register_handler("search_pages", handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "search_pages".to_string(),
            description: "Semantic search over published pages by title/excerpt (meaning, not substring). Use to find an existing page before creating/updating one (avoid duplicate slugs, link related pages). Next: get_page(slug).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "page topic or title fragment" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"],
            }),
            source: "core".to_string(),
        });

        // ── search_media (semantic 승격 — 옛 substring 판 오버라이드) ──
        let media_cat = Arc::new(RefreshingCatalog::new(
            "media-catalog",
            embedder.clone(),
            cache_port.clone(),
            Arc::new(MediaCatalogSource { media: media_mgr }),
            TTL,
        ));
        let mc = media_cat.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let cat = mc.clone();
            async move {
                let scopes: Vec<String> = if is_hub_call(&args) { vec![] } else { vec!["admin:".into()] };
                let hits = cat.query(&q_of(&args), lim_of(&args), Some(&scopes)).await?;
                let rows: Vec<serde_json::Value> = hits
                    .into_iter()
                    .map(|m| serde_json::json!({
                        "slug": m.extra.get("slug").cloned().unwrap_or_default(),
                        "name": m.name,
                        "prompt": m.description.chars().take(160).collect::<String>(),
                        "contentType": m.extra.get("contentType").cloned().unwrap_or_default(),
                        "score": m.score,
                    }))
                    .collect();
                Ok(serde_json::json!({ "media": rows, "count": rows.len() }))
            }
        });
        self.tools.register_handler("search_media", handler);
        self.tools.register(crate::managers::tool::ToolDefinition {
            name: "search_media".to_string(),
            description: "Semantic search over the media gallery by generation prompt / filename (meaning-based — a description of the image works, exact words not required). Use to find an existing image before generating a new one.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "what the image is about" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"],
            }),
            source: "core".to_string(),
        });
        // Same thrash-prone discovery class — per-turn caps (search_module_actions 참조).
        for name in ["search_skills", "search_templates", "search_pages", "search_media", "search_components"] {
            self.tools.set_per_turn_limit(name, 6);
        }
        self
    }

    /// HistoryResolver 설정한 채로 부팅 — opts.conversation_id 설정되어 있으면 recent N 메시지 자동 prepend.
    pub fn with_history_resolver(mut self, conversation: Arc<ConversationManager>) -> Self {
        self.history_resolver = Some(HistoryResolver::new(conversation));
        self
    }

    /// CostManager 설정한 채로 부팅 — LLM 호출마다 자동 비용 누적 (옛 TS recordLlmCost 패턴).
    pub fn with_cost_manager(mut self, cost: Arc<CostManager>) -> Self {
        self.cost = Some(cost);
        self
    }

    /// PromptBuilder 설정한 채로 부팅 — 시스템 프롬프트 자동 주입 활성.
    /// Prompt md 본문은 통합 i18n loader (`firebat_core::i18n`) 가 부팅 시점에 자동 scan
    /// (`system/prompts/{name}/lang/{lang}.md`). 별도 loader 어댑터 wiring 0.
    pub fn with_prompt_builder(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.prompt_builder = Some(PromptBuilder::new(vault));
        self
    }

    /// SystemContextGatherer 설정한 채로 부팅 — 시스템 프롬프트에 sysmod / mcp 동적 description 자동 주입.
    pub fn with_system_context(
        mut self,
        module: Arc<ModuleManager>,
        mcp: Arc<crate::managers::mcp::McpManager>,
    ) -> Self {
        self.context_gatherer = Some(Arc::new(SystemContextGatherer::new(module, mcp)));
        self
    }

    /// ToolManager 등록 도구 → ports::ToolDefinition (LLM-facing) 변환.
    /// 옛 TS buildToolDefinitions Rust port — 정적 27개 + 동적 sysmod_* / mcp_* / render_* 모두 포함.
    /// 새 도구 추가 시 ToolManager 에 register 만 하면 자동 LLM 에 전달됨 (코드 변경 0).
    pub fn build_tool_definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .list(&ToolListFilter::default())
            .into_iter()
            .map(|t| ToolDefinition {
                name: t.name,
                description: t.description,
                input_schema: Some(t.parameters),
            })
            .collect()
    }

    /// 단순 텍스트 응답 — 도구 호출 없음 (Code Assistant 등 활용).
    pub async fn ask_text(&self, prompt: &str, opts: &LlmCallOpts) -> InfraResult<String> {
        let response = self.llm.ask_text(prompt, opts).await?;
        Ok(response.text)
    }

    /// Monaco 에디터 통합 AI 어시스턴트 — 옛 TS `codeAssist` 1:1.
    ///
    /// 두 모드:
    /// - 설명 모드 (instruction 에 "알려줘/설명/분석/리뷰" 키워드) — 마크다운 응답
    /// - 코드 모드 (그 외) — raw 코드만, 코드펜스 자동 strip
    pub async fn code_assist(
        &self,
        params: &code_assist::CodeAssistParams<'_>,
        ai_opts: &AiRequestOpts,
    ) -> InfraResult<String> {
        code_assist::code_assist(self.llm.as_ref(), params, ai_opts).await
    }

    /// Function Calling 멀티턴 도구 루프 (LlmCallOpts 만 받는 simple 진입점).
    /// 옛 TS 호환 — AiRequestOpts 기본값 (PlanMode::Off / cron_agent: None) 으로 process_with_tools_opts 호출.
    pub async fn process_with_tools(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
    ) -> InfraResult<AiResponse> {
        self.process_with_tools_opts(prompt, tools, opts, &AiRequestOpts::default())
            .await
    }

    /// Function Calling 멀티턴 도구 루프 — 옛 TS `processWithTools` 1:1 port.
    ///
    /// 통합 알고리즘 (옛 TS ai-manager.ts:888-1597 1:1):
    /// - **Plan modes** (off/auto/always) — 시스템 프롬프트 prefix + 첫 turn user prompt hint
    /// - **MAX_TOOL_TURNS dynamic** — cron_agent=Some 시 25, 아니면 10
    /// - **Dynamic temperature** — 도구 turn 0.2, 요약 turn 0.85
    /// - **Tool retry guard** — Layer 1 (cross-turn cache) + Layer 2 (per-turn HashSet)
    /// - **propose_plan early termination** — 호출 감지 시 trailing text drop + break
    /// - **Render component blocks** — RENDER_TOOL_MAP 매칭 + result.component → blocks
    /// - **Dedup text block** — signature 기반 중복 detect → 두 번째 push 스킵
    ///
    /// 후속 (별도 batch):
    /// - Approval gate 통합 (ToolDispatcher 와이어링 후)
    /// - CLI session resume / Plan store integration / Auto search_history
    /// - internallyUsedTools / innerBlocks / innerPending / innerSuggestions (LlmToolResponse 확장 후)
    /// streaming variant — `emit` channel 이 설정되어 있으면 매 turn 의 reasoning chunk + 도구 호출 step
    /// 이 채널로 전송됨. None 이면 옛 unary 동작 (event 발생 0).
    pub async fn process_with_tools_opts(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
        ai_opts: &AiRequestOpts,
    ) -> InfraResult<AiResponse> {
        self.process_with_tools_opts_with_emit(prompt, tools, opts, ai_opts, None)
            .await
    }

    /// streaming variant — emit 채널 받음. mpsc::Sender 가 있으면 매 turn 의 reasoning chunk +
    /// 도구 호출 step 이 채널로 전송됨. None = 옛 unary 동작 (event 발생 0).
    /// gRPC server-stream impl 가 본 메서드를 통해 채널을 받아 → tonic Stream 변환.
    /// Persist the user message for this chat turn — the single persist point shared by admin & hub
    /// (owner/id injected via ai_opts). No-op without conversation / conversation_id / user_msg_id
    /// (cron/agent turns have no chat UI). Runs server-side so it survives client SSE disconnect.
    fn persist_user_msg(&self, ai_opts: &AiRequestOpts, content: &str) {
        let (Some(conv), Some(conv_id), Some(uid)) = (
            &self.conversation,
            ai_opts.conversation_id.as_deref(),
            ai_opts.user_msg_id.as_deref().filter(|s| !s.is_empty()),
        ) else {
            return;
        };
        let owner = ai_opts.owner.as_deref().unwrap_or("admin");
        let mut msg = serde_json::json!({
            "id": uid, "role": "user", "content": content,
            "createdAt": crate::utils::time::now_ms(),
        });
        if let Some(o) = msg.as_object_mut() {
            if let Some(img) = ai_opts.user_image.as_deref().filter(|s| !s.is_empty()) {
                o.insert("image".to_string(), serde_json::json!(img));
            }
            if ai_opts.user_suggestion {
                o.insert("suggestionClick".to_string(), serde_json::json!(true));
            }
        }
        conv.append(owner, conv_id, &msg);
    }

    /// Persist the AI (system) message for this chat turn — single point (admin & hub), canonical
    /// `message_data_json`. No-op without conversation / conversation_id / ai_msg_id. Pass the redacted
    /// response (via `finalize`) so secrets are never stored. Detached server-side → survives disconnect.
    fn persist_system_msg(&self, ai_opts: &AiRequestOpts, response: &AiResponse) {
        let (Some(conv), Some(conv_id), Some(aid)) = (
            &self.conversation,
            ai_opts.conversation_id.as_deref(),
            ai_opts.ai_msg_id.as_deref().filter(|s| !s.is_empty()),
        ) else {
            return;
        };
        let owner = ai_opts.owner.as_deref().unwrap_or("admin");
        let payload = response.message_data_json();
        let mut msg = serde_json::json!({
            "id": aid, "role": "system", "content": response.reply,
            "createdAt": crate::utils::time::now_ms(),
        });
        if let Some(o) = msg.as_object_mut() {
            for k in ["executedActions", "toolResults", "suggestions", "pendingActions", "libraryHits"] {
                if let Some(v) = payload.get(k) {
                    o.insert(k.to_string(), v.clone());
                }
            }
            o.insert("data".to_string(), payload);
        }
        conv.append(owner, conv_id, &msg);
    }

    /// Redact + persist the system message + return the redacted response — one helper for every
    /// return point of the tool loop (success and early/error returns), so the system message is
    /// persisted exactly once in the single shared path.
    fn finalize(&self, ai_opts: &AiRequestOpts, response: AiResponse) -> AiResponse {
        let red = redact_response(response);
        self.persist_system_msg(ai_opts, &red);
        red
    }

    /// Persist a TERMINAL-error record for a turn that failed with no answer (LLM 400 / missing API
    /// key / etc.) — so the conversation keeps a record instead of an orphan user bubble. Only
    /// permanent failures reach this: a recoverable SSE disconnect still completes server-side and
    /// persists the *real* answer via `finalize`, so this never masks a real reply. The `error`
    /// field marks it terminal for the frontend (rendered as an error, kept on reload — unlike
    /// transient session-only fallbacks). No-op without conversation / conversation_id / ai_msg_id.
    /// Persist a terminal-error record for the turn. `reasoning_trace` = the rounds collected
    /// BEFORE the failure — without it a mid-loop 400 destroys every CoT of the turn and the
    /// incident cannot be read back afterwards (2026-07-10 실측: F2→tools:[] 400 으로 죽은
    /// 22시 cron·채팅 턴들의 추론이 통째로 소실 — 어느 검색을 왜 돌았는지 판독 불가였다).
    fn finalize_error(
        &self,
        ai_opts: &AiRequestOpts,
        err: &str,
        reasoning_trace: &[serde_json::Value],
    ) {
        let (Some(conv), Some(conv_id), Some(aid)) = (
            &self.conversation,
            ai_opts.conversation_id.as_deref(),
            ai_opts.ai_msg_id.as_deref().filter(|s| !s.is_empty()),
        ) else {
            return;
        };
        let owner = ai_opts.owner.as_deref().unwrap_or("admin");
        let mut msg = serde_json::json!({
            "id": aid, "role": "system", "content": err, "error": err,
            "createdAt": crate::utils::time::now_ms(),
        });
        if !reasoning_trace.is_empty() {
            msg["data"] = serde_json::json!({ "reasoningTrace": reasoning_trace });
        }
        conv.append(owner, conv_id, &msg);
    }

    pub async fn process_with_tools_opts_with_emit(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
        ai_opts: &AiRequestOpts,
        emit: Option<mpsc::Sender<AiStreamEvent>>,
    ) -> InfraResult<AiResponse> {
        // Persist the user message upfront (single shared path, server-side) — before the LLM loop so it is
        // AI-error-safe AND survives client SSE disconnect (= the background-resume regression root: admin
        // used to persist in the client-tied TS route). No-op for cron/agent turns (no user_msg_id).
        self.persist_user_msg(ai_opts, prompt);

        // emit helper — None 이면 no-op. Some 이면 try_send (back-pressure 시 silent drop —
        // streaming 안에 critical 이벤트는 없고, drop 되어도 final result 는 그대로 전달).
        let emit_event = |evt: AiStreamEvent| {
            if let Some(tx) = &emit {
                let _ = tx.try_send(evt);
            }
        };
        // CLI 어댑터 streaming sink — LlmStreamEvent(thinking/tool step)를 turn 중 받아 AiStreamEvent 로
        // 매핑해 emit 채널로 포워딩. CLI 가 stdout 파싱하며 try_send → 사용자가 "생각중" 옆에 추론·도구
        // 진행 실시간 표시. emit 채널 없으면 sink None (어댑터는 batch 동작). ToolStep 의 한글 라벨은
        // core 의 tool_label 로 매핑.
        let llm_sink: Option<crate::ports::LlmStreamSink> = if let Some(out_tx) = emit.clone() {
            let (llm_tx, mut llm_rx) =
                tokio::sync::mpsc::channel::<crate::ports::LlmStreamEvent>(64);
            tokio::spawn(async move {
                while let Some(ev) = llm_rx.recv().await {
                    let mapped = match ev {
                        crate::ports::LlmStreamEvent::Thinking(t) => AiStreamEvent::Chunk {
                            event_type: "thinking".to_string(),
                            content: t,
                        },
                        crate::ports::LlmStreamEvent::ToolStep { name, status } => {
                            let description = Some(tool_label(&name));
                            AiStreamEvent::Step { name, status, description, error_message: None }
                        }
                    };
                    let _ = out_tx.try_send(mapped);
                }
            });
            Some(llm_tx)
        } else {
            None
        };
        // Cost budget guard — fast path 보다 먼저. fast path 도 LLM 호출 발생 → 한도 초과 시 차단.
        if let Some(cost) = &self.cost {
            let check = cost.check_budget();
            if !check.within_budget {
                let reason = check
                    .reason
                    .clone()
                    .unwrap_or_else(|| {
                        crate::i18n::t("core.error.ai.cost_limit_exceeded_short", None, &[])
                    });
                self.log.warn(&format!(
                    "[AiManager] budget exceeded — LLM call blocked: {}",
                    reason
                ));
                return Ok(self.finalize(ai_opts, AiResponse {
                    error: Some(crate::i18n::t(
                        "core.error.ai.cost_limit_exceeded",
                        None,
                        &[("reason", &reason)],
                    )),
                    model_id: Some(self.llm.get_model_id()),
                    cost_usd: Some(0.0),
                    ..Default::default()
                }));
            }
        }

        // 옛 fast path (is_simple_chat 휴리스틱) 폐기 (2026-05-11).
        // 짧은 query 가 fast path 로 빠져 sysmod 도구 누락 → "삼성전자 현재가 얼마야" 같은
        // 자연 query 가 도구 호출 못 하던 root cause. LLM 자체 판단 위임 (단순 인사도
        // 도구 schema 는 같이 전달되지만 LLM 이 자체 응답).

        let mut effective_opts = opts.clone();

        // 이미지 slug URL → data URL 변환 (옛 commit `6af42b2` 후 frontend 가 base64 → slug URL
        // 전환했는데 LLM adapter 영역의 base64 가정 코드는 그대로라 발생한 silent fail fix).
        // /user/attachments/<filename> 또는 /user/media/<slug>.<ext> 형태이면 fs read + base64
        // data URL 변환. data: prefix 가 이미 있거나 변환 불가면 옛 값 그대로 (회귀 안전).
        if let Some(img) = &effective_opts.image {
            if !img.starts_with("data:") {
                if let Some(data_url) = self.resolve_image_to_data_url(img).await {
                    self.log.info(&format!(
                        "[AiManager] image slug URL converted to data URL (slug len={}, data len={})",
                        img.len(),
                        data_url.len()
                    ));
                    effective_opts.image = Some(data_url);
                } else {
                    self.log.warn(&format!(
                        "[AiManager] image slug URL conversion failed — passing original to LLM: {}",
                        img
                    ));
                }
            }
        }

        // library_hits(SourceTags) — library 자동주입 비활성 후 항상 빈 채로 노출(2026-06-27).
        // 자동주입 SourceTags 노이즈 제거 → 라이브러리 사용은 search_library 도구 액션뱃지로만 표시.
        let retrieved_library_hits: Vec<crate::ports::LibraryHit> = Vec::new();

        // MCP 토큰 자동 주입 — vault 에서 `system:internal-mcp-token` 가져와 LlmCallOpts 에 추가.
        // hosted MCP 모델 (CLI 3종 / Anthropic API / OpenAI Responses API) 이 Firebat MCP
        // server 인증할 때 사용. caller 가 안 주면 vault 에서 자동 조회.
        if effective_opts.mcp_token.is_none() {
            if let Some(vault) = &self.vault {
                let token = vault.get_secret("system:internal-mcp-token");
                if let Some(t) = token.filter(|s| !s.is_empty()) {
                    effective_opts.mcp_token = Some(t);
                }
            }
        }
        // MCP base URL 결정 — FIREBAT_MCP_BASE_URL env 또는 Vault `system:mcp-base-url` 우선,
        // 미설정 시 Next.js 폴백 (`http://127.0.0.1:3000`). 새 Rust MCP endpoint 으로 전환 시
        // env 또는 Vault 에 `http://127.0.0.1:50052` (default FIREBAT_MCP_LISTEN) 을 설정.
        if effective_opts.mcp_base_url.is_none() {
            if let Some(cfg) = &self.config_port {
                if let Some(env_url) = cfg.get("FIREBAT_MCP_BASE_URL") {
                    if !env_url.is_empty() {
                        effective_opts.mcp_base_url = Some(env_url);
                    }
                }
            }
            if effective_opts.mcp_base_url.is_none() {
                if let Some(vault) = &self.vault {
                    if let Some(v) = vault.get_secret("system:mcp-base-url") {
                        if !v.is_empty() {
                            effective_opts.mcp_base_url = Some(v);
                        }
                    }
                }
            }
        }

        // hosted MCP 지원 모델 분기 — features.mcp_connector 기반 (CLI 3종 + Anthropic API +
        // OpenAI Responses). 토큰 없으면 즉시 명시 에러 (silent stdio fallback → "도구 없음"
        // hallucinate 차단). MCP 미지원 모델 (Gemini native / Vertex 등) 은 ai.rs 의
        // effective_tools schema 가 정공 (Function Calling 표준).
        // 두 경로(MCP register_builtin_tools ↔ ToolManager register_core_tools)의 도구 카탈로그
        // 동기화 책임은 tool.rs 모듈 doc 참조 — 한쪽만 등록 시 그 모델군에서 도구 누락 (drift).
        let supports_mcp = self.llm.supports_hosted_mcp(&effective_opts);
        if supports_mcp && effective_opts.mcp_token.is_none() {
            let model_id = effective_opts
                .model
                .clone()
                .unwrap_or_else(|| self.llm.get_model_id());
            return Ok(self.finalize(ai_opts, AiResponse {
                error: Some(
                    "MCP 토큰이 등록되어 있지 않습니다. 설정 - 시스템 - mcp-server-llm 에서 토큰을 생성해 주세요."
                        .to_string(),
                ),
                model_id: Some(model_id),
                cost_usd: Some(0.0),
                ..Default::default()
            }));
        }

        // 도구 list 결정:
        // - MCP 지원 모델 → 빈 배열 (자체 MCP loop 또는 hosted connector 가 직접 조회)
        // - MCP 미지원 모델 + caller 가 tools 안 주면 → ToolManager 등록 도구 전체
        // - caller 가 tools 명시하면 → 그대로 사용
        let auto_tools: Vec<ToolDefinition>;
        let effective_tools: &[ToolDefinition] = if supports_mcp {
            // hosted MCP 모델 — schema 전달 불필요. 동적 도구 refresh 도 skip
            // (어차피 LLM handler 가 무시 → 비용 + 토큰 절감).
            auto_tools = Vec::new();
            &auto_tools
        } else if tools.is_empty() {
            // MCP 미지원 모델 — 동적 도구 (sysmod_* / mcp_*) refresh + ToolManager 전체.
            if let Some(dyn_reg) = &self.dynamic_tools {
                dyn_reg.refresh().await;
            }
            let mut tools_built = self.build_tool_definitions();
            // hub 모드 도구 필터 — 외부 사이트 안 destructive (admin DB 영구 변경) 만 차단.
            //
            // 허용 영역:
            //   (1) `sysmod_<name>` — allowed_sysmods 에 있는 것만 (instance 설정 제어)
            //   (2) `render_*` — UI 렌더 도구
            //   (3) read-only / 정보 조회 — list_*, get_*, search_*, suggest, propose_plan, cache_*
            //   (4) 채팅 컨텍스트 — recall / library 검색 부분
            //   (5) `save_page` — hub-scoped (project='hub:<slug>' 자동, root /<slug> 노출 0,
            //                     hub 삭제 시 cascade). 사용자 의도 = "지 사이드바 안에서 갖고 놀고 공유 돼야".
            //
            // Owner-scoped writes are ALLOWED to hub but CONFINED to the visitor's own scope (not blocked):
            //   save_page/delete_page (project-match guard) / write_file/delete_file/read_file/list_dir
            //   (confine_hub_path → user/hub/<inst>/) / save_entity / regenerate_image / save_template, etc.
            // Truly blocked (settings/auth/background/admin): request_secret / network_request / run_module /
            //   execute / schedule_task / run_task / run_cron_job / *_module / mcp_* / log.
            if let Some(ctx) = &ai_opts.hub_context {
                // Tenant hub = full-workspace (admin-clone scoped to its own owner) → skip the widget gate
                // entirely (Principal::has_full_tools). Data isolation stays via owner injection, not this filter.
                // Widget = anonymous embed → apply the single permission gate (same hub_context::permits_tool as
                // the hosted mcp_server path, no drift): core sysmods + allowed_sysmods + read-only + render_* +
                // owner-scoped writes. Owner-scoping of allowed writes is per-tool (confine_hub_path / project-match).
                if !ctx.full_tools {
                    tools_built
                        .retain(|t| crate::utils::hub_context::permits_tool(&t.name, &ctx.allowed_sysmods));
                }
            }
            // spawn_subagent exposure gate — hidden when the vault toggle is OFF (cost safety
            // net, TS-era 1:1), inside a sub-agent run (recursion guard, depth 1), or in any
            // hub context (sub-agents run with admin-grade tool access; a widget/tenant turn
            // must not fan out). Handler keeps a second guard for direct/MCP calls.
            if !self.is_sub_agent_enabled() || ai_opts.sub_agent || ai_opts.hub_context.is_some() {
                tools_built.retain(|t| t.name != "spawn_subagent");
            }
            auto_tools = tools_built;
            &auto_tools
        } else {
            tools
        };

        // MAX_TOOL_TURNS 동적 결정 — cron agent 모드 25 / admin 10. 옛 TS 1:1.
        let max_turns = if ai_opts.cron_agent.is_some() {
            MAX_TOOL_TURNS_CRON
        } else {
            MAX_TOOL_TURNS_ADMIN
        };

        // 시스템 프롬프트 자동 주입 + plan_mode prefix.
        // 옛 TS `finalSystemPrompt = planExecuteRule + planModePrefix + systemPrompt + autoHistoryContext + memorySection`
        // 1:1. 본 step 에선 planExecuteRule (plan-store) / autoHistoryContext (router) 미저장 — 후속 batch.

        // ── Intent Agent S0+L1 — TurnBrief (shortlist 계산 + 후보 주입) ──
        // 쿼리를 액션/스킬 카탈로그와 E5 매칭한 shortlist. 용도 2:
        // (1) L1-lite 주입 — <LIKELY_TOOLS> 로 시스템 프롬프트에 후보 제시(세계 좁히기 아님,
        //     탈출구 유지 — 후보가 틀리면 검색으로). 2026-07-11 실측 3연속: 발견에 검색 캡을
        //     전부 태우고 정답을 쥔 채 소진 — 후보 선주입이 발견 라운드 자체를 줄이는 구조 해법.
        // (2) S0 섀도우 — 턴 종료 시 실제 디스패치와 대조해 recall 을 journal(intent_shadow) 기록.
        // 비용 = 쿼리 E5 임베딩 2회(로컬, ms 단위). 카탈로그 미배선(테스트 등) = skip.
        let mut shadow_actions: Vec<(String, f32)> = Vec::new(); // "module:action"
        let mut shadow_skills: Vec<(String, f32)> = Vec::new(); // slug
        if prompt.trim().len() >= 2 {
            if let Some(cat) = &self.intent_actions {
                if let Ok(rows) = cat.search(prompt, None, 8).await {
                    for r in rows {
                        let m = r.get("module").and_then(|v| v.as_str()).unwrap_or("");
                        let a = r.get("action").and_then(|v| v.as_str()).unwrap_or("");
                        let s = r.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                        if !m.is_empty() && !a.is_empty() {
                            shadow_actions.push((format!("{m}:{a}"), s));
                        }
                    }
                }
            }
            if let Some(cat) = &self.intent_skills {
                let scopes = vec!["system:".to_string(), "admin:".to_string()];
                if let Ok(hits) = cat.query(prompt, 3, Some(&scopes)).await {
                    for h in hits {
                        let slug = h
                            .extra
                            .get("slug")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| h.id.clone());
                        shadow_skills.push((slug, h.score));
                    }
                }
            }
        }

        // Plan compiled replay (2026-07-11) — steps the planning turn verified down to
        // tool+args are replayed as a synthetic round-0 through the SAME gated dispatch
        // (approval / grounding / validation / caps), skipping the LLM for that round.
        // Filled by the plan_execute block below; consumed at the loop's LLM-call site.
        let mut plan_replay_raw: Vec<ToolCall> = Vec::new();
        // Serialized plan steps — provenance seed for the grounding gate (the user approved
        // this plan; its identifiers were verified by the planning turn's tool results).
        let mut plan_provenance: Option<String> = None;

        if effective_opts.system_prompt.is_none() {
            if let Some(pb) = &self.prompt_builder {
                let mut extra_parts: Vec<String> = Vec::new();
                if let Some(g) = &self.context_gatherer {
                    let ctx = g.gather().await;
                    if !ctx.is_empty() {
                        extra_parts.push(ctx);
                    }
                }
                // Admin CLI convId reinforcement (#1-lite + #4) — for FC, ai.rs injects convId into the
                // tool args, but the CLI (its own MCP loop) has no such injection path. So on admin
                // (non-hub) turns, hint the AI to pass convId itself for the tools that key off the
                // conversation: start_build/advance_build/cancel_build (cross-turn build continuity) and
                // tts (generated audio is stored per-conversation so it is cleaned up when the conversation
                // is deleted — without it the audio lands in a shared bucket and never cascades).
                // (hub uses the hubOwner key, excluded.)
                if ai_opts.hub_context.is_none() {
                    if let Some(cid) = ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty()) {
                        extra_parts.push(format!(
                            "[Conversation id] When calling start_build/advance_build/cancel_build (build continuity) or tts (so the generated audio is tied to this conversation), also pass convId=\"{}\".",
                            cid
                        ));
                    }
                }
                // PB 빌드 세션 진행 중이면 지식 retrieval(벡터 history + Recall/library) skip — 빌드 진행 칩
                // ("Just do it all"·"advance" 등)이 그대로 prompt 라 검색이 헛돌고 엉뚱한 컨텍스트가 주입됨
                // (낭비 + 빌드 방해). recent 연속성(resolve)·hub history 는 유지.
                let build_active = effective_opts
                    .conversation_id
                    .as_deref()
                    .or(ai_opts.conversation_id.as_deref())
                    .filter(|s| !s.is_empty())
                    .map(|cid| crate::utils::build_session::active_session_for_conv(cid).is_some())
                    .unwrap_or(false);
                // Conversation history — ONE path for admin & hub (owner/conv_id injected; no hub/admin branch).
                // Direct recent-N from the single owner-keyed store (robust, always present — now includes AI
                // replies via resolve's system→AI fix) + vector recall of relevant older/cross-conv turns as a
                // supplement. The old split (hub used hub_context.history / admin used the resolver) was the
                // divergence that made admin lose context when the embedding lagged. owner = the injected id.
                if let Some(hr) = &self.history_resolver {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    let conv_id = effective_opts
                        .conversation_id
                        .as_deref()
                        .or(ai_opts.conversation_id.as_deref());
                    // 직전 연속성 — recent N턴 (현재 대화, owner-keyed 단일 스토어).
                    if let Some(hist) = hr.resolve(owner, conv_id) {
                        extra_parts.push(hist);
                    }
                    // 관련 과거 회상 — 벡터(E5) 보강. 빌드 세션 중엔 skip (진행 칩이 prompt 라 헛돔).
                    if !build_active {
                        let search = hr
                            .compress_history_with_search(
                                prompt,
                                &history_resolver::CompressHistoryOpts {
                                    owner: Some(owner.to_string()),
                                    current_conv_id: conv_id.map(String::from),
                                },
                            )
                            .await;
                        if !search.context_summary.is_empty() {
                            extra_parts.push(search.context_summary);
                        }
                    }
                }
                // hub instance 커스텀 지침 — admin 엔 없는 capability(history 아님). 기본 프롬프트(에이전트·plan·
                // render 규칙)에 **추가** 합성 (hub_context 있을 때만 = 정당한 capability 게이트).
                if let Some(directive) = ai_opts
                    .hub_context
                    .as_ref()
                    .and_then(|c| c.instance_directive.as_deref())
                    .filter(|d| !d.trim().is_empty())
                {
                    extra_parts.push(format!("## 이 어시스턴트의 추가 지침\n{}", directive));
                }

                // RetrievalEngine 자동 prepend (Recall 회상) — **토글 무관 항상** (Phase C split, 2026-06-14).
                // 회상(읽기)은 E5 라 싸고 "저장한 건 써야" → 늘 주입. 토글(VK_SYSTEM_AI_ROUTER_ENABLED)은
                // 이제 자동 *쓰기*(cron consolidation 추출)만 게이트한다 (옛엔 read+write 통합 게이트였음).
                // owner-scope = retrieve_opts.owner (hub = 자기 hub Recall), library = reference_filter 로
                // hub allowed_references 제한 → cross-tenant 안전.
                // 빌드 세션 중엔 Recall/library 회상 skip (filter) — 빌드 진행 칩이 prompt 라 무의미.
                if let Some(engine) = self.retrieval_engine.as_ref().filter(|_| !build_active) {
                    let owner_s = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin")
                        .to_string();
                    let conv_id = effective_opts
                        .conversation_id
                        .as_deref()
                        .or(ai_opts.conversation_id.as_deref())
                        .map(String::from);
                    // hub_context 가 있으면 library 를 allowed_references 로 제한 (인덱스·검색 공통).
                    let reference_filter = ai_opts
                        .hub_context
                        .as_ref()
                        .map(|c| c.allowed_references.clone());
                    // library 청크 자동주입 비활성(limit 0) — 무관 query 에도 매번 주입·SourceTags 뜨던
                    // 노이즈+토큰낭비 차단. 대신 아래 얇은 인덱스만 상시 노출 + 본문은 search_library 온디맨드
                    // (회색 액션뱃지). entity/fact/event/history 회상은 그대로(ambient + self-gated).
                    let retrieve_opts = retrieval_engine::RetrieveOpts {
                        query: prompt.to_string(),
                        owner: Some(owner_s.clone()),
                        current_conv_id: conv_id,
                        limits: retrieval_engine::RetrievalLimits {
                            library: Some(0),
                            ..Default::default()
                        },
                        reference_filter: reference_filter.clone(),
                    };
                    let result = engine.retrieve(&retrieve_opts).await;
                    if !result.context_summary.is_empty() {
                        // RetrievalEngine already wraps in <RETRIEVED_CONTEXT> — push as-is (no double-wrap).
                        extra_parts.push(result.context_summary);
                    }
                    // library 자동주입 안 하므로 library_hits(SourceTags)도 비움 — search_library 도구 호출
                    // 시에만 액션뱃지로 표시(AI 가 실제 찾았을 때만). 아래 인덱스로 discover.
                    let extra_ids = reference_filter.unwrap_or_default();
                    if let Some(index) = engine.library_index(&owner_s, &extra_ids).await {
                        const LIB_INDEX_CAP: usize = 4000;
                        let body = if index.chars().count() > LIB_INDEX_CAP {
                            let t: String = index.chars().take(LIB_INDEX_CAP).collect();
                            format!("{t}\n… (truncated — more references exist; search_library covers them all)")
                        } else {
                            index
                        };
                        extra_parts.push(format!(
                            "<LIBRARY_AVAILABLE>\n{body}\n(Reference documents — NOT auto-injected. When the user's request relates to one, call search_library to retrieve and cite its content.)\n</LIBRARY_AVAILABLE>"
                        ));
                    }
                }

                // Operational memory (data/memory) — 큐레이트 운영지식 인덱스. ai-router 토글과
                // 무관하게 *항상* 주입 (CLAUDE.md 가 늘 로드되듯). 위 RetrievalEngine(Recall) 은
                // 자동/의미 store 라 토글 게이트지만, 이건 손으로 관리(+자동 distill)한 운영지식이라
                // 켜든 끄든 항상 효력. per-owner: admin => 자기 data/memory / hub:<inst>:<sid> =>
                // 그 세션 것만 (누수 0). 어드민 편집 UI 는 설정 모달이라 hub 엔 없지만(설정 부재),
                // 기능 자체는 hub 도 동작 — 방문자 턴이 manual 로 저장한 메모리가 회상됨.
                if let Some(mf) = &self.memory_file {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    if let Ok(index) = mf.get_index(Some(owner)).await {
                        if !index.trim().is_empty() {
                            const MEM_INDEX_CAP: usize = 4000;
                            let body = if index.chars().count() > MEM_INDEX_CAP {
                                let truncated: String =
                                    index.chars().take(MEM_INDEX_CAP).collect();
                                format!(
                                    "{truncated}\n… (truncated — use memory_read for full entries)"
                                )
                            } else {
                                index
                            };
                            extra_parts.push(format!(
                                "<OPERATIONAL_MEMORY>\n{}\n</OPERATIONAL_MEMORY>",
                                body
                            ));
                        }
                    }
                }
                // Skills (case 매뉴얼) 인덱스 — 슬러그+설명만 상시 주입, 본문은 온디맨드(get_skill).
                // 메모리와 달리 admin + hub 둘 다(owner 전달 → system ∪ owner 스킬). 토글 무관.
                if let Some(sf) = &self.skill_file {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    if let Ok(index) = sf.get_index(Some(owner)).await {
                        if !index.trim().is_empty() {
                            const SKILL_INDEX_CAP: usize = 4000;
                            let body = if index.chars().count() > SKILL_INDEX_CAP {
                                let truncated: String =
                                    index.chars().take(SKILL_INDEX_CAP).collect();
                                format!("{truncated}\n… (truncated — use list_skills / search_skills)")
                            } else {
                                index
                            };
                            extra_parts.push(format!(
                                "<SKILLS_AVAILABLE>\n{}\n</SKILLS_AVAILABLE>",
                                body
                            ));
                        }
                    }
                }
                // Tracked-entities thin index — graph self-steering for recall writes: the model
                // sees what is already tracked (reuse factType labels, set supersede on state
                // updates, record new facts about these + new subjects of similar kinds). Always
                // injected (cheap, no embeddings); admin + hub (owner-scoped).
                if let Some(re) = &self.retrieval_engine {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    if let Some(index) = re.entity_index(owner).await {
                        const ENTITY_INDEX_CAP: usize = 4000;
                        let body = if index.chars().count() > ENTITY_INDEX_CAP {
                            let truncated: String =
                                index.chars().take(ENTITY_INDEX_CAP).collect();
                            format!("{truncated}\n… (truncated — use search_entities for the rest)")
                        } else {
                            index
                        };
                        extra_parts.push(format!(
                            "<TRACKED_ENTITIES>\n{}\n</TRACKED_ENTITIES>",
                            body
                        ));
                    }
                }
                // Memory write mode — 토글이 *proactive*(자율 durable) 저장만 게이트. 명시 "기억해"는
                // 항상 허용 / 자율 저장은 토글 ON 일 때만(안 시킨 tool-call 토큰 소비라 opt-in).
                // owner=="admin" 만 주입 (hub 는 태그 없음 → tool_system 이 manual 로 간주).
                {
                    let mw_owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    if crate::principal::Principal::from_owner(mw_owner).is_admin {
                        let auto = self
                            .vault
                            .as_ref()
                            .and_then(|v| v.get_secret(crate::vault_keys::VK_SYSTEM_AI_ROUTER_ENABLED))
                            .map(|v| v == "true" || v == "1")
                            .unwrap_or(false);
                        let mode = if auto {
                            "auto — record what's worth remembering using your judgment: both when the user asks and when you recognize clearly durable information. Durable means true OUTSIDE this conversation — never record conversation activity ('the user asked/requested X') as a fact or event; the chat itself is already stored."
                        } else {
                            "manual — record only what the user is clearly asking you to keep. Do NOT proactively save anything they didn't ask you to remember this turn."
                        };
                        extra_parts.push(format!("<MEMORY_WRITE_MODE>\n{mode}\n</MEMORY_WRITE_MODE>"));
                    }
                }
                // Intent L1-lite — 후보 선주입 (2026-07-11). shortlist 는 힌트일 뿐 세계를 좁히지
                // 않는다(전 도구·검색 그대로). 발견 표면이 커버하는 것은 후보로 즉시 보이고, 후보가
                // 틀리면 모델이 평소처럼 검색한다. admin 턴만(hub 는 카탈로그 스코프가 다름).
                if ai_opts.hub_context.is_none()
                    && (!shadow_actions.is_empty() || !shadow_skills.is_empty())
                {
                    let mut lines: Vec<String> = Vec::new();
                    for (id, score) in shadow_actions.iter().take(5) {
                        lines.push(format!("- action {} ({:.2})", id, score));
                    }
                    for (slug, score) in shadow_skills.iter().take(2) {
                        lines.push(format!("- skill {} ({:.2}) — get_skill first", slug, score));
                    }
                    extra_parts.push(format!(
                        "<LIKELY_TOOLS>\nAutomatic matches for this request (candidates, NOT commands — scores are rough). If one fits, go straight to get_action_schema(module, action) / get_skill(slug) instead of searching; if none fit, search as usual.\n{}\n</LIKELY_TOOLS>",
                        lines.join("\n")
                    ));
                }
                let extra = if extra_parts.is_empty() {
                    None
                } else {
                    Some(extra_parts.join("\n\n"))
                };
                // cron_agent 옵션 → PromptBuilder 의 CronAgentContext 변환.
                // ai_opts.cron_agent 가 Some 일 때만 cron 전용 prelude (system/prompts/cron_agent)
                // 가 base 시스템 프롬프트 앞에 prepend 됨. cron 발화 시 LLM 이 "이건 자동 실행이다,
                // 즉시 도구 호출해라" 인식 — 옛에 schedule.rs 가 cron_agent 를 전달하지 않아 admin chat
                // 표준 prompt 만 받음 → LLM 이 agentPrompt 를 "신규 사용자 요청" 으로 잘못 해석 →
                // sysmod 호출 0 silent fail issue 의 진짜 root cause.
                let cron_ctx = ai_opts.cron_agent.as_ref().map(|c| {
                    crate::managers::ai::prompt_builder::CronAgentContext {
                        job_id: c.job_id.clone(),
                        title: c.title.clone(),
                    }
                });
                // user-prompt owner: for a hub session, inject that owner's (hub:<inst>:<sid>) personal instructions;
                // for admin, inject the global (None). Same shape as other hub data owner-scoping.
                let up_owner: Option<String> = ai_opts.hub_context.as_ref().map(|c| {
                    let scope = if c.session_id.is_empty() {
                        c.instance_id.clone()
                    } else {
                        format!("{}:{}", c.instance_id, c.session_id)
                    };
                    format!("hub:{}", scope)
                });
                let base_prompt = pb.build(extra.as_deref(), cron_ctx.as_ref(), up_owner.as_deref());

                // plan_execute_id / plan_revise_id 우선 처리 — 사용자 ✓실행 / ⚙수정 클릭 후 follow-up
                // turn. plan_store 에서 조회 → 시스템 프롬프트 prepend + 옛 plan_prefix 우회 (plan 카드
                // 재제안 안 함). 옛 TS `planExecuteRule` 흐름 1:1.
                // + compiled replay (2026-07-11): 플랜 턴이 tool+args 까지 확정한 스텝은 실행 턴이
                // LLM 재발견 없이 합성 라운드-0 으로 기계 재생 (아래 plan_replay_raw 소비 지점 참조).
                let plan_instruction: Option<String> = if let Some(pid) =
                    ai_opts.plan_execute_id.as_deref().filter(|s| !s.is_empty())
                {
                    if let Some(plan) = crate::utils::plan_store::get_plan(pid) {
                        let inst = crate::utils::plan_store::plan_to_instruction(&plan, None);
                        let compiled = crate::utils::plan_store::compiled_calls(&plan);
                        if !compiled.is_empty() {
                            // The approved plan card IS provenance — its args were verified by
                            // the planning turn's tool results, so the grounding gate must
                            // accept them on replay (the codes won't re-appear in this turn's
                            // own tool results before the replayed call runs).
                            plan_provenance = serde_json::to_string(&plan.steps).ok();
                            // Compiled-step name hygiene — the plan turn's model WRITES these
                            // names, and a one-letter slip poisons the whole replay (12차 실측:
                            // 플랜 스텝이 `sysmod_kiwom`(o 누락)+inputData 봉투를 굳혀 실행 턴
                            // r1 재생이 전부 unknown/검증 실패 → 독 청소에 라운드 소진).
                            // canonical_name absorbs prefix/underscore dialects; a residual
                            // near-miss (edit distance ≤ 2, unique candidate) is corrected;
                            // anything still unknown is DROPPED from replay — the step stays in
                            // the prose instruction and the agent path discovers it properly.
                            plan_replay_raw = compiled
                                .into_iter()
                                .enumerate()
                                .filter_map(|(i, (tool, args))| {
                                    let canon = self.tools.canonical_name(&tool);
                                    let name = if self.tools.has_handler(&canon) {
                                        canon
                                    } else if let Some(fixed) =
                                        self.tools.nearest_handler_name(&canon, 2)
                                    {
                                        self.log.warn(&format!(
                                            "[AiManager] plan step tool '{}' corrected to '{}' (near-match)",
                                            tool, fixed
                                        ));
                                        fixed
                                    } else {
                                        self.log.warn(&format!(
                                            "[AiManager] plan step tool '{}' unknown — dropped from replay (agent fallback)",
                                            tool
                                        ));
                                        return None;
                                    };
                                    Some(ToolCall {
                                        id: format!("plan-step-{}", i + 1),
                                        name,
                                        arguments: args,
                                    })
                                })
                                .collect();
                        }
                        crate::utils::plan_store::delete_plan(pid);
                        self.log.info(&format!(
                            "[AiManager] plan_execute_id: {} (title={}, compiled_steps={})",
                            pid,
                            plan.title,
                            plan_replay_raw.len()
                        ));
                        Some(inst)
                    } else {
                        self.log.warn(&format!(
                            "[AiManager] plan_execute_id {} not found (expired or missing) — continuing normal flow",
                            pid
                        ));
                        None
                    }
                } else if let Some(rid) =
                    ai_opts.plan_revise_id.as_deref().filter(|s| !s.is_empty())
                {
                    if let Some(plan) = crate::utils::plan_store::get_plan(rid) {
                        let inst = crate::utils::plan_store::plan_to_revise_instruction(&plan, prompt);
                        // revise 시 plan_store 항목 보존 — AI 가 propose_plan 재호출 후 새 planId 발급함.
                        self.log.info(&format!(
                            "[AiManager] plan_revise_id: {} (title={})",
                            rid, plan.title
                        ));
                        Some(inst)
                    } else {
                        self.log.warn(&format!(
                            "[AiManager] plan_revise_id {} not found — continuing normal flow",
                            rid
                        ));
                        None
                    }
                } else {
                    None
                };

                let plan_prefix = if plan_instruction.is_some() {
                    // 사용자가 이미 plan 결정한 단계 — 옛 plan_mode prefix (plan 카드 재제안 강제) 우회.
                    String::new()
                } else {
                    pb.plan_prefix(ai_opts.plan_mode)
                };
                let mut composed = if plan_prefix.is_empty() {
                    base_prompt
                } else {
                    format!("{}\n\n{}", plan_prefix, base_prompt)
                };
                if let Some(inst) = plan_instruction {
                    composed = format!("{}\n\n{}", inst, composed);
                }
                // Project Builder — if there is an active build session (per conversation), prepend the current step prompt.
                // Cross-turn forced flow — keep the AI on the same build even across the user's between-step replies.
                // scope key — hub: hubOwner (inst:sid, visitor isolation) / admin: conversation id.
                let build_scope: Option<String> = ai_opts.hub_context.as_ref().map(|c| {
                    if c.session_id.is_empty() { c.instance_id.clone() }
                    else { format!("{}:{}", c.instance_id, c.session_id) }
                }).or_else(|| ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty()).map(String::from));
                if let Some(cid) = build_scope.as_deref() {
                    // New user turn — clear the active build session's awaiting gate (allow one advance this turn = interactive step enforcement).
                    // was_awaiting = the user is replying to options we presented last turn → advance, do NOT re-present.
                    let was_awaiting = crate::utils::build_session::reset_awaiting_for_conv(cid);
                    if let Some(sess) = crate::utils::build_session::active_session_for_conv(cid) {
                        if sess.step == crate::utils::build_session::BuildStep::Implement {
                            // The build reached its last step (Implement = page built + save_page) on a previous
                            // turn. Finish it so this fresh turn (e.g. a follow-up or modify request) does NOT
                            // re-enter the build context — otherwise the 구현 card lingered on later messages.
                            crate::utils::build_session::finish_session(&sess.id, true);
                        } else if was_awaiting {
                            // The user is replying to the options we presented last turn — advance, do NOT
                            // re-present. (Re-injecting the step_prompt "present suggest" made the AI re-emit the
                            // same chips instead of advancing = the loop the user hit.)
                            composed = format!(
                                "[Project Builder — sessionId={}, current step: {}] You presented this step's options last turn and the user has now replied. Their reply IS the answer to this step — whether they checked options, ADDED or removed some, typed their own, or clicked a shortcut (recommend / all-in / skip). Call advance_build(sessionId=\"{}\", output=<their full reply>, tier?, auto=true only for the all-in shortcut) to record it and move on — the NEXT step's options come back in that tool result, so do NOT call suggest for THIS step again (re-presenting is the loop). Adding or changing options is NOT a reason to re-ask; that IS the selection you advance with. ONLY skip advancing if the reply is clearly off-topic — an unrelated question, or a request to restart / change the whole app — then handle that. To stop, call cancel_build(sessionId).\n\n{}",
                                sess.id, sess.step.key(), sess.id, composed
                            );
                        } else {
                            let sp = crate::utils::build_session::step_prompt(sess.step, sess.tier);
                            composed = format!(
                                "[Project Builder in progress — sessionId={}, current step: {}]\n{}\nOnly one step advances per turn — present the options as suggest chips and, after the user chooses, call advance_build(sessionId=\"{}\", output, tier?, auto?) (calling before selection is rejected by the engine). To stop, call cancel_build(sessionId).\n\n{}",
                                sess.id, sess.step.key(), sp, sess.id, composed
                            );
                        }
                    }
                }
                effective_opts.system_prompt = Some(composed);
            }
        }

        let mut prior_results: Vec<ToolResult> = Vec::new();
        let mut executed_actions: Vec<serde_json::Value> = Vec::new();
        let mut tool_results_summary: Vec<crate::ports::ToolResultSummary> = Vec::new();
        let mut blocks: Vec<serde_json::Value> = Vec::new();
        let mut pending_actions: Vec<serde_json::Value> = Vec::new();
        // CLI 자체 MCP loop 가 호출한 suggest / propose_plan 결과 누적 — 함수 끝 AiResponse.suggestions 에 포함.
        let mut cli_suggestions: Vec<serde_json::Value> = Vec::new();
        let mut last_text = String::new();
        let mut last_model_id = self.llm.get_model_id();
        let mut total_cost: f64 = 0.0;
        // 학습 로그 + 다음 turn Gemini thought_signature echo 용 — 옛 TS `toolExchanges` 1:1.
        // ToolExchangeEntry 에 tool_calls + tool_results + raw_model_parts 동시 보존 →
        // 다음 turn `opts.tool_exchanges` 로 어댑터에 echo (Gemini thought_signature 보존 필수).
        let mut tool_exchanges: Vec<crate::ports::ToolExchangeEntry> = Vec::new();
        // L1 grounding corpus (FC path, #8-2) — provenance the model legitimately observed this turn:
        // the user prompt (user-typed codes) + each successful tool result. A declared opaque param
        // (e.g. a stock code) must appear here or the call is rejected with a resolve hint. Mirror of
        // the MCP session accumulator; shares the pure check_grounding helper.
        let mut observed: Vec<String> = vec![prompt.to_string()];
        if let Some(p) = &plan_provenance {
            // Approved-plan identifiers are legitimate provenance (verified during planning).
            observed.push(p.clone());
        }
        // cron agent 모드는 approval gate 우회 (UI 없는 server-side 자율 발행).
        let approval_enabled = self.dispatcher.is_some() && ai_opts.cron_agent.is_none();

        // Plan replay partition — approval-gated compiled steps (schedule_task, orders) are NOT
        // pre-run: their pending card force-ends the turn, which would cut off the synthesis
        // round. They stay in the instruction text (with verbatim args) for the model to call
        // in the synthesis round — the card then ends the turn WITH the model's written context.
        // Replay is FC-path only: hosted-MCP/CLI models run tools inside their own loop and
        // never see our prior_results, so pre-run results would be invisible to them.
        let mut plan_replay_calls: Vec<ToolCall> = Vec::new();
        if !plan_replay_raw.is_empty() && !effective_tools.is_empty() {
            for call in plan_replay_raw.drain(..) {
                let gated = approval_enabled
                    && match &self.dispatcher {
                        Some(d) => d.check_needs_approval(&call).await.is_some(),
                        None => false,
                    };
                if gated {
                    self.log.info(&format!(
                        "[AiManager] plan replay — approval-gated step deferred to model: {}",
                        call.name
                    ));
                } else {
                    plan_replay_calls.push(call);
                }
            }
        }

        // Hub visitor 호출 — 턴별 고유 MCP 토큰 발급 + 컨텍스트 맵 등록 → 그 토큰을 mcp_token 으로 주입.
        // CLI 의 MCP 호출이 그 토큰으로 자기 컨텍스트만 보게 해 동시 visitor race(답 꼬임/누수) 차단.
        // MCP server handler 가 토큰으로 컨텍스트를 찾아 owner 격리 + allowed_sysmods 검사. Guard drop = 등록 해제.
        let _hub_guard = ai_opts.hub_context.as_ref().map(|ctx| {
            let (guard, token) = crate::utils::hub_context::HubContextGuard::enter(
                ctx.allowed_sysmods.clone(),
                ctx.instance_id.clone(),
                ctx.session_id.clone(),
                ctx.allowed_references.clone(),
                ctx.full_tools,
            );
            // shared internal token 대신 이 턴 토큰을 주입 — CLI 가 이 토큰으로 MCP 인증·컨텍스트 조회.
            effective_opts.mcp_token = Some(token);
            guard
        });

        // Layer 2 per-turn duplicate guard — turn 안에서 같은 (name + args) 두 번째 호출 차단.
        // 옛 TS `turnCallSet` 1:1.
        let mut turn_call_set: HashSet<String>;
        // 환각 도구(TaskCreate 등) cross-turn 차단 — 미등록 도구는 success:false 라 Layer 1 캐시 안 됨 +
        // turn_call_set 은 매 턴 리셋 → 옛엔 매 턴 재호출(x4/x7)되며 MAX_TOOL_TURNS 까지 낭비. 한 번
        // 미등록 확인된 이름은 이후 모든 턴에서 dispatch 없이 즉시 firm 에러 반환 (재시도 의미 0 강조).
        let mut unknown_tool_names: HashSet<String> = HashSet::new();
        // 승인 대기 pending 생성 감지 → propose_plan 처럼 그 턴에서 종료. 옛엔 계속 돌며 같은 주문을
        // 재시도(승인 카드 3장)하거나 run_task 파이프라인으로 우회 시도(2026-07-07 토스 매수 실측 —
        // pending note "재시도 금지"는 약한 모델이 무시) → 카드가 곧 다음 액션이므로 턴 종료가 정공.
        let mut approval_pending_created = false;
        // Turn-exhaustion detector — stays true only when the round loop burns all
        // MAX_TOOL_TURNS without a natural break (no-tool-calls / propose_plan / approval).
        // Used after the loop for an honest failure reply instead of a silent empty turn
        // (2026-07-07 실측: search 도구 스팸으로 25콜 소진 → reply/blocks 전부 빈 채 종료
        // → 화면 "응답이 비어있습니다" + DB 빈 row = 폴링 복구·히스토리 연속성까지 사망).
        let mut tool_budget_exhausted = true;
        // F2 — cap-rejected calls still burn a round. The rejection text tells the model to stop
        // and conclude, but a weak model ignores it: 2026-07-09 실측에서 Solar 는 그 지시를 11번
        // 무시하고 search_module_actions 를 계속 두드려 25 라운드를 소진하고 빈 답으로 끝났다.
        // 프롬프트로는 못 막으므로 구조로 막는다 — **2단계** (2026-07-11 재설계):
        //   stage 1 — 한 라운드가 전부 거부(캡 포함)면 캡에 걸린 (발견) 도구만 다음 라운드
        //   목록에서 뺀다. 액션 도구(sysmod/stream/render)는 남는다 — 07-11 날씨 cron 실측에서
        //   캡 시점에 모델은 이미 `short` 스키마 + telegram 까지 다 쥐고 있었는데 옛 F2 가
        //   전체를 떼는 바람에 완주 가능한 임무를 포기 선언으로 끝냈다. 좁힌 세계에서 실행하게
        //   두는 것이 정답.
        //   stage 2 — 좁힌 뒤에도 한 라운드가 전부 거부면 그때 전체를 떼서 최종 답을 강제한다
        //   (하드 스톱, forced_final 판정은 여기).
        let mut force_final = false;
        // stage 1 strip set — capped (discovery-class) tool names removed from later rounds.
        let mut capped_strip: HashSet<String> = HashSet::new();
        // Names the discovery-STALL close added to `capped_strip` (as opposed to individual
        // cap hits). The stall is a STATE, not a ratchet: its evidence is "orbiting discovery
        // without acting", so the moment a real action succeeds that evidence is gone and these
        // re-open (9차 실측: stall 폐쇄가 r6 stock_lookup 전이를 만든 것까진 설계였는데, 폐쇄가
        // 영구라 그 다음의 정당한 resolve→get_action_schema→call 사다리가 막혀 파라미터 발명
        // 산문으로 끝났다). Individually over-cap tools stay rejected by the per-tool counter
        // regardless, so re-opening only restores tools with remaining budget.
        let mut stall_stripped: HashSet<String> = HashSet::new();
        // stage 2 needs TWO consecutive fully-rejected rounds after narrowing — the first
        // rejection is how the model LEARNS discovery is closed (7차 실측: stall 폐쇄 직후
        // 첫 거부 라운드에서 곧바로 전 도구를 떼는 바람에 액션 도구로 행동할 기회가 0이었다).
        let mut post_narrow_rejected_rounds: usize = 0;
        // Progress after stage 1 — did any ACTION tool (no declared per-turn cap = not the
        // discovery class) succeed after narrowing? Used for the honest unattended verdict:
        // stage 1 + no real action afterwards = the turn never escaped its discovery loop,
        // and a text-only "natural finish" there must not count as cron mission success.
        let mut post_narrow_success = false;
        // Whole-turn grounding — did ANY action-class tool (no declared per-turn cap) succeed
        // at any point this turn? A forced-final turn without this has zero grounded data from
        // this turn, and the final text gets a deterministic fabrication-warning banner
        // (2026-07-12 실측: 강제종료 턴에서 Solar 가 차트 수치·계좌·"구독 성공"을 통째로
        // 지어냄 — 마감 지시의 honesty 조항은 무시됐다. 프롬프트로 못 막는 클래스 = 서버 스탬프).
        let mut turn_grounded_success = false;
        // No-silent-exit gate (19차 실측): a natural finish (no tool calls) after a turn full
        // of discovery with ZERO executed actions is the model ending as if work happened —
        // 산문 플랜("✓Run 눌러 주세요", 카드 없음) + 날조 종가가 그 출구로 나감. force_final
        // 경로엔 마감 지시·배너가 있는데 자연 종료엔 게이트가 없었다. One corrective round
        // (ledger + "call the tools or propose_plan") — the rejection/instruction channel is
        // the only one this model has obeyed 100%. Pure-chat turns (no discovery, empty
        // ledger) are untouched.
        let mut no_action_nudge_used = false;
        let mut nudge_this_round = false;
        // Turn ledger — "cards in hand" harvested from THIS turn's successes: ready-to-call
        // envelopes (schemas fetched), stream/action candidates (top search hits), and receipts
        // of completed actions. A weak model re-derives its plan from scratch every round and,
        // when a discovery call gets rejected, cannot map "act on what you have" to a concrete
        // call (10차 실측: r7 에 ka10081 스키마·코드·telegram 후보를 전부 쥐고도 r8~r12 를
        // 대안 재검색으로 소진 → force final 산문). The ledger is echoed verbatim inside
        // cap/duplicate rejections and the forced-final instruction so the exact next call (or
        // the honest "what was actually done") sits in front of the model — no recall required.
        let mut turn_ledger: Vec<String> = Vec::new();
        const TURN_LEDGER_MAX: usize = 10;
        fn ledger_push(ledger: &mut Vec<String>, entry: String) {
            if ledger.len() < TURN_LEDGER_MAX && !ledger.contains(&entry) {
                ledger.push(entry);
            }
        }
        fn ledger_note(ledger: &[String]) -> String {
            if ledger.is_empty() {
                return String::new();
            }
            format!(
                "\nAlready in hand this turn (from YOUR earlier calls — do not re-discover):\n{}\n\
                 Act on a READY/STREAM entry by calling it EXACTLY as written (fill only the \
                 param values), or answer using the DONE results.",
                ledger.join("\n")
            )
        }
        // Discovery-stall early close — N consecutive rounds of ONLY discovery-class calls
        // (= tools with a declared per-turn cap) means the model is orbiting the search layer
        // instead of acting (06차 실측: 검색 6회 전승·필요 정보 전부 확보 후에도 계속 검색 →
        // 캡 → search_components 로 갈아타기 → 소진). At the threshold ALL discovery tools are
        // closed at once (not just the capped one — the whack-a-mole hole of stage 1), leaving
        // the action tools + every result already gathered. Legit discovery for a composite
        // task is ~4-5 rounds; 5 consecutive rounds with zero action calls is stall evidence.
        const DISCOVERY_STALL_ROUNDS: usize = 5;
        let mut discovery_only_rounds: usize = 0;
        // Whole-turn seen-keys (never reset per round, unlike turn_call_set) — an identical
        // repeat across rounds is served from the Layer-1 cache with no signal, which quietly
        // feeds a search loop (07-11 실측: 같은 trade-unified 검색이 fromCache 로 재서빙).
        // The repeat gets an explicit note instead.
        let mut turn_seen_keys: HashSet<String> = HashSet::new();
        // Per-turn salt for the Layer-1 idempotency cache — scopes retry dedup to THIS turn.
        // Concurrent/back-to-back runs of the same job are independent intents and must both
        // execute (the invariant: two run logs = two telegram messages).
        let turn_cache_salt = uuid::Uuid::new_v4().simple().to_string();
        // Per-turn per-tool-name call counter — a goal-seeking model can thrash ONE tool
        // with slightly varying args, which neither Layer 1 (identical-args cache) nor
        // Layer 2 (identical-args set) catches. Tools may declare a per-turn cap on the
        // ToolManager (generic mechanism, declared at registration — no per-case logic here);
        // over the cap the call is rejected with a firm "proceed with what you have".
        let mut turn_tool_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        // Per-turn per-tool-name FAILURE counter — orthogonal to the attempt cap above.
        // A model can hammer ONE sysmod (not a declared-cap discovery tool) with a missing
        // required field, failing identically-but-not-byte-identically every round; the attempt
        // cap doesn't apply (sysmods declare none) and the dedup set misses it (args differ a bit).
        // Each such failure grows tool_exchanges until the context blows past the model's window
        // (2026-07-08 실측: korea-invest FID_ORG_ADJ_PRC 누락 8회 재시도 → 136K > 128K, 400).
        // Successful calls are NOT counted, so legitimate multi-calls (e.g. weather for 17 regions)
        // stay unbounded — only repeated FAILURE of the same tool is capped.
        let mut turn_fail_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        const PER_TURN_FAIL_CAP: usize = 4;
        // 리버스엔지니어링 관측 — 라운드별 reasoning + 호출 도구 + 실패 여부 누적.
        // 최종 AiResponse.reasoning_trace 로 canonical 영속 (사후 DB 판독).
        let mut reasoning_trace: Vec<serde_json::Value> = Vec::new();
        // 도구 없이 끝난 턴의 최종 답변 reasoning (reasoning_trace 는 도구-호출 라운드만 담아,
        // 검색 없이 바로 답한 턴 = 빈 배열이라 정작 "왜 도구를 안 썼나"를 못 봄).
        let mut final_reasoning: Option<String> = None;

        // CLI session resume — model 이 `cli-` 로 시작 + 대화 ID 설정되어 있으면 DB 에서 직전 session_id 조회.
        // 옛 TS ai-manager.ts:914-924 1:1. 모델 바뀌면 None 반환되어 새 세션으로 시작 (DB 조건절).
        let model_for_session = effective_opts
            .model
            .clone()
            .or_else(|| ai_opts.model.clone())
            .unwrap_or_else(|| self.llm.get_model_id());
        let conv_id_for_session = ai_opts.conversation_id.clone();
        if let (Some(conv_mgr), Some(conv_id)) = (&self.conversation, &conv_id_for_session) {
            if model_for_session.starts_with("cli-") {
                if let Some(sess) = conv_mgr.get_cli_session(conv_id, &model_for_session) {
                    self.log.info(&format!(
                        "[AiManager] CLI session resume: conv={} model={} session_id={}",
                        conv_id, model_for_session, sess
                    ));
                    effective_opts.cli_resume_session_id = Some(sess);
                }
            }
        }

        // 첫 turn user prompt — plan_mode hint prefix 자동 주입 (옛 TS promptForLlm 첫 turn 분기 1:1).
        // plan_execute_id / plan_revise_id 가 있으면 hint skip (시스템 프롬프트에 plan_instruction 들어감).
        let skip_plan_hint = ai_opts
            .plan_execute_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .is_some()
            || ai_opts
                .plan_revise_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .is_some();
        let prompt_with_hint: String = if skip_plan_hint {
            prompt.to_string()
        } else {
            match plan_mode::prompt_hint(ai_opts.plan_mode) {
                Some(hint) => format!("{}\n\n{}", hint, prompt),
                None => prompt.to_string(),
            }
        };

        // OpenAI Responses API previous_response_id — 멀티턴 토큰 절감.
        // 첫 turn 엔 effective_opts.previous_response_id (사용자 전달 값) 사용. 이후 turn 매번 갱신.
        let mut current_response_id: Option<String> = effective_opts.previous_response_id.clone();

        for turn in 0..max_turns {
            // Budget-exhaustion synthesis — the LAST round is always a forced final (tools=[]),
            // never another tool round. Without this, a turn that burned MAX_TOOL_TURNS exits
            // with a canned error that DISCARDS every completed result (12차 실측: r10~r24 에서
            // 차트 데이터·스트림 구독까지 성공해놓고 소진 exit 가 전부 버리고 "한도 도달" 문구만
            // 반환). The force_final path already carries the ledger ("verified this turn"),
            // the fabrication banner, and leak recovery — reuse it as the exhaustion exit.
            if turn == max_turns - 1 && !force_final && !prior_results.is_empty() {
                force_final = true;
                self.log.warn(&format!(
                    "[AiManager] tool budget exhausted ({max_turns} rounds) — final synthesis round"
                ));
            }
            // Cost budget guard — turn 0 시작 직전에만 체크 (옛 TS ai-manager.ts:1242-1248 1:1).
            // 한도 초과 시 LLM 호출 자체 차단 → 토큰 0 + 비용 0 으로 안전 종료.
            // CostManager 설정되어 있을 때만 작동 — 미설정 시 한도 무제한 (회귀 안전).
            if turn == 0 {
                if let Some(cost) = &self.cost {
                    let check = cost.check_budget();
                    if !check.within_budget {
                        let reason = check
                            .reason
                            .clone()
                            .unwrap_or_else(|| {
                        crate::i18n::t("core.error.ai.cost_limit_exceeded_short", None, &[])
                    });
                        self.log.warn(&format!(
                            "[AiManager] budget exceeded — LLM call blocked: {}",
                            reason
                        ));
                        return Ok(self.finalize(ai_opts, AiResponse {
                            reply: String::new(),
                            blocks: Vec::new(),
                            executed_actions: Vec::new(),
                            suggestions: Vec::new(),
                            pending_actions: Vec::new(),
                            error: Some(crate::i18n::t(
                        "core.error.ai.cost_limit_exceeded",
                        None,
                        &[("reason", &reason)],
                    )),
                            exhausted: false,
                            forced_final: false,
                            model_id: Some(last_model_id.clone()),
                            cost_usd: Some(0.0),
                            tool_results: Vec::new(),
                            library_hits: Vec::new(),
                            build_session: None,
                            reasoning_trace: Vec::new(),
                            final_reasoning: None,
                        }));
                    }
                }
            }

            // Dynamic temperature — toolExchanges 비어있으면 (첫 turn 또는 도구 호출 없음) 0.2,
            // 쌓여있으면 (요약·해설 turn) 0.85. 옛 TS 1:1.
            let dynamic_temp = if prior_results.is_empty() {
                TEMP_TOOL_TURN
            } else {
                TEMP_FINAL_TURN
            };
            let mut turn_opts = effective_opts.clone();
            turn_opts.temperature = Some(dynamic_temp);
            // previousResponseId per turn — 첫 turn 부터 갱신되며 매 turn 동일하게 다음 turn 으로 전달.
            // 옛 TS ai-manager.ts:1213 1:1.
            turn_opts.previous_response_id = current_response_id.clone();

            // 첫 turn 만 prompt hint prefix. 이후 turn 은 prompt 그대로 (옛 TS 와 동일).
            let llm_prompt: &str = if prior_results.is_empty() {
                &prompt_with_hint
            } else {
                prompt
            };

            // F2 — thrash containment. stage 1 (capped_strip): remove only the capped discovery
            // tools so the model must ACT with the action tools it still has; stage 2
            // (force_final): no tools at all — write the final answer (structural, not a prompt).
            let narrowed_tools: Option<Vec<ToolDefinition>> =
                if !force_final && !capped_strip.is_empty() {
                    Some(
                        effective_tools
                            .iter()
                            .filter(|t| !capped_strip.contains(&t.name))
                            .cloned()
                            .collect(),
                    )
                } else {
                    None
                };
            let round_tools: &[ToolDefinition] = if force_final {
                &[]
            } else {
                narrowed_tools.as_deref().unwrap_or(effective_tools)
            };
            // force_final round — the model must WRITE now, not deliberate. Two structural
            // nudges (2026-07-11 실측: force_final 라운드가 reasoning 6K자만 쓰고 content 0
            // → empty_final 3연속):
            //  (a) reasoning effort → low for THIS round only — final synthesis needs no deep
            //      CoT, and the output budget must go to the content channel, not reasoning.
            //  (b) one closing instruction appended to the prompt — the model otherwise doesn't
            //      know why its tools vanished and hallucinates tool-call tokens instead of
            //      answering (r11 re-call after strip, 실측).
            let force_final_prompt: String;
            let nudge_prompt: String;
            let llm_prompt: &str = if !force_final && std::mem::take(&mut nudge_this_round) {
                // No-silent-exit corrective round (19차): the model tried to end the turn with
                // a text-only "plan" after pure discovery. One firm instruction + the ledger.
                nudge_prompt = format!(
                    "{llm_prompt}\n\n[system] You gathered information but EXECUTED nothing — \
                     this turn cannot end as if the work happened. A plan written as text has \
                     NO Run button: the ONLY way to create an approvable plan is calling the \
                     propose_plan TOOL. Do ONE of these right now: (1) call the READY/STREAM \
                     entries below exactly as written, (2) call propose_plan with your plan as \
                     tool arguments (verified steps compiled with tool+args, unverified parts \
                     as discovery steps), or (3) if you truly cannot proceed, state plainly \
                     that nothing was executed.{}",
                    ledger_note(&turn_ledger)
                );
                &nudge_prompt
            } else if force_final {
                turn_opts.thinking_level = Some("low".to_string());
                // The ledger pins the final text to what actually happened — without it the
                // model binds values to wrong labels and reports unexecuted steps as done
                // (10차: 373220 을 "LG전자"로, 어제를 한 달 전 날짜로).
                let verified = if turn_ledger.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\nVerified this turn (ONLY these happened — anything else was NOT executed):\n{}",
                        turn_ledger.join("\n")
                    )
                };
                // "There is no other executor" — 16차 실측: force_final 답변이 "위 파라미터를
                // 그대로 호출해 주세요"라며 실행을 제3자에게 요청(자신을 플래너로 착각).
                force_final_prompt = format!(
                    "{llm_prompt}\n\n[system] Tool calls are closed for this turn. Using the \
                     tool results you already have, write your final answer to the user NOW as \
                     normal text (render fences allowed). You are the ONLY executor — never ask \
                     the user or \"the system\" to run a tool or API call for you; anything you \
                     did not run simply did not happen. If something could not be completed, \
                     say so honestly in one line. Do not emit tool-call syntax.{verified}"
                );
                &force_final_prompt
            } else {
                llm_prompt
            };
            // Plan compiled replay — synthetic round-0: the approved plan's verified calls run
            // through the dispatch below WITHOUT an LLM round. The next iteration's LLM call
            // then synthesizes with all results in prior_results (and handles any failures —
            // natural agent fallback). 재발견 0: 실행 턴이 식별자를 다시 사냥하다 소진되던
            // 클래스(2026-07-11 실측 2회)의 구조 해법.
            let response = if !plan_replay_calls.is_empty() {
                let calls = std::mem::take(&mut plan_replay_calls);
                self.log.info(&format!(
                    "[AiManager] plan replay round — executing {} compiled steps without an LLM round",
                    calls.len()
                ));
                LlmToolResponse {
                    tool_calls: calls,
                    model_id: last_model_id.clone(),
                    response_id: current_response_id.clone(),
                    thinking_text: Some(
                        "[plan replay] compiled plan steps executed mechanically (no LLM round)"
                            .to_string(),
                    ),
                    ..Default::default()
                }
            } else {
                match self
                    .llm
                    .ask_with_tools_streaming(
                        llm_prompt,
                        round_tools,
                        &prior_results,
                        &turn_opts,
                        llm_sink.clone(),
                    )
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        // Terminal LLM failure (400 / missing API key / etc.) — no answer will come.
                        // Persist an error record so the turn isn't an orphan user bubble on reload,
                        // WITH the rounds collected so far (mid-loop 실패에서도 CoT 판독 가능).
                        // (Recoverable SSE drops don't reach here; they complete + persist the real reply.)
                        self.finalize_error(ai_opts, &e, &reasoning_trace);
                        return Err(e);
                    }
                }
            };
            last_text = response.text.clone();
            last_model_id = response.model_id.clone();
            // Fabrication containment — deterministic server-side banner on a forced final,
            // instead of trusting the model's self-report (2026-07-12: fabricated chart stats,
            // accounts, a telegram "subscription"). Two grades:
            //  - nothing grounded at all this turn → strong banner (5차 클래스)
            //  - only pre-narrowing lookups succeeded, nothing after the loop was contained →
            //    partial banner (11차 클래스: lookup 하나 성공 = grounded 인데 종가·수급·"전송
            //    완료"를 통째 날조 — 성공 1건이 배너를 꺼버리던 granularity 구멍).
            // History-grounded answers stay readable below the banner.
            if force_final && !post_narrow_success && !last_text.trim().is_empty() {
                let key = if turn_grounded_success {
                    "core.error.ai.partial_grounded_final"
                } else {
                    "core.error.ai.ungrounded_final"
                };
                last_text = format!(
                    "{}\n\n{}",
                    crate::i18n::t(key, None, &[]),
                    last_text
                );
            }

            // streaming chunk emit — 매 turn LLM 의 reasoning text 영역 사용자한테 즉시 보임.
            // thinking 먼저 (있을 때만) → text 다음. frontend ThinkingBlock 가 thinking content
            // bodyText 영역 표시 + text 는 답변 본문 영역 표시 (옛 TS Core 1:1 흐름).
            // CLI 어댑터(claude/codex/gemini)는 turn 중 thinking 을 이미 live emit 했다 → 재emit 시
            // 이중표시. thinking_text 는 persist(reasoningTrace/finalReasoning)용으로 유지하되, 여기
            // display 재emit 은 CLI 가 아닐 때만(FC: openai/gemini/vertex 는 여기서 처음 흘림).
            if response.cli_session_id.is_none() {
                if let Some(thinking) = response.thinking_text.as_deref() {
                    if !thinking.trim().is_empty() {
                        emit_event(AiStreamEvent::Chunk {
                            event_type: "thinking".to_string(),
                            content: thinking.to_string(),
                        });
                    }
                }
            }
            if !last_text.trim().is_empty() {
                emit_event(AiStreamEvent::Chunk {
                    event_type: "text".to_string(),
                    content: last_text.clone(),
                });
            }
            if let Some(c) = response.cost_usd {
                total_cost += c;
            }

            // CLI session_id 영속화 — 어댑터가 첫 turn 에서 잡은 session_id 를 DB 에 저장.
            // 옛 TS onCliSessionId 콜백 1:1. ConversationManager 설정되어 있고 model 이 cli- 면 작동.
            if let (Some(conv_mgr), Some(conv_id), Some(sid)) = (
                &self.conversation,
                &conv_id_for_session,
                &response.cli_session_id,
            ) {
                if model_for_session.starts_with("cli-") && !sid.is_empty() {
                    conv_mgr.set_cli_session(conv_id, sid, &model_for_session);
                    self.log.info(&format!(
                        "[AiManager] CLI session_id persisted: conv={} model={} session_id={}",
                        conv_id, model_for_session, sid
                    ));
                }
            }

            // OpenAI Responses API previous_response_id — 다음 turn 에 server-side history 재사용.
            // 옛 TS ai-manager.ts:1258 1:1 (`if (responseId) currentResponseId = responseId;`).
            if let Some(rid) = &response.response_id {
                if !rid.is_empty() {
                    current_response_id = Some(rid.clone());
                }
            }

            // AI 미개입 cross-call hook — LLM 응답 받을 때마다 자동 비용 누적
            // (옛 TS ai-manager.ts:1260 core.recordLlmCost(usage) 패턴 1:1 port).
            if let Some(cost) = &self.cost {
                let _ = cost.record(
                    &response.model_id,
                    response.tokens_in.unwrap_or(0),
                    response.tokens_out.unwrap_or(0),
                    response.cached_tokens.unwrap_or(0),
                    response.cost_usd.unwrap_or(0.0),
                    Some("user-ai"),
                );
            }

            // CLI 자체 MCP loop 결과 흡수 — 어댑터 (cli_claude_code / cli_codex / cli_gemini) 가
            // 자체 MCP 호출 → render_* / pending / suggestions / used_tools 추출해서 LlmToolResponse 에 포함.
            // AiManager 는 그대로 outcome 에 extend (옛 TS `internallyUsedTools / renderedBlocks /
            // pendingActions / suggestions` 흡수 1:1).
            if !response.rendered_blocks.is_empty() {
                blocks.extend(response.rendered_blocks.iter().cloned());
            }
            if !response.pending_actions.is_empty() {
                pending_actions.extend(response.pending_actions.iter().cloned());
            }
            if !response.suggestions.is_empty() {
                cli_suggestions.extend(response.suggestions.iter().cloned());
            }
            if !response.internally_used_tools.is_empty() {
                // CLI 가 자체 처리한 도구 → executed_actions 에 도구 이름 (string) 추가.
                // ⚠️ Frontend ActionTags 가 string[] 기대 — object 들어가면 React #31 (object as child).
                // 옛 TS 와 동일하게 단순 string 만. "internally" 메타 구분 필요해지면 별도 channel.
                for tool_name in &response.internally_used_tools {
                    executed_actions.push(serde_json::Value::String(tool_name.clone()));
                }
            }
            // 도구 결과 요약 (성공/실패 모두) — Frontend 에러 뱃지 UI 채널.
            if !response.tool_results.is_empty() {
                tool_results_summary.extend(response.tool_results.iter().cloned());
            }
            // propose_plan turn 감지 — 호출됐으면 trailing text drop + break (옛 TS 1:1).
            // PlanCard + suggestions 가 이미 완전 → "위 카드에서..." 사족 drop.
            let is_propose_plan_turn = response
                .tool_calls
                .iter()
                .any(|tc| tc.name == "propose_plan");

            if response.tool_calls.is_empty() {
                // 리버스엔지니어링 관측 — 이 최종 라운드의 CoT 를 남긴다(도구 0 턴은
                // reasoning_trace 가 비므로 여기서만 잡힘). 실시간 thinkingText 가 "답변 완료"
                // 라벨로 덮이기 전의 진짜 추론.
                if let Some(t) = response.thinking_text.as_deref() {
                    let t = t.trim();
                    if !t.is_empty() {
                        final_reasoning = Some(t.to_string());
                    }
                }
                // No-silent-exit: discovery happened, nothing executed, model wants to stop.
                // Give it ONE corrective round (see nudge_prompt above). Second attempt with
                // the same shape is accepted — but banner-stamped below.
                if !force_final
                    && !no_action_nudge_used
                    && !turn_grounded_success
                    && !turn_ledger.is_empty()
                {
                    no_action_nudge_used = true;
                    nudge_this_round = true;
                    self.log.warn(
                        "[AiManager] natural finish after discovery with ZERO executed actions — one corrective round (no silent exit)",
                    );
                    continue;
                }
                // Accepted no-action finish after the corrective round — the reader must know
                // nothing ran (natural finish used to skip the fabrication banner entirely;
                // 19차: 산문 플랜 + 날조 종가가 배너 없이 나감).
                if !force_final
                    && no_action_nudge_used
                    && !turn_grounded_success
                    && !last_text.trim().is_empty()
                {
                    last_text = format!(
                        "{}\n\n{}",
                        crate::i18n::t("core.error.ai.ungrounded_final", None, &[]),
                        last_text
                    );
                }
                if is_propose_plan_turn {
                    self.log.info("[AiManager] propose_plan turn → trailing text drop");
                    last_text = String::new();
                } else if !last_text.is_empty() {
                    // text 블록 dedup — 같은 sig 의 text 가 이미 blocks 에 있으면 스킵.
                    push_text_block_dedup(&mut blocks, &last_text);
                }
                self.log.info(&format!(
                    "[AiManager] turn {} finished — no tool calls",
                    turn + 1
                ));
                tool_budget_exhausted = false;
                break;
            }

            // Layer 2 reset — 매 turn 새 set
            turn_call_set = HashSet::new();
            let mut turn_results: Vec<(ToolCall, ToolResult)> = Vec::new();
            // propose_plan 이 실제로 플랜을 만들었나 — 호출됐어도 핸들러가 거부(빈 인자 등,
            // envelope {"success": false})했으면 false. 턴 강제 종료·suggest 억제는 이 값 기준
            // (15차 실측: 거부된 플랜이 턴을 종료시켜 빈 응답 fallback).
            let mut propose_plan_ok = false;

            for call in response.tool_calls.iter() {
                // Approval gate (옛 TS ai-manager.ts 1342-1385 1:1) —
                // 1. cron agent 모드면 우회 (server-side 실행)
                // 2. ToolDispatcher 설정되어 있을 때만 작동
                // 3. check_needs_approval 결과 Some(summary) 면 pre_validate 후 pending 등록
                // 4. pre_validate 실패 시 UI 미노출 + AI 한테 에러 결과만 → 다음 turn 재시도
                if approval_enabled {
                    if let Some(dispatcher) = &self.dispatcher {
                        if let Some(approval) = dispatcher.check_needs_approval(call).await {
                            // Sub-agent = unattended; a pending card from inside a sub-agent is
                            // discarded with the sub-response → would silently never render.
                            // Auto-REJECT (opposite of cron's bypass-to-run — deliberate).
                            if ai_opts.sub_agent {
                                let msg = format!(
                                    "'{}' requires user approval and cannot run inside a sub-agent. Report your findings; the parent turn must perform this action itself.",
                                    call.name
                                );
                                let action = ToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result: serde_json::json!({
                                        "success": false,
                                        "error": msg,
                                    }),
                                    success: false,
                                    error: Some(msg),
                                    arguments: call.arguments.clone(),
                                };
                                turn_results.push((call.clone(), action));
                                continue;
                            }
                            // 사전 검증 — 실패면 UI 미노출 + tool 결과만 에러
                            if let Some(pre_err) = dispatcher.pre_validate_pending_args(call) {
                                self.log.warn(&format!(
                                    "[AiManager] tool pre-validation failed (hidden from UI, retry hint sent): {} — {}",
                                    call.name, pre_err
                                ));
                                let action = ToolResult {
                                    call_id: call.id.clone(),
                                    name: call.name.clone(),
                                    result: serde_json::json!({
                                        "success": false,
                                        "error": pre_err,
                                    }),
                                    success: false,
                                    error: Some(pre_err),
                                    arguments: call.arguments.clone(),
                                };
                                turn_results.push((call.clone(), action));
                                continue;
                            }
                            // pending 등록 — typed parse 가 schema 검증 역할.
                            // parse 실패 시 LLM 에게 에러 회신 + retry 유도 (pre_validate 와 동일 패턴).
                            let typed_args = match crate::utils::pending_tools::PendingActionArgs::from_call(
                                &call.name,
                                &call.arguments,
                            ) {
                                Ok(t) => t,
                                Err(parse_err) => {
                                    self.log.warn(&format!(
                                        "[AiManager] tool args schema mismatch (hidden from UI, retry hint sent): {} — {}",
                                        call.name, parse_err
                                    ));
                                    let action = ToolResult {
                                        call_id: call.id.clone(),
                                        name: call.name.clone(),
                                        result: serde_json::json!({
                                            "success": false,
                                            "error": parse_err,
                                        }),
                                        success: false,
                                        error: Some(parse_err),
                                        arguments: call.arguments.clone(),
                                    };
                                    turn_results.push((call.clone(), action));
                                    continue;
                                }
                            };
                            // typed args 를 그대로 serialize → frontend pending JSON 에 들어감 (name field 자동 포함).
                            let args_json = serde_json::to_value(&typed_args)
                                .unwrap_or(serde_json::Value::Null);
                            // hub visitor — capture scope so /api/hub/<slug>/plan can cross-tenant-guard
                            // + execute in the visitor's own owner scope (#10). admin = None (no scope check).
                            let hub_scope = ai_opts.hub_context.as_ref().map(|c| {
                                if c.session_id.is_empty() {
                                    c.instance_id.clone()
                                } else {
                                    format!("{}:{}", c.instance_id, c.session_id)
                                }
                            });
                            let plan_id = create_pending_scoped(typed_args, &approval.summary, hub_scope);
                            // schedule_task: runAt 이 이미 과거면 처음부터 past-runat 상태로 내려서
                            // 승인 버튼 대신 즉시보내기/시간변경 버튼이 뜨도록 유도 (옛 TS 1:1).
                            let mut pending = serde_json::json!({
                                "planId": plan_id,
                                "name": call.name,
                                "summary": approval.summary,
                                "args": args_json,
                            });
                            if call.name == "schedule_task" {
                                if let Some(run_at) = call
                                    .arguments
                                    .get("runAt")
                                    .and_then(|v| v.as_str())
                                {
                                    if is_past_iso(run_at) {
                                        if let serde_json::Value::Object(map) = &mut pending {
                                            map.insert(
                                                "status".to_string(),
                                                serde_json::Value::String(
                                                    "past-runat".to_string(),
                                                ),
                                            );
                                            map.insert(
                                                "originalRunAt".to_string(),
                                                serde_json::Value::String(run_at.to_string()),
                                            );
                                        }
                                    }
                                }
                            }
                            pending_actions.push(pending.clone());
                            approval_pending_created = true;
                            self.log.info(&format!(
                                "[AiManager] tool pending approval: {} (planId={}) — {}",
                                call.name, plan_id, approval.summary
                            ));
                            // executedActions 에는 도구 이름 (string) 만 — frontend ActionTags 가
                            // string[] 기대. object 들어가면 React #31. callId/pending/planId 등
                            // 메타는 frontend 가 어디서도 사용 안 함 (옛 TS 1:1).
                            executed_actions.push(serde_json::Value::String(call.name.clone()));
                            // tool 결과는 "승인 대기 중" 으로 LLM 에 알림 — 자동 실행 안 됐다는 신호
                            let action = ToolResult {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                result: serde_json::json!({
                                    "success": true,
                                    "pending": true,
                                    "planId": plan_id,
                                    "message": format!(
                                        "'{}' — 사용자 승인 대기 중입니다. 자동으로 실행되지 않았습니다.",
                                        approval.summary
                                    ),
                                }),
                                success: true,
                                error: None,
                                arguments: call.arguments.clone(),
                            };
                            turn_results.push((call.clone(), action));
                            continue;
                        }
                    }
                }

                // hub_context 가 있을 때 모든 도구 호출 시점에 owner / hub_owner / _hubScope /
                // project 일괄 자동 주입. 도구가 자기 받는 field 만 알아채고 무시.
                //
                // owner / hubOwner / _hubScope = `<instance_id>:<session_id>` 형태 —
                // visitor 별 격리 (같은 hub 안 다른 방문자 자료 노출 0). session_id 가 빈 string
                // 일 경우 옛 호환 (instance 단위만).
                //
                // project = `hub:<instance_id>` (save_page 만 — 페이지 URL 의 root /<slug>
                // 충돌 회피, instance 단위 그대로). visitor 별 page = chat 자료지 page 자료 X.
                //
                // visitor 가 admin / 다른 visitor 자료에 침투하는 silent leak 차단 — AI 가
                // 넣은 owner 를 override 강제.
                // 항상 clone 후 args 주입 — hub owner(visitor 격리) + build convId(Project Builder
                // cross-turn). 옛 hub-only 분기를 일반화 (start_build convId 도 같은 지점에서).
                let scoped_call: ToolCall = {
                    let mut sc = call.clone();
                    // Canonicalize a mangled sysmod name BEFORE any gate (approval/grounding/dispatch)
                    // so all see the registered name — a `_`/`-` or missing-prefix variant must not
                    // slip past the approval gate. No-op for already-correct or core tool names.
                    sc.name = self.tools.canonical_name(&sc.name);
                    let name = sc.name.clone();
                    if let serde_json::Value::Object(ref mut m) = sc.arguments {
                        // convId 주입 — Project Builder(cross-turn 세션 키) + tts(오디오 conv-scoped 저장·삭제 cascade). AI 미지정.
                        if name == "start_build" || name == "tts" {
                            if let Some(cid) =
                                ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty())
                            {
                                m.entry("convId".to_string())
                                    .or_insert_with(|| serde_json::Value::String(cid.to_string()));
                            }
                        }
                        // Pipeline dialect absorber — plan-step vocabulary ({tool, args} without
                        // `type`) in schedule_task/run_task pipelines (20차 실측: "type 누락"
                        // 거부가 마지막 라운드라 재시도 불가 → 소진). Normalized at the source
                        // so pre-validation, the pending card, and the stored job all agree.
                        if name == "schedule_task" || name == "run_task" {
                            crate::managers::task::normalize_pipeline_dialect(m);
                        }
                        // hub visitor — owner/hubOwner/_hubScope/project 강제 주입 (silent leak 차단,
                        // AI 가 넣은 owner override). visitor 별 격리 = `<instance_id>:<session_id>`.
                        if let Some(ctx) = ai_opts.hub_context.as_ref() {
                            let scope_id = if ctx.session_id.is_empty() {
                                ctx.instance_id.clone()
                            } else {
                                format!("{}:{}", ctx.instance_id, ctx.session_id)
                            };
                            m.insert("owner".to_string(), serde_json::Value::String(format!("hub:{}", scope_id)));
                            m.insert("hubOwner".to_string(), serde_json::Value::String(scope_id.clone()));
                            m.insert("_hubScope".to_string(), serde_json::Value::String(scope_id.clone()));
                            // Discovery tools scope their RESULTS to the widget's allowlist — inject
                            // the allowlist + tenant flag so the shared policy (hub_module_allowed →
                            // permits_tool) works on the FC path (MCP reads the same via task-local).
                            if matches!(name.as_str(), "search_module_actions" | "get_action_schema") {
                                m.insert(
                                    "_allowedSysmods".to_string(),
                                    serde_json::Value::Array(
                                        ctx.allowed_sysmods
                                            .iter()
                                            .map(|s| serde_json::Value::String(s.clone()))
                                            .collect(),
                                    ),
                                );
                                m.insert(
                                    "_fullTools".to_string(),
                                    serde_json::Value::Bool(ctx.full_tools),
                                );
                            }
                            // project scopes page tools to the hub instance. MCP injects it for ALL
                            // tools (inject_hub_owner); FC must list the page tools that read it so
                            // get_page/list_pages are scoped on the FC (Gemini/Vertex) path too.
                            if matches!(name.as_str(), "save_page" | "get_page" | "list_pages") {
                                // project 도 owner/_hubScope 와 동일하게 **세션 스코프**(`hub:<inst>:<sid>`) — 옛 `hub:<inst>`(인스턴스)는
                                // 같은 위젯의 다른 세션끼리 페이지 공유되던 버그. scope_id = <inst>:<sid> (위 1396-1400).
                                m.insert("project".to_string(), serde_json::Value::String(format!("hub:{}", scope_id)));
                            }
                        }
                    }
                    sc
                };
                let effective_call: &ToolCall = &scoped_call;
                // Layer 1 + 2 retry guard — 모든 도구 동일 적용 (특정 도구 하드코딩 X).
                // The key is salted with this turn's nonce: the idempotency cache exists to absorb
                // in-turn retry storms (image_gen retry-after-timeout incident), NOT to dedupe
                // across turns — two independent runs of the same job must each execute their
                // side effects (2026-07-11: a concurrent weather run's telegram send was served
                // from another run's cache → log said sent, only one message arrived).
                let cache_key = format!(
                    "{turn_cache_salt}:{}",
                    tool_cache_key(&effective_call.name, &effective_call.arguments)
                );
                // Whole-turn repeat detector (round-reset turn_call_set 과 별개) — 아래 Layer-1
                // 캐시 재서빙에 "이미 했던 그 호출" 신호를 붙이는 데 쓴다.
                let seen_before_this_turn = !turn_seen_keys.insert(cache_key.clone());
                // L1 grounding gate (FC path, #8-2) — a declared opaque param (e.g. a stock code) must
                // trace to observed provenance (prompt + this turn's tool results). Only sysmods with a
                // `grounding` config are checked. Rejection → the model gets the resolve hint and retries
                // (resolve → use). Mirror of the MCP gate; shares the pure check_grounding helper.
                let grounding_reject: Option<String> = if let Some(reg) = &self.dynamic_tools {
                    match reg.grounding_for(&effective_call.name).await {
                        Some(g) if !g.is_empty() => crate::utils::grounding::check_grounding(
                            &effective_call.arguments,
                            &g,
                            &observed,
                        )
                        .err(),
                        _ => None,
                    }
                } else {
                    None
                };
                // requiresApproval gate (#1-9b slice 1) — config-declared real-money/destructive
                // actions. Interactive turn = approval card (pending). cron = ALLOWED — 스케줄 등록
                // 승인 카드 통과 = 잡에 담긴 액션(실주문 포함) 승인으로 간주(사용자 확정 2026-07-07,
                // "오늘 TQQQ 1주 매수" → 새벽 미국장 예약 실행. cron_context 의 destructive 빌트인
                // passthrough 와 동일 철학). hub = denied (root's account).
                let approval_gate: Option<serde_json::Value> = if let Some(reg) = &self.dynamic_tools {
                    match reg.approval_for(&effective_call.name).await {
                        Some((module_name, decl)) => {
                            let act = effective_call
                                .arguments
                                .get("action")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if crate::utils::pending_tools::requires_approval_value(&decl, act) {
                                if crate::utils::cron_context::is_cron_context_active() {
                                    // 승인된 예약 실행 — 게이트 없이 정상 dispatch.
                                    None
                                } else if effective_call
                                    .arguments
                                    .get("_hubScope")
                                    .and_then(|v| v.as_str())
                                    .is_some()
                                {
                                    Some(serde_json::json!({
                                        "success": false,
                                        "error": "실주문 등 승인 필요 액션은 hub 에서 사용할 수 없습니다.",
                                        "approvalBlocked": "hub",
                                    }))
                                } else {
                                    // Pending 생성은 여기서 하지 않는다 — 이 시점은 dup/unknown 분기
                                    // *전*이라 여기서 만들면 그 분기로 빠질 때 store 에 고아 pending 이
                                    // 쌓인다. 마커만 반환, 실제 생성은 소비 분기에서.
                                    Some(serde_json::json!({
                                        "needsPending": true,
                                        "module": module_name,
                                        "action": act,
                                    }))
                                }
                            } else {
                                None
                            }
                        }
                        None => None,
                    }
                } else {
                    None
                };
                // Per-turn per-tool-name cap — counted per UNIQUE call. Identical whole-turn
                // repeats are NOT charged: they're re-served from the Layer-1 cache (with a
                // repeatNote) at zero upstream cost, and charging them starves the budget for
                // legitimate NEW discovery (16차 실측: ka10081 스키마 재확인 ×3·quotes ×2 가
                // 캡 8 을 태워 "전날 종가" 서브태스크의 신규 스키마 조회가 캡에 죽음 →
                // force final 산문). Varied-args thrash — the loop this cap exists for — is
                // still charged per variation (선언된 도구만, 기본 무제한).
                let per_turn_over_cap = {
                    let count = turn_tool_counts
                        .entry(effective_call.name.clone())
                        .or_insert(0);
                    if !seen_before_this_turn {
                        *count += 1;
                    }
                    // A stripped (discovery-closed) tool is firm-rejected even when the model
                    // hallucinates the call from history — narrowing only hides the tool from
                    // the LLM's list, it doesn't unregister it (06차 실측: strip 후 r8 이
                    // search_components 로 갈아타 검색 지속 = 두더지잡기).
                    capped_strip.contains(&effective_call.name)
                        || self
                            .tools
                            .per_turn_limit(&effective_call.name)
                            .map(|cap| *count > cap)
                            .unwrap_or(false)
                };
                // Failure cap — same tool already failed PER_TURN_FAIL_CAP times this turn.
                // Applies to every tool (no declaration needed) since sysmods have no attempt cap;
                // blocks the missing-field retry loop before it blows the context window.
                let fail_over_cap = turn_fail_counts
                    .get(&effective_call.name)
                    .copied()
                    .unwrap_or(0)
                    >= PER_TURN_FAIL_CAP;
                let mut action = if let Some(perr) = effective_call
                    .arguments
                    .get("__parseError")
                    .and_then(|v| v.as_str())
                {
                    // Truthful parse-failure teacher — repair_tool_args exhausted its rungs.
                    // Dispatching `{}` here made the tool answer "missing field X", which misled
                    // the model into resending the SAME broken JSON verbatim (21차 실측: identical
                    // 1,625-char plan ×2 + 2 more attempts → mission abandoned → availability
                    // fabrication). Tell it the real reason; this model class self-corrects from
                    // explicit validation errors. Bounded by PER_TURN_FAIL_CAP like any failure.
                    self.log.warn(&format!(
                        "[AiManager] tool args unparseable — teaching parse error: {}",
                        effective_call.name
                    ));
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": format!(
                                "The arguments of this call were NOT valid JSON — nothing was executed. Parse error: {perr}. Re-send this SAME call to '{}' with the SAME content but syntactically valid JSON: check bracket/brace balance and commas near the reported position. Do not drop fields and do not switch tools.",
                                effective_call.name
                            ),
                            "argsParseError": true,
                        }),
                        success: false,
                        error: Some("args parse error".to_string()),
                        arguments: call.arguments.clone(),
                    }
                } else if per_turn_over_cap || fail_over_cap {
                    self.log.warn(&format!(
                        "[AiManager] per-turn tool {} cap exceeded: {} ({} calls / {} fails)",
                        if fail_over_cap { "failure" } else { "call" },
                        effective_call.name,
                        turn_tool_counts.get(&effective_call.name).copied().unwrap_or(0),
                        turn_fail_counts.get(&effective_call.name).copied().unwrap_or(0),
                    ));
                    turn_call_set.insert(cache_key.clone());
                    let err_msg = if fail_over_cap {
                        format!(
                            "Tool '{}' has failed repeatedly this turn (likely a wrong/missing parameter or an action that doesn't fit this request). Stop retrying it — either use get_action_schema to fix the call, take a different approach, or conclude the data is unavailable and write the final answer. Do not fabricate the result.",
                            effective_call.name
                        )
                    } else {
                        // NOT "conclude it does not exist" — 07-11 실측: 캡 시점에 정답 스키마를
                        // 이미 쥐고 있었는데 그 문구가 포기 선언을 유도했다. 실행을 시켜라.
                        // The turn ledger makes "act on it" concrete — the abstract imperative
                        // alone was ignored (10차: r7 스키마 확보 후에도 r8~r12 대안 재검색).
                        // Plan escape hatch — 18차 실측: 플랜-컴파일 룰("스텝 전부 검증")을
                        // 순종하느라 발견 마라톤 → 캡 사망. 예산이 죽어가는 바로 이 지점에서
                        // "검증 못 한 건 discovery 스텝으로 두고 지금 플랜을 내라"를 가르친다.
                        format!(
                            "Tool '{}' exceeded its per-turn call limit. STOP searching — you already have results from earlier calls this turn. Pick the best candidate and ACT on it now (call the module action / stream_watch_start / render). If this is a MULTI-STEP task that won't fit in this turn's remaining budget, call propose_plan NOW — compile the verified entries below as steps with tool+args, write the still-unverified parts as discovery steps, and the ✓Run turn (fresh tool budget) finishes the rest. Only if nothing matched at all, answer honestly that the capability was not found. Never call this tool again this turn.{}",
                            effective_call.name,
                            ledger_note(&turn_ledger)
                        )
                    };
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": err_msg,
                            "perTurnLimitExceeded": true,
                        }),
                        success: false,
                        error: Some("per-turn tool cap".to_string()),
                        arguments: call.arguments.clone(),
                    }
                } else if turn_call_set.contains(&cache_key) {
                    // Layer 2: 이번 turn 에 이미 같은 호출 → 즉시 reject
                    self.log.warn(&format!(
                        "[AiManager] duplicate tool call blocked (per-turn): {}",
                        call.name
                    ));
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": format!(
                                "This tool was already called with the same arguments this turn. Use the previous result or call with different arguments. Never retry the identical call.{}",
                                ledger_note(&turn_ledger)
                            ),
                            "duplicateInTurn": true,
                        }),
                        success: false,
                        error: Some("per-turn duplicate".to_string()),
                        arguments: call.arguments.clone(),
                    }
                } else if !self.tools.has_handler(&effective_call.name) {
                    // 미등록(환각) 도구 — dispatch 해도 handler_not_registered 뿐. 즉시 firm 반환 + 이름 추적.
                    // 매 턴 재호출(x4/x7)로 MAX_TOOL_TURNS 낭비하던 것 차단. "영영 없으니 재시도 마라" 강조.
                    let repeat = !unknown_tool_names.insert(effective_call.name.clone());
                    self.log.warn(&format!(
                        "[AiManager] unknown tool blocked{}: {}",
                        if repeat { " (repeat)" } else { "" },
                        effective_call.name
                    ));
                    turn_call_set.insert(cache_key.clone());
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": format!("Tool '{}' does not exist. Never call it again — it will not exist no matter how many times you try. Real tools: scheduled runs = schedule_task / run now = run_task / plan = propose_plan / notes = sysmod_notes / calendar = sysmod_calendar. Use only tool names listed in the system context.", effective_call.name),
                            "unknownTool": true,
                        }),
                        success: false,
                        error: Some("unknown tool".to_string()),
                        arguments: call.arguments.clone(),
                    }
                } else if let Some(gate) = approval_gate {
                    // requiresApproval — pending card (or blocked); never dispatch directly.
                    turn_call_set.insert(cache_key.clone());
                    let needs_pending = gate
                        .get("needsPending")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let result = if needs_pending && ai_opts.sub_agent {
                        // Sub-agent = unattended; its pendingActions are discarded (only
                        // reply/actions return to the parent), so a pending card would silently
                        // never render. Auto-REJECT (opposite of cron's auto-approve — deliberate).
                        serde_json::json!({
                            "success": false,
                            "error": format!(
                                "'{}' requires user approval and cannot run inside a sub-agent. Report your findings; the parent turn must perform this action itself.",
                                effective_call.name
                            ),
                        })
                    } else if needs_pending {
                        // Pending 생성 + 프론트 승인 카드 배선 — 카드는 AiResponse.pendingActions
                        // 로만 뜬다. 옛엔 store 에만 만들고 push 를 빼먹어 카드가 영영 안 떴음
                        // (2026-07-06 실측: 주문 API 승인 카드 미표시). shape = dispatcher 경로와
                        // 동일 {planId,name,summary,args} — 프론트는 미지 name 이면 summary fallback.
                        let module_name = gate
                            .get("module")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let act = gate
                            .get("action")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let pargs = crate::utils::pending_tools::PendingActionArgs::RunModule(
                            crate::utils::pending_tools::RunModuleArgs {
                                module: module_name.clone(),
                                input: effective_call.arguments.clone(),
                            },
                        );
                        let summary = format!("실행 승인: {} · {}", module_name, act);
                        let plan_id = create_pending_scoped(pargs, &summary, None);
                        pending_actions.push(serde_json::json!({
                            "planId": plan_id,
                            "name": effective_call.name,
                            "summary": summary,
                            "args": effective_call.arguments.clone(),
                            // 주문 카드 신선도 기준 — 서버 영속본에도 실어야 리로드 후 경고가 산다
                            // (프론트 수신 stamp 는 라이브 세션 한정).
                            "createdAt": crate::utils::time::now_ms_u64(),
                        }));
                        executed_actions
                            .push(serde_json::Value::String(effective_call.name.clone()));
                        approval_pending_created = true;
                        self.log.info(&format!(
                            "[AiManager] requiresApproval pending: {} (planId={})",
                            effective_call.name, plan_id
                        ));
                        serde_json::json!({
                            "success": true,
                            "pending": true,
                            "planId": plan_id,
                            "summary": summary,
                            "note": "An approval card is shown to the user — nothing runs until approved. Do not retry this call.",
                        })
                    } else {
                        gate
                    };
                    let pending = result.get("pending").and_then(|v| v.as_bool()).unwrap_or(false);
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result,
                        success: pending,
                        error: if pending { None } else { Some("approval blocked".to_string()) },
                        arguments: call.arguments.clone(),
                    }
                } else if let Some(hint) = grounding_reject {
                    // L1 grounding reject — do NOT dispatch. Return the resolve hint so the model looks
                    // the identifier up first, then retries with a grounded value (resolve → use). Insert
                    // the cache key so the identical ungrounded args don't re-run — the model must change args.
                    self.log.info(&format!(
                        "[AiManager] grounding reject (FC): {} — ungrounded identifier dispatch blocked",
                        effective_call.name
                    ));
                    turn_call_set.insert(cache_key.clone());
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": hint,
                            "grounding": true,
                        }),
                        success: false,
                        error: Some("ungrounded".to_string()),
                        arguments: call.arguments.clone(),
                    }
                } else {
                    turn_call_set.insert(cache_key.clone());
                    if let Some(cached) = get_cached_tool_result(&cache_key) {
                        // Layer 1: cross-turn cache hit (60초 내) → 직전 결과 재사용
                        self.log.info(&format!(
                            "[AiManager] tool cache HIT: {} — reusing previous result",
                            call.name
                        ));
                        let mut cached_with_flag = cached.clone();
                        if let serde_json::Value::Object(map) = &mut cached_with_flag {
                            map.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                            // Identical repeat across rounds — the silent re-serve was fueling
                            // search loops (07-11 실측). Say it out loud: the result cannot change.
                            if seen_before_this_turn {
                                map.insert(
                                    "repeatNote".to_string(),
                                    serde_json::Value::String(
                                        "IDENTICAL repeat of a call you already made this turn — the result cannot change. Act on it now or change the arguments meaningfully; do not repeat it again.".to_string(),
                                    ),
                                );
                            }
                        }
                        ToolResult {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            success: true,
                            error: None,
                            result: cached_with_flag,
                            arguments: call.arguments.clone(),
                        }
                    } else {
                        // streaming step emit — 도구 호출 시작.
                        emit_event(AiStreamEvent::Step {
                            name: effective_call.name.clone(),
                            status: "start".to_string(),
                            description: Some(tool_label(&effective_call.name)),
                            error_message: None,
                        });
                        let mut result = self.dispatch_tool(effective_call).await;
                        // Whole-turn repeat of a DISCOVERY tool (declared per-turn cap = static
                        // result) that outlived the 60s Layer-1 cache — same "already did this"
                        // signal as the cache-hit path (16차 실측: 9분 턴에서 스키마 재확인이
                        // 전부 TTL 밖이라 repeatNote 없이 조용히 재서빙 → 재확인 루프 지속).
                        // Uncapped sysmods are excluded — their re-fetch is a legitimate refresh.
                        if result.success
                            && seen_before_this_turn
                            && self.tools.per_turn_limit(&effective_call.name).is_some()
                        {
                            if let serde_json::Value::Object(map) = &mut result.result {
                                map.insert(
                                    "repeatNote".to_string(),
                                    serde_json::Value::String(
                                        "IDENTICAL repeat of a call you already made this turn — the result cannot change. Act on it now or change the arguments meaningfully; do not repeat it again.".to_string(),
                                    ),
                                );
                            }
                        }
                        if result.success {
                            set_cached_tool_result(&cache_key, &result.result);
                        } else {
                            // Failure cap counter — only real dispatched failures (not approval
                            // pending / grounding reject / cache paths, which don't reach here).
                            *turn_fail_counts.entry(effective_call.name.clone()).or_insert(0) += 1;
                        }
                        // streaming step emit — 도구 호출 완료 / 에러.
                        emit_event(AiStreamEvent::Step {
                            name: effective_call.name.clone(),
                            status: if result.success { "done".to_string() } else { "error".to_string() },
                            description: Some(tool_label(&effective_call.name)),
                            error_message: result.error.clone(),
                        });
                        // Project Builder — stream the advanced build step mid-turn. buildSession only
                        // rides the FINAL AiResponse, so without this the frontend stepper/loader freeze
                        // at the prior step for the whole long one-shot turn (the AI advances to Implement
                        // early then generates for minutes). Reuses the chunk channel (event_type
                        // "build_step", content = serialized session) = no proto/gRPC changes.
                        if matches!(effective_call.name.as_str(), "start_build" | "advance_build") {
                            if let Some(sid) = result
                                .result
                                .get("data")
                                .and_then(|d| d.get("sessionId"))
                                .and_then(|v| v.as_str())
                            {
                                if let Some(sess) = crate::utils::build_session::get_session(sid) {
                                    if let Ok(json) = serde_json::to_string(&sess) {
                                        emit_event(AiStreamEvent::Chunk {
                                            event_type: "build_step".to_string(),
                                            content: json,
                                        });
                                    }
                                }
                            }
                        }
                        result
                    }
                };

                // ActionTags 는 string[] 만 받음 — 옛 TS 와 동일하게 도구 이름만.
                executed_actions.push(serde_json::Value::String(call.name.clone()));
                // Module-level failure envelope — a handler that returns Ok({"success": false})
                // (guard rejections, sysmod error envelopes) has dispatch success:true (transport
                // worked) but did NO real work. Anything that means "did real work" must also
                // check the envelope (15차 실측: rejected propose_plan counted as grounded
                // success and force-ended the turn empty).
                let envelope_ok = action.success
                    && action.result.get("success").and_then(|b| b.as_bool()) != Some(false);
                if effective_call.name == "propose_plan" && envelope_ok {
                    propose_plan_ok = true;
                }
                // Stage-1 progress — a successful ACTION tool (no declared per-turn cap = not the
                // discovery class) after narrowing means the turn escaped its loop and did real work.
                if envelope_ok && self.tools.per_turn_limit(&effective_call.name).is_none() {
                    turn_grounded_success = true;
                    if !capped_strip.is_empty() {
                        post_narrow_success = true;
                    }
                    // Stall re-open — a real action ends the stall (its evidence was "orbiting
                    // without acting"). Restore the stall-closed discovery tools that still have
                    // individual budget so the legitimate NEXT ladder step (e.g. resolve a code →
                    // get_action_schema → call the action) can proceed; tools already at their
                    // per-tool cap stay out (the counter rejects them anyway, and re-listing a
                    // tool that always rejects would only confuse the model).
                    if !stall_stripped.is_empty() {
                        let mut reopened: Vec<String> = Vec::new();
                        for n in stall_stripped.drain() {
                            let over = self
                                .tools
                                .per_turn_limit(&n)
                                .map(|cap| {
                                    turn_tool_counts.get(&n).copied().unwrap_or(0) >= cap
                                })
                                .unwrap_or(false);
                            if !over && capped_strip.remove(&n) {
                                reopened.push(n);
                            }
                        }
                        if !reopened.is_empty() {
                            self.log.info(&format!(
                                "[AiManager] grounded action succeeded — reopening stall-closed \
                                 discovery tools with remaining budget: {:?}",
                                reopened
                            ));
                        }
                    }
                }
                // Turn-ledger harvest — turn this round's successes into ready-to-call lines.
                // Envelope-checked: a rejection envelope must not mint READY/DONE receipts.
                if envelope_ok {
                    match effective_call.name.as_str() {
                        "get_action_schema" => {
                            let r = &action.result;
                            if let (Some(module), Some(act)) = (
                                r.get("module").and_then(|v| v.as_str()),
                                r.get("action").and_then(|v| v.as_str()),
                            ) {
                                let params = r
                                    .get("params")
                                    .and_then(|p| p.as_object())
                                    .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                                    .unwrap_or_default();
                                let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                ledger_push(&mut turn_ledger, format!(
                                    "- READY sysmod_{module} {{\"action\":\"{act}\",\"params\":{{{params}}}}} — {name}"
                                ));
                                // resolveFirst rides the ledger too — a READY entry whose param
                                // needs a lookup is NOT callable yet, and without this line the
                                // model (correctly!) refuses to guess the code and slides back to
                                // searching (13차 실측: READY ka10081 을 쥐고도 stk_cd 가 없어
                                // 검색으로 회귀 — 선행 조건이 원장에 안 실려 있었다).
                                if let Some(rf) = r.get("resolveFirst").and_then(|v| v.as_object())
                                {
                                    for (param, hint) in rf {
                                        let hint_head: String = hint
                                            .as_str()
                                            .unwrap_or("")
                                            .chars()
                                            .take(200)
                                            .collect();
                                        ledger_push(&mut turn_ledger, format!(
                                            "- FIRST {param} (for the READY call above): {hint_head}"
                                        ));
                                    }
                                }
                            }
                        }
                        "search_module_actions" => {
                            // Top usable rows only — the full rows already sit in the tool result;
                            // the ledger is a pointer, not a copy.
                            if let Some(rows) =
                                action.result.get("actions").and_then(|v| v.as_array())
                            {
                                let mut got_action = false;
                                let mut got_stream = false;
                                for row in rows {
                                    let module = row
                                        .get("module")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let name =
                                        row.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    if !got_stream
                                        && row.get("kind").and_then(|v| v.as_str())
                                            == Some("stream")
                                    {
                                        if let Some(stream) =
                                            row.get("stream").and_then(|v| v.as_str())
                                        {
                                            ledger_push(&mut turn_ledger, format!(
                                                "- STREAM stream_watch_start {{\"module\":\"{module}\",\"stream\":\"{stream}\"}} — {name} (args: get_action_schema(\"{module}\",\"{stream}\") first)"
                                            ));
                                            got_stream = true;
                                        }
                                    } else if !got_action {
                                        if let Some(act) =
                                            row.get("action").and_then(|v| v.as_str())
                                        {
                                            ledger_push(&mut turn_ledger, format!(
                                                "- CANDIDATE {module}:{act} — {name} (get_action_schema then call sysmod_{module})"
                                            ));
                                            got_action = true;
                                        }
                                    }
                                    if got_action && got_stream {
                                        break;
                                    }
                                }
                            }
                        }
                        n if self.tools.per_turn_limit(n).is_none() => {
                            // Completed real action — carry a compact receipt (e.g. a lookup's
                            // corp_name + code) so the final answer can bind values to the right
                            // labels (10차: 코드는 맞고 회사명을 "LG전자"로 흘린 값-라벨 결합 실패).
                            if let Ok(compact) = serde_json::to_string(&action.result) {
                                let trimmed: String = compact.chars().take(160).collect();
                                ledger_push(
                                    &mut turn_ledger,
                                    format!("- DONE {n} → {trimmed}"),
                                );
                            }
                        }
                        _ => {}
                    }
                }
                // grounding corpus (#8-2) — record successful tool-result text as provenance so a later
                // call this turn can reference resolved identifiers (e.g. dart lookup → stock code).
                // F6 — but NOT discovery/schema tools: their output embeds documentation examples
                // (get_action_schema param docs carry `KRX:005930` etc.), which would let a
                // fabricated code "ground" against a doc example that merely matched.
                if action.success && crate::utils::grounding::records_provenance(&call.name) {
                    if let Ok(text) = serde_json::to_string(&action.result) {
                        observed.push(text);
                    }
                }
                // Ledger footer on every DISCOVERY-class success — the continuation vehicle.
                // Weak-model CoT restarts from scratch each round (17차 실측: r4 가 READY
                // ka10081 을 확보하고도 r5~r7 이 검색 변주로 예산 소진 — 원장이 캡 거부
                // 에러에만 실려 모델이 "실패해야" 자기가 뭘 쥐었는지 봤다). Attach it to the
                // result itself so each search/schema round ends with "here is what you already
                // hold — act", without touching the prefix-cached system prompt (P5).
                if action.success
                    && self.tools.per_turn_limit(&effective_call.name).is_some()
                    && !turn_ledger.is_empty()
                {
                    if let serde_json::Value::Object(map) = &mut action.result {
                        map.insert(
                            "alreadyInHand".to_string(),
                            serde_json::Value::String(ledger_note(&turn_ledger)),
                        );
                    }
                }
                turn_results.push((call.clone(), action));
            }

            // F2 — did this round produce anything at all? A round made entirely of rejected calls
            // is pure budget burn. Two-stage containment (see `force_final`/`capped_strip` above):
            //   stage 1 — strip only the capped tools from later rounds; the action tools stay so
            //   the model can still complete the mission with what it discovered (07-11 실측).
            //   stage 2 — a fully-rejected round AFTER narrowing = still thrashing → no tools at
            //   all, forced final answer.
            // The stage-1 trigger requires at least one CAP rejection — a cap is declared thrash
            // evidence (search ×18 실측), whereas a duplicate-only round is often a legitimate
            // re-check ("use the previous result" 에러로 모델이 보통 회복) — 그것만으로 좁히면
            // 정당한 작업이 조기 종료된다(리뷰 #4).
            if !turn_results.is_empty() {
                let rejected = |r: &ToolResult, key: &str| {
                    r.result.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
                };
                let all_rejected = turn_results.iter().all(|(_, r)| {
                    rejected(r, "perTurnLimitExceeded") || rejected(r, "duplicateInTurn")
                });
                let any_cap = turn_results
                    .iter()
                    .any(|(_, r)| rejected(r, "perTurnLimitExceeded"));
                if !all_rejected {
                    post_narrow_rejected_rounds = 0;
                }
                if all_rejected && !force_final {
                    if !capped_strip.is_empty() {
                        // stage 2 — but only on the SECOND consecutive fully-rejected round:
                        // the first one delivered the "discovery closed / ACT now" errors, and
                        // the model still holds the action tools for a real attempt next round.
                        post_narrow_rejected_rounds += 1;
                        if post_narrow_rejected_rounds >= 2 {
                            force_final = true;
                            self.log.warn(
                                "[AiManager] second fully-rejected round after narrowing — \
                                 disabling all tools for the next round to force a final answer",
                            );
                        } else {
                            self.log.warn(
                                "[AiManager] fully-rejected round after narrowing — grace round: \
                                 action tools stay up one more round before the forced final",
                            );
                        }
                    } else if any_cap {
                        // stage 1 — remove the capped tools, keep the action tools.
                        for (c, r) in &turn_results {
                            if rejected(r, "perTurnLimitExceeded") {
                                capped_strip.insert(c.name.clone());
                            }
                        }
                        self.log.warn(&format!(
                            "[AiManager] every tool call this round was rejected (incl. a cap hit) \
                             — stripping capped tools for later rounds, keeping action tools: {:?}",
                            capped_strip
                        ));
                    }
                }
                // Discovery-stall counter — a round made ONLY of discovery-class calls
                // (declared per-turn cap) advances the stall; a successful action-class call
                // resets it; mixed/unknown rounds leave it unchanged.
                let all_discovery = turn_results
                    .iter()
                    .all(|(c, _)| self.tools.per_turn_limit(&c.name).is_some());
                if all_discovery {
                    discovery_only_rounds += 1;
                } else if turn_results.iter().any(|(c, r)| {
                    r.success && self.tools.per_turn_limit(&c.name).is_none()
                }) {
                    discovery_only_rounds = 0;
                }
                if discovery_only_rounds == DISCOVERY_STALL_ROUNDS && !force_final {
                    // get_action_schema stays OPEN: it is the CONVERGENT bridge of the ladder
                    // (candidate → exact params → call), each call requires a concrete candidate,
                    // and its own per-tool cap already bounds it. Closing it made our surfaces
                    // contradict each other (11차 실측: 원장 CANDIDATE 지시 "get_action_schema
                    // then call" 를 모델이 정확히 순종했는데 폐쇄가 firm 거부 → force final 날조).
                    // The stall's evidence is DIVERGENT search-orbiting — search_* only.
                    let closed: Vec<String> = self
                        .tools
                        .per_turn_limited_names()
                        .into_iter()
                        .filter(|n| n != "get_action_schema")
                        .collect();
                    self.log.warn(&format!(
                        "[AiManager] {DISCOVERY_STALL_ROUNDS} consecutive discovery-only rounds \
                         — closing search-class discovery tools (act with gathered results; \
                         get_action_schema stays open): {:?}",
                        closed
                    ));
                    stall_stripped.extend(closed.iter().cloned());
                    capped_strip.extend(closed);
                }
            }

            // Render component blocks — 3 가지 흐름 통합 처리:
            //   (1) `render_iframe` — `{htmlContent, htmlHeight?, dependencies?}` → html block
            //   (2) 통합 `render` 또는 옛 `render_<comp>` + `result.component` 단일 component →
            //       `{type:component, name, props}` block. 옛 TS ai-manager.ts:1464-1478 1:1.
            //   (3) 통합 `render` + `result.blocks` 배열 (RenderUnifiedHandler `{success:true,
            //       blocks:[{type:component,name,props}, ...]}` 응답) → 배열 안 entry 그대로 push.
            //       MCP 단일 render 도구 도입 이후 흐름 — 옛 (2) 매칭만 있어 blocks 통째 누락
            //       사용자 화면 미표시 사고. (안건 5 fix, 2026-05-17)
            // 같은 turn 안 `suggest` 도구 결과 (`{suggestions:[...]}`) 도 cli_suggestions 누적 —
            // 옛 CLI 만 처리하던 영역 = API 모드 (Gemini/Anthropic/OpenAI Function Calling) 안
            // suggest 호출 결과 무시되던 사고 (안건 6 fix, 2026-05-17).
            let render_map = render_tool_map();
            for (tc, action) in turn_results.iter() {
                if !action.success {
                    continue;
                }
                let result = &action.result;
                if tc.name == "render_iframe"
                    && result.get("htmlContent").is_some()
                {
                    blocks.push(serde_json::json!({
                        "type": "html",
                        "htmlContent": result.get("htmlContent").cloned().unwrap_or(serde_json::Value::Null),
                        "htmlHeight": result.get("htmlHeight").cloned(),
                        "dependencies": result.get("dependencies").cloned(),
                    }));
                } else if (tc.name == "render" || render_map.contains_key(tc.name.as_str()))
                    && result
                        .get("blocks")
                        .and_then(|v| v.as_array())
                        .is_some()
                {
                    if let Some(arr) = result.get("blocks").and_then(|v| v.as_array()) {
                        for b in arr {
                            blocks.push(b.clone());
                        }
                    }
                } else if result.get("component").and_then(|v| v.as_str()).is_some() {
                    // `component` 필드 = "이 결과를 컴포넌트로 렌더하라" 계약 — 도구 이름 무관
                    // (CLI 어댑터 cli_claude_code.rs:594 와 동일 규약). 옛엔 render_map 게이트로
                    // 좁혀서 propose_plan 의 PlanCard 가 FC 경로에서 블록이 못 되고 통째 누락
                    // (2026-07-06 실측: 플랜 카드·칩 미표시, "계획을 수립했습니다" 텍스트만).
                    let component = result
                        .get("component")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let props = result
                        .get("props")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    blocks.push(serde_json::json!({
                        "type": "component",
                        "name": component,
                        "props": props,
                    }));
                }
                // suggestions 수집 — suggest + propose_plan(✓실행/수정/취소 칩), CLI 어댑터
                // (cli_claude_code.rs:639)와 동일. 위 component 분기와 배타 아님(propose_plan
                // 은 PlanCard 블록 + 칩 둘 다).
                // suggest 는 last-wins: 한 턴에 suggest 를 여러 번 호출하면 마지막 세트가
                // 이전 것을 대체한다 (누적하면 칩 세트가 겹쳐 렌더 — 2026-07-08 실측).
                // 단 propose_plan 과 같은 라운드면 suggest 는 무시 — clear() 가 호출 순서에 따라
                // 플랜의 ✓실행/수정/취소 칩을 지워 사용자가 플랜을 승인할 수 없게 된다(리뷰 발견).
                // 플랜 카드가 그 턴의 주인공이므로 부수 suggest 칩은 노이즈다.
                if tc.name == "suggest" {
                    if !propose_plan_ok {
                        if let Some(arr) = result.get("suggestions").and_then(|v| v.as_array()) {
                            cli_suggestions.clear();
                            cli_suggestions.extend(arr.iter().cloned());
                        }
                    }
                } else if tc.name == "propose_plan" {
                    if let Some(arr) = result.get("suggestions").and_then(|v| v.as_array()) {
                        cli_suggestions.extend(arr.iter().cloned());
                    }
                }
            }

            // 도구 결과 요약 — turn_results 안 매 entry 를 tool_results_summary 에 누적.
            // 옛 흐름은 CLI 자체 MCP loop 의 `response.tool_results` (L834-836) 만 push — 즉
            // API 모드 (Function Calling — Gemini/Anthropic/OpenAI) 안 도구 호출 fail (예: render
            // schema 검증 실패 — `blocks[1] (map) props 검증 실패: "lon" is a required property`) 가
            // ActionTags 에러 뱃지 UI 채널에 도달 못 했음. 본 push 적용 후 자동 활성.
            //
            // render 도구 graceful 부분 실패 (`result.failed` 배열 비어있지 않음) 도 ActionTags
            // 가시화 — action.success=true 라도 일부 block 검증 실패가 있는 영역 사용자
            // 안내 (빨간 뱃지 + 실패 안내 본문 펼침).
            for (tc, action) in turn_results.iter() {
                let (success, error) = if action.success {
                    let failed_arr = action
                        .result
                        .get("failed")
                        .and_then(|v| v.as_array())
                        .filter(|a| !a.is_empty());
                    if let Some(arr) = failed_arr {
                        let msg = arr
                            .iter()
                            .filter_map(|f| f.get("error").and_then(|v| v.as_str()))
                            .collect::<Vec<_>>()
                            .join("; ");
                        (false, Some(format!("부분 실패: {}", msg)))
                    } else {
                        (true, action.error.clone())
                    }
                } else {
                    (false, action.error.clone())
                };
                tool_results_summary.push(crate::ports::ToolResultSummary {
                    name: tc.name.clone(),
                    success,
                    error,
                    input: Some(tc.arguments.clone()),
                });
            }

            // 중간 turn text → blocks push (옛 TS Core 동작 복원, 2026-05-20).
            // 옛 commit e9c66c6 안 폐기 영역 = 답변 N번 반복 issue. 다만 폐기 후 사용자 보고 =
            // "답변 길이 짧음" — multi-turn AI 의 reasoning text 영역 답변 안 사라짐.
            // push_text_block_dedup 의 70% similarity 매칭 안 옛 turn text 영역 final turn 안 자동
            // 중복 차단. final turn 에 같은 내용이 있으면 skip — 옛 중복 issue 영역 자동 가드.
            if !last_text.trim().is_empty() {
                push_text_block_dedup(&mut blocks, &last_text);
            }

            // prior_results 누적 — 다음 turn 의 toolExchanges 로 LLM 에 전달.
            // 학습 로그용 + Gemini thought_signature echo 용 — turn 별 entry 보존.
            let turn_calls: Vec<ToolCall> = turn_results.iter().map(|(c, _)| c.clone()).collect();
            let turn_action_results: Vec<ToolResult> =
                turn_results.iter().map(|(_, r)| r.clone()).collect();
            // 리버스엔지니어링 관측 — 이 라운드의 reasoning + 호출 도구 + 실패 여부.
            // response.thinking_text = 이 라운드 직전 CoT(도구 인자를 왜 이렇게 골랐나).
            {
                let round_reasoning = response
                    .thinking_text
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("")
                    .to_string();
                let tool_names: Vec<String> =
                    turn_calls.iter().map(|c| c.name.clone()).collect();
                let any_failed = turn_action_results.iter().any(|r| !r.success);
                reasoning_trace.push(serde_json::json!({
                    "round": reasoning_trace.len() + 1,
                    "model": response.model_id.clone(),
                    "reasoning": round_reasoning,
                    "tools": tool_names,
                    "failed": any_failed,
                }));
            }
            tool_exchanges.push(crate::ports::ToolExchangeEntry {
                tool_calls: turn_calls,
                tool_results: turn_action_results,
                raw_model_parts: response.raw_model_parts.clone(),
            });
            // 다음 turn opts 에 누적 entries 통째 echo — Gemini 어댑터가 raw_model_parts 활용해 thought_signature 보존.
            effective_opts.tool_exchanges = tool_exchanges.clone();
            for (_call, action) in turn_results {
                prior_results.push(action);
            }

            // propose_plan 이 실제 플랜 카드를 만들었을 때만 강제 turn 종료 — 사용자가 ✓실행
            // 누른 뒤 다음 turn 진행. 핸들러가 거부(빈/깨진 인자)한 호출은 일반 실패 도구와
            // 동일하게 다음 라운드로 — 모델이 에러를 보고 올바른 인자로 재시도하거나 직접
            // 실행한다 (15차 실측: 거부에도 break 해서 카드도 텍스트도 없는 빈 턴이 됐음).
            if propose_plan_ok {
                self.log.info(
                    "[AiManager] propose_plan detected — dropping trailing text, ending turn for approval",
                );
                last_text = String::new();
                tool_budget_exhausted = false;
                break;
            }
            // 승인 대기 pending 생성 시에도 동일하게 강제 turn 종료 (propose_plan 미러) — 카드가
            // 곧 다음 액션이라 모델이 더 진행할 게 없다. 옛엔 루프가 계속 돌며 같은 주문을 재시도해
            // 승인 카드가 여러 장 쌓이거나(각각 고아 pending) run_task 파이프라인으로 게이트를 우회
            // 시도(2026-07-07 토스 매수 실측: 카드 3장 + run_task ×8). 모델이 그 턴에 쓴 텍스트는
            // 유지(카드 맥락 설명일 수 있음).
            if approval_pending_created {
                self.log.info(
                    "[AiManager] approval pending created — ending turn for card response",
                );
                tool_budget_exhausted = false;
                break;
            }
        }
        if tool_budget_exhausted {
            self.log.warn(&format!(
                "[AiManager] MAX_TOOL_TURNS({}) exhausted — loop ended without natural finish",
                max_turns
            ));
        }

        // ── Intent Agent S0 — shadow recall 기록 (행동 0) ──
        // shortlist 가 실제 디스패치를 커버했는지(recall) + 디스패치 없는 턴의 매칭 분포
        // (false-positive율 = L3 포인터 임계 입력). grep: journalctl | grep intent_shadow.
        if !shadow_actions.is_empty() || !shadow_skills.is_empty() {
            let mut dispatched_actions: Vec<(String, String)> = Vec::new(); // (tool suffix, action)
            let mut dispatched_skills: Vec<String> = Vec::new();
            for tr in &tool_results_summary {
                if let Some(rest) = tr.name.strip_prefix("sysmod_") {
                    if let Some(act) = tr
                        .input
                        .as_ref()
                        .and_then(|i| i.get("action"))
                        .and_then(|v| v.as_str())
                    {
                        dispatched_actions.push((rest.to_string(), act.to_string()));
                    }
                } else if tr.name == "get_skill" {
                    if let Some(slug) = tr
                        .input
                        .as_ref()
                        .and_then(|i| i.get("slug"))
                        .and_then(|v| v.as_str())
                    {
                        dispatched_skills.push(slug.to_string());
                    }
                }
            }
            // 방언 정규화 — 디스패치 도구 suffix 는 언더스코어·도메인 분리(kiwoom_chart, toss_invest_account)라
            // 카탈로그 모듈명(kiwoom, toss-invest)과 직접 비교 불가 → 모듈명 하이픈→언더스코어 후 prefix 매치.
            // recall 분모 = 카탈로그 등재 모듈 디스패치만 — 미등재 모듈(kma 등)은 shortlist 에
            // 구조적으로 나올 수 없어 분모 포함 시 recall 이 항상 낮게 왜곡된다(첫날 0/2·0/7 사례).
            let cataloged_norm: Vec<String> = if let Some(ac) = &self.intent_actions {
                ac.cataloged_modules()
                    .await
                    .iter()
                    .map(|m| m.replace('-', "_"))
                    .collect()
            } else {
                Vec::new()
            };
            let denom_actions: Vec<&(String, String)> = dispatched_actions
                .iter()
                .filter(|(tool_suffix, _)| {
                    cataloged_norm.iter().any(|m| tool_suffix.starts_with(m.as_str()))
                })
                .collect();
            let act_hits = denom_actions
                .iter()
                .filter(|(tool_suffix, act)| {
                    shadow_actions.iter().any(|(ma, _)| {
                        ma.split_once(':')
                            .map(|(m, a)| a == act && tool_suffix.starts_with(&m.replace('-', "_")))
                            .unwrap_or(false)
                    })
                })
                .count();
            let skill_hits = dispatched_skills
                .iter()
                .filter(|slug| shadow_skills.iter().any(|(s, _)| s == *slug))
                .count();
            let fmt_short = |v: &Vec<(String, f32)>| {
                v.iter()
                    .map(|(n, s)| format!("{n}:{s:.2}"))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            // model= 로 궤적 분리 — recall/분류기 라벨은 강한 모델(Claude) 궤적이 ground truth,
            // 약한 모델(Solar) 궤적은 오선택·루프가 섞여 라벨 오염(카나리아 행동 데이터로만).
            self.log.info(&format!(
                "[intent_shadow] model={} q=\"{}\" actions=[{}] skills=[{}] dispatched_actions={:?} dispatched_skills={:?} action_recall={}/{} skill_recall={}/{}",
                last_model_id,
                prompt.chars().take(80).collect::<String>().replace('\n', " "),
                fmt_short(&shadow_actions),
                fmt_short(&shadow_skills),
                dispatched_actions,
                dispatched_skills,
                act_hits,
                denom_actions.len(),
                skill_hits,
                dispatched_skills.len(),
            ));
        }

        // Phase B-17+ result processor — 모든 LLM 응답을 단일 정제 레이어 통과.
        // 옛 TS sanitize.ts 1:1 port. 모델별 quirk fix 모두 일반 로직으로 처리:
        // 1. sanitize_reply — Unicode escape / HTML 태그 / 마크다운 강조 마커 제거
        // 2. extract_markdown_structure — `## 헤더` / `|---|` 표 → render_header / render_table 자동 변환
        // 3. segments_to_blocks — text segment 만 reply 에 남기고 header/table 은 blocks 로 분리
        // firebat-render fence(텍스트 채널 render)를 마스킹·sanitize 후 reply 정제 → 복원.
        // fence 안 JSON 이 sanitize_reply / 마크다운 구조 추출에 안 망가지게 보호 + render_blocks 검증.
        // 모델이 도구 인자 대신 텍스트로 render 를 보내 한국어 깨짐 회피 + content 상주(메모리 회상).
        // dataCacheKey resolver — fence blocks reference a sysmod _cacheKey; the server injects
        // the full cached records as props.data (모델 손 복사 = truncation·날조 → 구조 차단).
        let fence_data_resolver: Option<
            Box<dyn Fn(&str) -> Result<Vec<serde_json::Value>, String>>,
        > = self.sysmod_cache.as_ref().map(|cache| {
            let cache = cache.clone();
            Box::new(move |key: &str| {
                cache.read(key, 0, usize::MAX).and_then(|v| {
                    v.get("records")
                        .and_then(|r| r.as_array())
                        .cloned()
                        .ok_or_else(|| "cache records missing".to_string())
                })
            }) as Box<dyn Fn(&str) -> Result<Vec<serde_json::Value>, String>>
        });
        let (masked_for_reply, render_fences, render_block_groups, render_failed_groups) =
            render_exec::mask_and_sanitize_fences(&last_text, fence_data_resolver.as_deref());
        let sanitized_reply = crate::utils::sanitize::sanitize_reply(&masked_for_reply);
        let segments = crate::utils::sanitize::extract_markdown_structure(&sanitized_reply);
        let (clean_reply_masked, extracted_blocks) =
            crate::utils::sanitize::segments_to_blocks(segments);
        let mut clean_reply = render_exec::restore_fences(&clean_reply_masked, &render_fences);
        // render 뱃지 — fence 로 그린 것도 옛 render 도구처럼 tool_results 에 노출(뱃지 + 내용 = 디버그 편의).
        // fence 는 도구 호출이 아니지만, 사용자에게 "render 했음 + 그 내용"을 보여주면 픽스할 때 편하다.
        for blocks in &render_block_groups {
            if blocks.is_null() {
                continue; // 파싱 실패 fence — frontend 가 raw 로 표시하므로 별도 뱃지 불요.
            }
            // 칩(뱃지)은 executed_actions 에서 — ActionTags(page.tsx)가 actions 를 칩으로 렌더.
            executed_actions.push(serde_json::Value::String("render".to_string()));
            // tool_results 는 그 칩에 input(내용)을 이름 매칭으로 붙임 → 클릭 시 render 블록 확인(디버그).
            tool_results_summary.push(crate::ports::ToolResultSummary {
                name: "render".to_string(),
                success: true,
                error: None,
                input: Some(serde_json::json!({ "blocks": blocks })),
            });
        }
        // 검증 실패 fence 블록 — 옛엔 silent skip(로그 warn 만)이라 사용자가 "왜 빠졌나" 몰랐음.
        // 실패도 render 뱃지(success:false=빨강)로 노출 → 어떤 블록이 왜 누락됐는지 화면에서 확인.
        for failed in &render_failed_groups {
            let Some(arr) = failed.as_array() else { continue };
            if arr.is_empty() {
                continue;
            }
            let errs: Vec<String> = arr
                .iter()
                .map(|f| {
                    let t = f.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let e = f
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("검증 실패");
                    format!("{t}: {e}")
                })
                .collect();
            executed_actions.push(serde_json::Value::String("render".to_string()));
            tool_results_summary.push(crate::ports::ToolResultSummary {
                name: "render".to_string(),
                success: false,
                error: Some(errs.join(" / ")),
                input: Some(serde_json::json!({ "failed": failed })),
            });
        }

        // 누적된 blocks (도구 결과 render_*) 와 markdown segments 변환 결과 병합.
        // 옛 TS 와 동일하게 — 도구 결과 blocks 가 먼저, 마지막 final reply 의 markdown 변환이 뒤.
        let mut final_blocks = blocks;
        for b in extracted_blocks {
            final_blocks.push(b);
        }

        // Text blocks were pushed RAW during the round loop (before fence processing) — the
        // frontend renders THESE, not clean_reply. For ordinary fences raw ≈ sanitized so it
        // never mattered, but server-side transforms (dataCacheKey injection) only existed in
        // clean_reply → the displayed copy kept an unresolved dataCacheKey and StockChart
        // crashed on data=undefined (2026-07-06 실측). Re-run fence sanitize on every text
        // block so the displayed copy carries the same normalized/injected fences. Badges were
        // already emitted from the last_text pass — none here (avoid duplicates).
        for b in final_blocks.iter_mut() {
            let is_text = b.get("type").and_then(|v| v.as_str()) == Some("text");
            if !is_text {
                continue;
            }
            let Some(t) = b.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if !t.contains("```firebat-render") && !t.contains("<firebat-render>") {
                continue;
            }
            let (masked, fences, _, _) = render_exec::mask_and_sanitize_fences(
                t,
                fence_data_resolver.as_deref(),
            );
            let restored = render_exec::restore_fences(&masked, &fences);
            b["text"] = serde_json::Value::String(restored);
        }

        // Honest failure fallback — a turn that produced literally NOTHING visible (no reply,
        // no blocks, no pending card, no suggestion chips) used to persist an empty system row:
        // the UI showed the "응답이 비어있습니다" invariant, DB-poll recovery reloaded the same
        // emptiness, and the NEXT turn's history had no anchor (대화 단절). Persist an honest
        // failure text instead (2026-07-07 실측: search 도구 스팸 25콜 소진 턴). propose_plan /
        // approval / suggest 턴은 blocks·pending·suggestions 가 차 있어 자연 제외.
        if clean_reply.trim().is_empty()
            && final_blocks.is_empty()
            && pending_actions.is_empty()
            && cli_suggestions.is_empty()
        {
            clean_reply = if tool_budget_exhausted {
                crate::i18n::t(
                    "core.error.ai.turn_exhausted",
                    None,
                    &[("max", &max_turns.to_string())],
                )
            } else {
                crate::i18n::t("core.error.ai.empty_final", None, &[])
            };
            // Completed work must not vanish into the canned line (20차 실측: 차트 조회·스트림
            // 구독을 실제로 성공시키고도 소진 → canned 메시지가 전부 삼킴). The ledger's DONE
            // receipts are server-verified — append them so the user sees what DID happen.
            let done_lines: Vec<&String> = turn_ledger
                .iter()
                .filter(|l| l.starts_with("- DONE "))
                .collect();
            if !done_lines.is_empty() {
                clean_reply.push_str("\n\n");
                clean_reply.push_str(&crate::i18n::t("core.error.ai.exhausted_done_prefix", None, &[]));
                for l in done_lines {
                    clean_reply.push('\n');
                    clean_reply.push_str(l);
                }
            }
            // Live SSE clients render chunk text — emit so the fallback is visible without reload.
            emit_event(AiStreamEvent::Chunk {
                event_type: "text".to_string(),
                content: clean_reply.clone(),
            });
        }

        // Vertex AI 파인튜닝용 학습 데이터 기록 (옛 TS ai-manager.ts:1526 1:1).
        // contents 형식: user → model(functionCall) → user(functionResponse) → ... → model(text).
        // logger.info("[USER_AI_TRAINING] {...}") 출력 시 log adapter 가 별도 JSONL 파일로 분기.
        self.training_log_contents(prompt, &tool_exchanges, &clean_reply);

        // 시크릿 / 토큰 redaction — 외부 API 응답 본문 안 api-key / customer-id / Bearer / JWT 등이
        // 도구 결과 / 에러 메시지 / 응답 텍스트 안에 그대로 흘러가 사용자 채팅 화면 노출되는 사고
        // 차단. 본 layer 단일 게이트 — 도구별 / sysmod별 개별 mask 작업 불필요.
        let response = AiResponse {
            reply: clean_reply,
            blocks: final_blocks,
            executed_actions,
            suggestions: cli_suggestions,
            pending_actions,
            error: None,
            exhausted: tool_budget_exhausted,
            // Honest unattended verdict — stage 2 hard stop, OR stage 1 narrowing that never
            // produced a successful ACTION tool call afterwards (the turn ended still inside its
            // discovery loop; a text-only finish there is not mission success for cron).
            forced_final: force_final || (!capped_strip.is_empty() && !post_narrow_success),
            model_id: Some(last_model_id),
            cost_usd: Some(total_cost),
            tool_results: tool_results_summary,
            library_hits: retrieved_library_hits,
            // Project Builder — 활성 빌드 세션을 프론트로 전달 (stepper/만료 표시).
            build_session: {
                // scope 키 — hub: hubOwner / admin: 대화 id (위 주입과 동일 규칙).
                let is_hub = ai_opts.hub_context.is_some();
                let scope: Option<String> = ai_opts.hub_context.as_ref().map(|c| {
                    if c.session_id.is_empty() { c.instance_id.clone() }
                    else { format!("{}:{}", c.instance_id, c.session_id) }
                }).or_else(|| ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty()).map(String::from));
                scope.and_then(|s| {
                    crate::utils::build_session::active_session_for_conv(&s)
                        // admin CLI: start_build 가 MCP 경유라 convId 주입이 안 돼 세션이 conv_id=None 고아로
                        // 생성됨 → 이 conv 에 입양해야 카드 + cross-turn 단계 주입이 동작. hub 는 절대 입양 안 함
                        // (admin 고아를 hub 방문자에 바인딩 = cross-tenant). hub/FC 는 이미 conv-keyed.
                        .or_else(|| if is_hub { None } else { crate::utils::build_session::adopt_orphan_for_conv(&s) })
                })
                    .and_then(|sess| serde_json::to_value(sess).ok())
            },
            reasoning_trace,
            final_reasoning,
        };

        Ok(self.finalize(ai_opts, response))
    }

    /// Vertex AI 파인튜닝 학습 데이터 기록 — 옛 TS `trainingLogContents` 1:1.
    ///
    /// contents 형식 (Gemini fine-tuning 호환):
    /// `user → model(functionCall) → user(functionResponse) → ... → model(text)`
    ///
    /// 도구 결과는 `trim_tool_result` 로 2000자 cap (파인튜닝 토큰 비용 절감).
    /// 실패는 무시 (서비스 영향 없음).
    fn training_log_contents(
        &self,
        prompt: &str,
        tool_exchanges: &[crate::ports::ToolExchangeEntry],
        final_reply: &str,
    ) {
        let mut contents: Vec<serde_json::Value> = Vec::new();

        // 1. 사용자 프롬프트 (history 는 별도 batch 에서 추가 — 현재 process_with_tools_opts 가 아직
        //    history 를 받지 않음. HistoryResolver 가 system_prompt 로 주입하는 구조라 학습 데이터엔 미포함)
        contents.push(serde_json::json!({
            "role": "user",
            "parts": [{"text": prompt}],
        }));

        // 2. 멀티턴 도구 교환
        for ex in tool_exchanges {
            // model: functionCall parts
            let model_parts: Vec<serde_json::Value> = ex
                .tool_calls
                .iter()
                .map(|tc| {
                    serde_json::json!({
                        "functionCall": {
                            "name": tc.name,
                            "args": tc.arguments,
                        }
                    })
                })
                .collect();
            if !model_parts.is_empty() {
                contents.push(serde_json::json!({
                    "role": "model",
                    "parts": model_parts,
                }));
            }
            // user: functionResponse parts (trim 적용)
            let response_parts: Vec<serde_json::Value> = ex
                .tool_results
                .iter()
                .map(|tr| {
                    serde_json::json!({
                        "functionResponse": {
                            "name": tr.name,
                            "response": crate::managers::ai::result_processor::trim_tool_result(&tr.result),
                        }
                    })
                })
                .collect();
            if !response_parts.is_empty() {
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": response_parts,
                }));
            }
        }

        // 3. 최종 텍스트 응답
        if !final_reply.is_empty() {
            contents.push(serde_json::json!({
                "role": "model",
                "parts": [{"text": final_reply}],
            }));
        }

        let payload = serde_json::json!({"contents": contents});
        if let Ok(json) = serde_json::to_string(&payload) {
            self.log.info(&format!("[USER_AI_TRAINING] {}", json));
        }
    }

    /// 도구 호출 dispatch — ToolManager 위임 (Step 2/3 기반).
    /// Phase B-16+ 에서 정적 27개 도구 (search_history / save_page / image_gen / render_*) +
    /// 동적 sysmod_* + mcp_* 핸들러 등록 후 실 매니저 메서드 호출.
    #[doc(hidden)]
    async fn dispatch_tool(&self, call: &ToolCall) -> ToolResult {
        match self.tools.dispatch(&call.name, &call.arguments).await {
            Ok(result) => ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                result,
                success: true,
                error: None,
                arguments: call.arguments.clone(),
            },
            Err(e) => ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                // The model only ever sees `result` (every LLM format sends `content:
                // to_string(&result)`), never the `error` field — so a bare Null gave the model
                // literally "null" with no reason and it kept retrying blind (2026-07-09 실측:
                // execute ×5, 왜 실패했는지 모른 채). Surface the error text in the result too.
                result: serde_json::json!({ "success": false, "error": e.clone() }),
                success: false,
                error: Some(e),
                arguments: call.arguments.clone(),
            },
        }
    }
}

/// 텍스트 블록 dedup push — 같은 signature 의 text 가 이미 blocks 에 있으면 스킵.
/// 옛 TS ai-manager.ts:1448-1463 1:1 port. 숫자·구두점·공백 제거 sig 기반 70% prefix 매칭.
fn push_text_block_dedup(blocks: &mut Vec<serde_json::Value>, text: &str) {
    let new_sig = signature(text);
    let is_dup = blocks.iter().any(|b| {
        if b.get("type").and_then(|v| v.as_str()) != Some("text") {
            return false;
        }
        let Some(existing) = b.get("text").and_then(|v| v.as_str()) else {
            return false;
        };
        let ex = existing.trim();
        if ex == text || ex.contains(text) || text.contains(ex) {
            return true;
        }
        let ex_sig = signature(ex);
        if new_sig.chars().count() < 30 || ex_sig.chars().count() < 30 {
            return false;
        }
        let min_len = std::cmp::min(new_sig.chars().count(), ex_sig.chars().count());
        let threshold = (min_len as f64 * 0.7) as usize;
        let take = |s: &str| -> String { s.chars().take(threshold).collect() };
        take(&ex_sig) == take(&new_sig)
    });
    if !is_dup {
        blocks.push(serde_json::json!({
            "type": "text",
            "text": text,
        }));
    }
}

/// schedule_task past-runat 판정 — canonical 은 utils::pending_tools (MCP pending_or_passthrough 와 공용).
use crate::utils::pending_tools::is_past_iso;

/// 텍스트 → signature (숫자·구두점·공백 제거). 옛 TS `sig` 1:1.
fn signature(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !c.is_ascii_digit()
                && !c.is_whitespace()
                && !"()（）[]{}.*_~-,!?:;'\"`。、".contains(*c)
        })
        .collect()
}

// public-API tests (process_with_tools / process_with_tools_opts / cost_budget_guard /
// training_log / cli_session_resume / search_components_handler) 는
// `infra/tests/ai_manager_public_test.rs` (integration) 로 이관. private fn
// (`signature`, `push_text_block_dedup`, `is_past_iso`) + ScriptedLlm / CapturingLog 등
// test-only helper struct 사용 test 만 inline 유지.
#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::log::ConsoleLogAdapter;
    use firebat_infra::adapters::storage::LocalStorageAdapter;
    use crate::ports::{IStoragePort, LlmTextResponse, LlmToolResponse};
    use std::sync::Mutex as StdMutex;

    /// 스크립트 LLM — 첫 호출엔 설정된 tool_calls 반환, 이후 turn 엔 빈 tool_calls 로 종료.
    /// approval gate / pending_actions 흐름 검증용.
    struct ScriptedLlm {
        model_id: String,
        scripted_calls: StdMutex<Vec<ToolCall>>,
    }

    impl ScriptedLlm {
        fn new(model_id: &str, calls: Vec<ToolCall>) -> Self {
            Self {
                model_id: model_id.to_string(),
                scripted_calls: StdMutex::new(calls),
            }
        }
    }

    #[async_trait::async_trait]
    impl ILlmPort for ScriptedLlm {
        fn get_model_id(&self) -> String {
            self.model_id.clone()
        }
        async fn ask_text(
            &self,
            _prompt: &str,
            _opts: &LlmCallOpts,
        ) -> InfraResult<LlmTextResponse> {
            Ok(LlmTextResponse {
                text: String::new(),
                model_id: self.model_id.clone(),
                cost_usd: Some(0.0),
                tokens_in: Some(0),
                tokens_out: Some(0),
                cached_tokens: Some(0),
            })
        }
        async fn ask_with_tools(
            &self,
            _prompt: &str,
            _tools: &[ToolDefinition],
            _prior_results: &[ToolResult],
            _opts: &LlmCallOpts,
        ) -> InfraResult<LlmToolResponse> {
            // 첫 호출만 scripted calls — 이후 빈 응답 (loop 종료)
            let calls = std::mem::take(&mut *self.scripted_calls.lock().unwrap_or_else(|p| p.into_inner()));
            Ok(LlmToolResponse {
                text: if calls.is_empty() {
                    "최종 응답".to_string()
                } else {
                    String::new()
                },
                tool_calls: calls,
                model_id: self.model_id.clone(),
                cost_usd: Some(0.0),
                tokens_in: Some(0),
                tokens_out: Some(0),
                ..Default::default()
            })
        }
    }

    fn manager_with_dispatcher(
        scripted_calls: Vec<ToolCall>,
    ) -> (AiManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let llm: Arc<dyn ILlmPort> = Arc::new(ScriptedLlm::new("scripted", scripted_calls));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let storage: Arc<dyn IStoragePort> =
            Arc::new(LocalStorageAdapter::new(dir.path().to_path_buf()));
        let dispatcher = Arc::new(ToolDispatcher::new(storage));
        let mgr = AiManager::new(llm, tools, log).with_tool_dispatcher(dispatcher);
        (mgr, dir)
    }

    #[test]
    fn signature_strips_digits_and_punct() {
        let sig1 = signature("Hello, World! 123");
        let sig2 = signature("HelloWorld");
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn dedup_skips_exact_match() {
        let mut blocks = vec![serde_json::json!({"type":"text","text":"안녕하세요"})];
        push_text_block_dedup(&mut blocks, "안녕하세요");
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn dedup_skips_substring_match() {
        let mut blocks = vec![serde_json::json!({"type":"text","text":"오늘 날씨는 맑습니다"})];
        push_text_block_dedup(&mut blocks, "오늘 날씨는 맑습니다 그리고 따뜻합니다");
        // 새 text 가 기존 text 를 contains → dup
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn dedup_pushes_distinct_text() {
        let mut blocks = vec![serde_json::json!({"type":"text","text":"안녕하세요"})];
        push_text_block_dedup(&mut blocks, "오늘은 매우 다른 내용을 30자 이상 넘기고 있습니다 분명히");
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn dedup_short_text_not_signature_compared() {
        // 30자 미만은 signature 비교 안 함 — exact / contains 만 체크
        let mut blocks = vec![serde_json::json!({"type":"text","text":"안녕"})];
        push_text_block_dedup(&mut blocks, "잘가");
        assert_eq!(blocks.len(), 2);
    }

    #[tokio::test]
    async fn approval_gate_creates_pending_for_delete_file() {
        // delete_file → approval gate 항상 발동 (옛 TS check_needs_approval 동등)
        let _g = crate::utils::shared_test_lock();
        let scripted = vec![ToolCall {
            id: "call-1".to_string(),
            name: "delete_file".to_string(),
            arguments: serde_json::json!({"path": "user/test.txt"}),
        }];
        let (mgr, _dir) = manager_with_dispatcher(scripted);
        let response = mgr
            .process_with_tools_opts(
                "delete it",
                &[],
                &LlmCallOpts::default(),
                &AiRequestOpts::default(),
            )
            .await
            .unwrap();
        assert_eq!(response.pending_actions.len(), 1);
        let pending = &response.pending_actions[0];
        assert_eq!(pending["name"], "delete_file");
        assert!(pending["summary"].as_str().unwrap().contains("파일 삭제"));
        assert!(pending["planId"].as_str().unwrap().starts_with("plan-"));
        // executedActions 는 도구 이름 (string) 만 — frontend ActionTags 가 string[] 기대.
        // pending / planId 등 메타는 pending_actions 쪽에서 별도 노출.
        let exec = &response.executed_actions[0];
        assert_eq!(exec, &serde_json::Value::String("delete_file".to_string()));
    }

    #[tokio::test]
    async fn approval_gate_bypassed_in_cron_agent_mode() {
        // cron agent 모드 — UI 없는 server-side 자율 발행 → approval gate 우회.
        let _g = crate::utils::shared_test_lock();
        let scripted = vec![ToolCall {
            id: "call-1".to_string(),
            name: "delete_file".to_string(),
            arguments: serde_json::json!({"path": "user/test.txt"}),
        }];
        let (mgr, _dir) = manager_with_dispatcher(scripted);
        let ai_opts = AiRequestOpts {
            cron_agent: Some(crate::ports::CronAgentOpts {
                job_id: "test-job".to_string(),
                title: None,
            }),
            ..Default::default()
        };
        let response = mgr
            .process_with_tools_opts("delete it", &[], &LlmCallOpts::default(), &ai_opts)
            .await
            .unwrap();
        // cron agent: pending 안 만들어짐 → 직접 dispatch (ToolManager 등록 안 돼서 unknown tool)
        assert_eq!(response.pending_actions.len(), 0);
    }

    #[tokio::test]
    async fn approval_gate_schedule_task_past_runat_marked() {
        // runAt 이 이미 과거인 schedule_task — pending.status='past-runat' + originalRunAt 포함
        let _g = crate::utils::shared_test_lock();
        let past_iso = "2020-01-01T00:00:00+09:00";
        let scripted = vec![ToolCall {
            id: "call-1".to_string(),
            name: "schedule_task".to_string(),
            arguments: serde_json::json!({
                "title": "테스트",
                "runAt": past_iso,
                "targetPath": "/some/page",
            }),
        }];
        let (mgr, _dir) = manager_with_dispatcher(scripted);
        let response = mgr
            .process_with_tools_opts(
                "schedule",
                &[],
                &LlmCallOpts::default(),
                &AiRequestOpts::default(),
            )
            .await
            .unwrap();
        assert_eq!(response.pending_actions.len(), 1);
        let pending = &response.pending_actions[0];
        assert_eq!(pending["status"], "past-runat");
        assert_eq!(pending["originalRunAt"], past_iso);
    }

    #[tokio::test]
    async fn approval_gate_pre_validate_failure_no_pending_no_ui() {
        // schedule_task 의 cronTime / runAt / delaySec 모두 빠진 경우 → pre_validate 실패
        // → pending 미생성 + executedActions 미노출 + tool 결과만 에러
        let _g = crate::utils::shared_test_lock();
        let scripted = vec![ToolCall {
            id: "call-1".to_string(),
            name: "schedule_task".to_string(),
            arguments: serde_json::json!({
                "title": "테스트",
                "targetPath": "/x",
                // cronTime / runAt / delaySec 전부 미저장
            }),
        }];
        let (mgr, _dir) = manager_with_dispatcher(scripted);
        let response = mgr
            .process_with_tools_opts(
                "schedule",
                &[],
                &LlmCallOpts::default(),
                &AiRequestOpts::default(),
            )
            .await
            .unwrap();
        // pending 미생성
        assert_eq!(response.pending_actions.len(), 0);
        // executedActions 도 미노출 (UI 비노출)
        assert_eq!(response.executed_actions.len(), 0);
    }

    #[test]
    fn is_past_iso_recognizes_past_time() {
        assert!(is_past_iso("2020-01-01T00:00:00+09:00"));
        assert!(is_past_iso("1990-06-15T12:00:00Z"));
    }

    #[test]
    fn is_past_iso_rejects_future_time() {
        assert!(!is_past_iso("2099-01-01T00:00:00+09:00"));
    }

    #[test]
    fn is_past_iso_invalid_returns_false() {
        // 파싱 실패 시 false (보수적)
        assert!(!is_past_iso("not-iso"));
        assert!(!is_past_iso(""));
    }

}
