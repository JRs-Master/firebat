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
    AiRequestOpts, ILlmPort, ILogPort, IVaultPort, InfraResult, LlmCallOpts, ToolCall,
    ToolDefinition, ToolResult,
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
}

/// AiResponse 안 모든 사용자 노출 string 필드 안 시크릿 / 토큰 마스킹. process_with_tools_opts
/// 종료 직전 단일 게이트 — 외부 API 응답 본문 안 api-key / customer-id / Bearer / JWT / sk-* /
/// AIza* / Telegram bot token 등이 도구 결과 / 에러 메시지 / reply / blocks 안에 그대로 흘러가
/// 사용자 채팅 화면 노출되는 사고 차단.
fn redact_response(mut r: AiResponse) -> AiResponse {
    use crate::utils::redactor::{redact_string, redact_value};
    r.reply = redact_string(&r.reply);
    if let Some(ref err) = r.error.clone() {
        r.error = Some(redact_string(err));
    }
    r.blocks = r.blocks.into_iter().map(|v| redact_value(&v)).collect();
    r.executed_actions = r.executed_actions.into_iter().map(|v| redact_value(&v)).collect();
    r.suggestions = r.suggestions.into_iter().map(|v| redact_value(&v)).collect();
    r.pending_actions = r.pending_actions.into_iter().map(|v| redact_value(&v)).collect();
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
        }
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
                    crate::managers::ai::component_search_index::query(embedder.as_ref(), cache.as_ref(), &query, opts)
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
    pub async fn process_with_tools_opts_with_emit(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
        ai_opts: &AiRequestOpts,
        emit: Option<mpsc::Sender<AiStreamEvent>>,
    ) -> InfraResult<AiResponse> {
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
                    "[AiManager] 비용 한도 초과 — LLM 호출 차단: {}",
                    reason
                ));
                return Ok(redact_response(AiResponse {
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
                        "[AiManager] image slug URL → data URL 변환 (slug URL len={}, data URL len={})",
                        img.len(),
                        data_url.len()
                    ));
                    effective_opts.image = Some(data_url);
                } else {
                    self.log.warn(&format!(
                        "[AiManager] image slug URL 변환 실패 (read fail) — 옛 값 그대로 LLM 전달: {}",
                        img
                    ));
                }
            }
        }

        // Library Phase 1 단계 8.4 (2026-05-17) — retrieve_library_hits 누적. RetrievalEngine 가
        // 매 query 시점 매칭한 결과 metadata. 함수 끝 AiResponse.library_hits 로 노출.
        let mut retrieved_library_hits: Vec<crate::ports::LibraryHit> = Vec::new();

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
            return Ok(redact_response(AiResponse {
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
                // Single permission gate — same hub_context::permits_tool as the hosted (mcp_server) path (no drift).
                // Allow = core sysmods (notes/calendar) + allowed_sysmods + read-only + render_* + owner-scoped writes.
                // Owner-scoping of the allowed writes is enforced per-tool (confine_hub_path / project-match),
                // NOT by this name filter — this only decides which tools are exposed.
                tools_built.retain(|t| crate::utils::hub_context::permits_tool(&t.name, &ctx.allowed_sysmods));
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

        if effective_opts.system_prompt.is_none() {
            if let Some(pb) = &self.prompt_builder {
                let mut extra_parts: Vec<String> = Vec::new();
                if let Some(g) = &self.context_gatherer {
                    let ctx = g.gather().await;
                    if !ctx.is_empty() {
                        extra_parts.push(ctx);
                    }
                }
                // Project Builder admin CLI reinforcement (#1-lite) — for FC, ai.rs injects convId into
                // the tool args, but the CLI (its own MCP loop) has no such injection path, so the build
                // session wouldn't link to the conversation.
                // → On admin (non-hub) turns only, hint the AI to pass convId itself. Only the first
                // start_build depends on the AI; afterward the engine's cross-turn (active_session_for_conv) takes over. (hub uses the hubOwner key, excluded.)
                if ai_opts.hub_context.is_none() {
                    if let Some(cid) = ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty()) {
                        extra_parts.push(format!(
                            "[Build tracking] When calling start_build/advance_build/cancel_build, also pass convId=\"{}\" (so the build continues across turns).",
                            cid
                        ));
                    }
                }
                // hub 영역 = HistoryResolver 우회 + hub_context.history 직접 format prepend.
                // hub_conversations 영역 별도 테이블이라 HistoryResolver (admin conversations 영역 의존) 미적용.
                if let Some(ctx) = &ai_opts.hub_context {
                    if !ctx.history.is_empty() {
                        let mut s = String::from("## 최근 대화 컨텍스트\n");
                        for msg in ctx.history.iter() {
                            let role_label = match msg.role.as_str() {
                                "user" => "사용자",
                                "assistant" | "system" => "AI",
                                _ => continue,
                            };
                            let content_str = msg.content.as_str().unwrap_or("");
                            let preview: String = content_str.chars().take(200).collect();
                            if !preview.trim().is_empty() {
                                s.push_str(&format!("- [{}]: {}\n", role_label, preview));
                            }
                        }
                        if s.lines().count() > 1 {
                            extra_parts.push(s);
                        }
                    }
                    // instance 커스텀 지침 — 기본 프롬프트(에이전트·plan·render 규칙)에 **추가** (replace 아님).
                    // 옛 방식(llm_opts.system_prompt=instance)은 이 블록 전체를 skip 해 hub 가 인사·plan 실행 누락하던 root.
                    if let Some(directive) = ctx
                        .instance_directive
                        .as_deref()
                        .filter(|d| !d.trim().is_empty())
                    {
                        extra_parts.push(format!("## 이 어시스턴트의 추가 지침\n{}", directive));
                    }
                } else if let Some(hr) = &self.history_resolver {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    let conv_id = effective_opts
                        .conversation_id
                        .as_deref()
                        .or(ai_opts.conversation_id.as_deref());
                    // 직전 연속성 — recent N턴 (현재 대화 그대로).
                    if let Some(hist) = hr.resolve(owner, conv_id) {
                        extra_parts.push(hist);
                    }
                    // 관련 과거 회상 — 벡터(E5) 검색. embedder 만 있으면 작동 (ai-router 토글 무관 —
                    // 4-tier RetrievalEngine 과 별개). 현재 대화 밖 의미 매칭 대화를 full Q&A 로 주입.
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

                // RetrievalEngine 자동 prepend (Recall 회상) — **토글 무관 항상** (Phase C split, 2026-06-14).
                // 회상(읽기)은 E5 라 싸고 "저장한 건 써야" → 늘 주입. 토글(VK_SYSTEM_AI_ROUTER_ENABLED)은
                // 이제 자동 *쓰기*(cron consolidation 추출)만 게이트한다 (옛엔 read+write 통합 게이트였음).
                // owner-scope = retrieve_opts.owner (hub = 자기 hub Recall), library = reference_filter 로
                // hub allowed_references 제한 → cross-tenant 안전.
                if let Some(engine) = &self.retrieval_engine {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .map(String::from);
                    let conv_id = effective_opts
                        .conversation_id
                        .as_deref()
                        .or(ai_opts.conversation_id.as_deref())
                        .map(String::from);
                    // hub_context 가 있으면 library 검색을 allowed_references 로 제한.
                    let reference_filter = ai_opts
                        .hub_context
                        .as_ref()
                        .map(|c| c.allowed_references.clone());
                    let retrieve_opts = retrieval_engine::RetrieveOpts {
                        query: prompt.to_string(),
                        owner,
                        current_conv_id: conv_id,
                        limits: retrieval_engine::RetrievalLimits::default(),
                        reference_filter,
                    };
                    let result = engine.retrieve(&retrieve_opts).await;
                    if !result.context_summary.is_empty() {
                        // RetrievalEngine already wraps in <RETRIEVED_CONTEXT> — push as-is (no double-wrap).
                        extra_parts.push(result.context_summary);
                    }
                    // hit metadata 영역 보관 — 함수 끝 AiResponse.library_hits 로 노출.
                    if !result.library_hits.is_empty() {
                        retrieved_library_hits = result.library_hits;
                    }
                }

                // Operational memory (data/memory) — 큐레이트 운영지식 인덱스. ai-router 토글과
                // 무관하게 *항상* 주입 (CLAUDE.md 가 늘 로드되듯). 위 RetrievalEngine(Recall) 은
                // 자동/의미 store 라 토글 게이트지만, 이건 손으로 관리(+자동 distill)한 운영지식이라
                // 켜든 끄든 항상 효력. 현재 owner=="admin" 만 주입 (hub 는 게이트 OFF).
                if let Some(mf) = &self.memory_file {
                    let owner = effective_opts
                        .owner
                        .as_deref()
                        .or(ai_opts.owner.as_deref())
                        .unwrap_or("admin");
                    if owner == "admin" {
                        if let Ok(index) = mf.get_index(None).await {
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
                let base_prompt = pb.build(extra.as_deref(), cron_ctx.as_ref());

                // plan_execute_id / plan_revise_id 우선 처리 — 사용자 ✓실행 / ⚙수정 클릭 후 follow-up
                // turn. plan_store 에서 조회 → 시스템 프롬프트 prepend + 옛 plan_prefix 우회 (plan 카드
                // 재제안 안 함). 옛 TS `planExecuteRule` 흐름 1:1.
                let plan_instruction: Option<String> = if let Some(pid) =
                    ai_opts.plan_execute_id.as_deref().filter(|s| !s.is_empty())
                {
                    if let Some(plan) = crate::utils::plan_store::get_plan(pid) {
                        let inst = crate::utils::plan_store::plan_to_instruction(&plan, None);
                        crate::utils::plan_store::delete_plan(pid);
                        self.log.info(&format!(
                            "[AiManager] plan_execute_id 처리: {} (title={})",
                            pid, plan.title
                        ));
                        Some(inst)
                    } else {
                        self.log.warn(&format!(
                            "[AiManager] plan_execute_id {} 조회 실패 (만료 또는 부재) — 일반 흐름 진행",
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
                            "[AiManager] plan_revise_id 처리: {} (title={})",
                            rid, plan.title
                        ));
                        Some(inst)
                    } else {
                        self.log.warn(&format!(
                            "[AiManager] plan_revise_id {} 조회 실패 — 일반 흐름 진행",
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
        // cron agent 모드는 approval gate 우회 (UI 없는 server-side 자율 발행).
        let approval_enabled = self.dispatcher.is_some() && ai_opts.cron_agent.is_none();

        // Hub visitor 호출 — 턴별 고유 MCP 토큰 발급 + 컨텍스트 맵 등록 → 그 토큰을 mcp_token 으로 주입.
        // CLI 의 MCP 호출이 그 토큰으로 자기 컨텍스트만 보게 해 동시 visitor race(답 꼬임/누수) 차단.
        // MCP server handler 가 토큰으로 컨텍스트를 찾아 owner 격리 + allowed_sysmods 검사. Guard drop = 등록 해제.
        let _hub_guard = ai_opts.hub_context.as_ref().map(|ctx| {
            let (guard, token) = crate::utils::hub_context::HubContextGuard::enter(
                ctx.allowed_sysmods.clone(),
                ctx.instance_id.clone(),
                ctx.session_id.clone(),
                ctx.allowed_references.clone(),
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
                            "[AiManager] 비용 한도 초과 — LLM 호출 차단: {}",
                            reason
                        ));
                        return Ok(redact_response(AiResponse {
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
                            model_id: Some(last_model_id.clone()),
                            cost_usd: Some(0.0),
                            tool_results: Vec::new(),
                            library_hits: Vec::new(),
                            build_session: None,
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

            let response = self
                .llm
                .ask_with_tools_streaming(
                    llm_prompt,
                    effective_tools,
                    &prior_results,
                    &turn_opts,
                    llm_sink.clone(),
                )
                .await?;
            last_text = response.text.clone();
            last_model_id = response.model_id.clone();

            // streaming chunk emit — 매 turn LLM 의 reasoning text 영역 사용자한테 즉시 보임.
            // thinking 먼저 (있을 때만) → text 다음. frontend ThinkingBlock 가 thinking content
            // bodyText 영역 표시 + text 는 답변 본문 영역 표시 (옛 TS Core 1:1 흐름).
            if let Some(thinking) = response.thinking_text.as_deref() {
                if !thinking.trim().is_empty() {
                    emit_event(AiStreamEvent::Chunk {
                        event_type: "thinking".to_string(),
                        content: thinking.to_string(),
                    });
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
                        "[AiManager] CLI session_id 영속화: conv={} model={} session_id={}",
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
                if is_propose_plan_turn {
                    self.log.info("[AiManager] propose_plan turn → trailing text drop");
                    last_text = String::new();
                } else if !last_text.is_empty() {
                    // text 블록 dedup — 같은 sig 의 text 가 이미 blocks 에 있으면 스킵.
                    push_text_block_dedup(&mut blocks, &last_text);
                }
                self.log.info(&format!(
                    "[AiManager] turn {} 종료 — 도구 호출 0개",
                    turn + 1
                ));
                break;
            }

            // Layer 2 reset — 매 turn 새 set
            turn_call_set = HashSet::new();
            let mut turn_results: Vec<(ToolCall, ToolResult)> = Vec::new();

            for call in response.tool_calls.iter() {
                // Approval gate (옛 TS ai-manager.ts 1342-1385 1:1) —
                // 1. cron agent 모드면 우회 (server-side 실행)
                // 2. ToolDispatcher 설정되어 있을 때만 작동
                // 3. check_needs_approval 결과 Some(summary) 면 pre_validate 후 pending 등록
                // 4. pre_validate 실패 시 UI 미노출 + AI 한테 에러 결과만 → 다음 turn 재시도
                if approval_enabled {
                    if let Some(dispatcher) = &self.dispatcher {
                        if let Some(approval) = dispatcher.check_needs_approval(call).await {
                            // 사전 검증 — 실패면 UI 미노출 + tool 결과만 에러
                            if let Some(pre_err) = dispatcher.pre_validate_pending_args(call) {
                                self.log.warn(&format!(
                                    "[AiManager] Tool 사전검증 실패 (UI 비노출, 재시도 유도): {} — {}",
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
                                        "[AiManager] Tool 인자 schema 불일치 (UI 비노출, 재시도 유도): {} — {}",
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
                            self.log.info(&format!(
                                "[AiManager] Tool 승인 대기: {} (planId={}) — {}",
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
                    let name = sc.name.clone();
                    if let serde_json::Value::Object(ref mut m) = sc.arguments {
                        // Project Builder — start_build 에 convId 주입 (cross-turn 세션 키, AI 미지정).
                        if name == "start_build" {
                            if let Some(cid) =
                                ai_opts.conversation_id.as_deref().filter(|s| !s.is_empty())
                            {
                                m.entry("convId".to_string())
                                    .or_insert_with(|| serde_json::Value::String(cid.to_string()));
                            }
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
                let cache_key = tool_cache_key(&effective_call.name, &effective_call.arguments);
                let action = if turn_call_set.contains(&cache_key) {
                    // Layer 2: 이번 turn 에 이미 같은 호출 → 즉시 reject
                    self.log.warn(&format!(
                        "[AiManager] Tool 중복 호출 차단 (per-turn): {}",
                        call.name
                    ));
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": "이번 턴에 같은 인자로 이미 호출된 도구입니다. 직전 결과를 사용하거나 다른 인자로 호출하세요. 같은 호출 retry 금지.",
                            "duplicateInTurn": true,
                        }),
                        success: false,
                        error: Some("per-turn duplicate".to_string()),
                    }
                } else if !self.tools.has_handler(&effective_call.name) {
                    // 미등록(환각) 도구 — dispatch 해도 handler_not_registered 뿐. 즉시 firm 반환 + 이름 추적.
                    // 매 턴 재호출(x4/x7)로 MAX_TOOL_TURNS 낭비하던 것 차단. "영영 없으니 재시도 마라" 강조.
                    let repeat = !unknown_tool_names.insert(effective_call.name.clone());
                    self.log.warn(&format!(
                        "[AiManager] 미등록 도구 차단{}: {}",
                        if repeat { " (반복)" } else { "" },
                        effective_call.name
                    ));
                    turn_call_set.insert(cache_key.clone());
                    ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        result: serde_json::json!({
                            "success": false,
                            "error": format!("'{}' 도구는 존재하지 않습니다. 절대 다시 호출하지 마세요 — 몇 번을 호출해도 영영 없습니다. 실제 도구: 자동 실행 예약 = schedule_task / 즉시 실행 = run_task / 플랜 = propose_plan / 메모 = sysmod_notes / 날짜 기록(캘린더) = sysmod_calendar. 시스템 상태에 나열된 이름만 사용하세요.", effective_call.name),
                            "unknownTool": true,
                        }),
                        success: false,
                        error: Some("unknown tool".to_string()),
                    }
                } else {
                    turn_call_set.insert(cache_key.clone());
                    if let Some(cached) = get_cached_tool_result(&cache_key) {
                        // Layer 1: cross-turn cache hit (60초 내) → 직전 결과 재사용
                        self.log.info(&format!(
                            "[AiManager] Tool cache HIT: {} — 직전 결과 재사용",
                            call.name
                        ));
                        let mut cached_with_flag = cached.clone();
                        if let serde_json::Value::Object(map) = &mut cached_with_flag {
                            map.insert("fromCache".to_string(), serde_json::Value::Bool(true));
                        }
                        ToolResult {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            success: true,
                            error: None,
                            result: cached_with_flag,
                        }
                    } else {
                        // streaming step emit — 도구 호출 시작.
                        emit_event(AiStreamEvent::Step {
                            name: effective_call.name.clone(),
                            status: "start".to_string(),
                            description: Some(tool_label(&effective_call.name)),
                            error_message: None,
                        });
                        let result = self.dispatch_tool(effective_call).await;
                        if result.success {
                            set_cached_tool_result(&cache_key, &result.result);
                        }
                        // streaming step emit — 도구 호출 완료 / 에러.
                        emit_event(AiStreamEvent::Step {
                            name: effective_call.name.clone(),
                            status: if result.success { "done".to_string() } else { "error".to_string() },
                            description: Some(tool_label(&effective_call.name)),
                            error_message: result.error.clone(),
                        });
                        result
                    }
                };

                // ActionTags 는 string[] 만 받음 — 옛 TS 와 동일하게 도구 이름만.
                executed_actions.push(serde_json::Value::String(call.name.clone()));
                turn_results.push((call.clone(), action));
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
                } else if (tc.name == "render" || render_map.contains_key(tc.name.as_str()))
                    && result.get("component").is_some()
                {
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
                } else if tc.name == "suggest" {
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

            // propose_plan 호출 시 강제 turn 종료 — 사용자가 ✓실행 누른 뒤 다음 turn 진행.
            if is_propose_plan_turn {
                self.log.info(
                    "[AiManager] propose_plan 호출 감지 → trailing text drop + 승인 대기 위해 turn 종료",
                );
                last_text = String::new();
                break;
            }
        }

        // Phase B-17+ result processor — 모든 LLM 응답을 단일 정제 레이어 통과.
        // 옛 TS sanitize.ts 1:1 port. 모델별 quirk fix 모두 일반 로직으로 처리:
        // 1. sanitize_reply — Unicode escape / HTML 태그 / 마크다운 강조 마커 제거
        // 2. extract_markdown_structure — `## 헤더` / `|---|` 표 → render_header / render_table 자동 변환
        // 3. segments_to_blocks — text segment 만 reply 에 남기고 header/table 은 blocks 로 분리
        let sanitized_reply = crate::utils::sanitize::sanitize_reply(&last_text);
        let segments = crate::utils::sanitize::extract_markdown_structure(&sanitized_reply);
        let (clean_reply, extracted_blocks) =
            crate::utils::sanitize::segments_to_blocks(segments);

        // 누적된 blocks (도구 결과 render_*) 와 markdown segments 변환 결과 병합.
        // 옛 TS 와 동일하게 — 도구 결과 blocks 가 먼저, 마지막 final reply 의 markdown 변환이 뒤.
        let mut final_blocks = blocks;
        for b in extracted_blocks {
            final_blocks.push(b);
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
        };

        Ok(redact_response(response))
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
            },
            Err(e) => ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                result: serde_json::Value::Null,
                success: false,
                error: Some(e),
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

/// schedule_task 의 runAt ISO 시각이 이미 과거인지 판정. 옛 TS `Date.parse(runAt) <= Date.now()` 1:1.
/// 파싱 실패 시 false (보수적 — 안전한 쪽이 안 설정).
fn is_past_iso(run_at: &str) -> bool {
    use chrono::DateTime;
    DateTime::parse_from_rfc3339(run_at)
        .map(|t| t.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
        .unwrap_or(false)
}

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
            let calls = std::mem::take(&mut *self.scripted_calls.lock().unwrap());
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
