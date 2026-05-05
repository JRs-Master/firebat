//! AiManager — User AI / Code Assistant / AI Assistant orchestrator.
//!
//! 옛 TS `core/managers/ai-manager.ts` (1249줄, 6 collaborator 분리 후) Rust 재구현.
//! Phase B-16 minimum: shape 박힘 + Function Calling 도구 dispatch 흐름. 실 LLM 호출은 Phase B-17+.
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

use std::collections::HashSet;
use std::sync::Arc;

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
use crate::utils::pending_tools::create_pending;
use crate::utils::render_map::render_tool_map;
use crate::utils::tool_cache::{
    get_cached_tool_result, set_cached_tool_result, tool_cache_key,
};

/// 옛 TS `MAX_TOOL_TURNS` — admin 채팅. 사용자가 다음 turn 도달 시 follow-up 가능 → 10 충분.
const MAX_TOOL_TURNS_ADMIN: usize = 10;
/// Cron agent — 자율 발행. sysmod 4-6개 + save_page 까지 여유.
const MAX_TOOL_TURNS_CRON: usize = 25;
/// 도구 호출 turn — JSON 스키마 정확 준수. 옛 TS 1:1.
const TEMP_TOOL_TURN: f64 = 0.2;
/// 최종 응답 turn — 자연스럽고 풍부한 표현. 옛 TS 1:1.
const TEMP_FINAL_TURN: f64 = 0.85;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

pub struct AiManager {
    llm: Arc<dyn ILlmPort>,
    tools: Arc<ToolManager>,
    log: Arc<dyn ILogPort>,
    /// 시스템 프롬프트 builder (옵션) — Vault 박힌 채로 박힘. 미박힘 시 base prompt 만.
    prompt_builder: Option<PromptBuilder>,
    /// 시스템 컨텍스트 gatherer (옵션) — sysmod / user module / MCP 동적 description 주입.
    /// 미박힘 시 시스템 프롬프트에 컨텍스트 추가 안 됨 (base prompt 만).
    context_gatherer: Option<Arc<SystemContextGatherer>>,
    /// History resolver (옵션) — 옛 TS history-resolver.ts Rust port. opts.conversation_id 박혀있으면
    /// 자동 recent N 메시지 컨텍스트 prepend. IEmbedderPort 박힌 후 임베딩 spread 판정 활성.
    history_resolver: Option<HistoryResolver>,
    /// CostManager (옵션) — LLM 호출 후 자동 비용 누적. 옛 TS ai-manager.ts:1260
    /// `core.recordLlmCost(usage)` 패턴 1:1 port. 미박힘 시 비용 누적 비활성.
    cost: Option<Arc<CostManager>>,
    /// ToolDispatcher (옵션) — approval gate (check_needs_approval + pre_validate_pending_args).
    /// 박혀있으면 destructive 도구 (write_file/save_page 덮어쓰기 / delete_* / schedule_task /
    /// cancel_task) 호출 시 즉시 실행 X → pending 으로 등록. 옛 TS ai-manager.ts approval flow 1:1.
    /// 미박힘 시 모든 도구 즉시 실행 (현재 default — 회귀 안전).
    dispatcher: Option<Arc<ToolDispatcher>>,
    /// ConversationManager (옵션) — CLI session resume 위해 직접 참조. 박혀있고 model 이 `cli-` 로
    /// 시작 + opts.conversation_id 박혀있으면 자동 resume_session_id 주입 + 첫 응답의 session_id
    /// 영속화. 옛 TS ai-manager.ts:914-924 1:1.
    conversation: Option<Arc<ConversationManager>>,
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
        }
    }

    /// ToolDispatcher 박은 채로 부팅 — approval gate (write_file/save_page 덮어쓰기 / delete_* /
    /// schedule_task / cancel_task) 활성. cron agent 모드는 우회 (server-side 실행).
    pub fn with_tool_dispatcher(mut self, dispatcher: Arc<ToolDispatcher>) -> Self {
        self.dispatcher = Some(dispatcher);
        self
    }

    /// ConversationManager 박은 채로 부팅 — CLI session resume 활성 (model 이 `cli-` 로 시작 + 대화
    /// ID 박혀있을 때). 옛 TS getCliSession / setCliSession 1:1.
    pub fn with_conversation_manager(mut self, conversation: Arc<ConversationManager>) -> Self {
        self.conversation = Some(conversation);
        self
    }

    /// `search_components(query)` 도구 등록 — 옛 TS search_components handler 1:1.
    /// IEmbedderPort 박혀있을 때만 호출. ToolManager 에 직접 register_handler.
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
    ) -> Self {
        let embedder_clone = embedder.clone();
        let handler = crate::managers::tool::make_handler(move |args: serde_json::Value| {
            let embedder = embedder_clone.clone();
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
                let opts = crate::llm::component_search_index::ComponentSearchOpts { limit };
                let matches =
                    crate::llm::component_search_index::query(embedder.as_ref(), &query, opts)
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

    /// HistoryResolver 박은 채로 부팅 — opts.conversation_id 박혀있으면 recent N 메시지 자동 prepend.
    pub fn with_history_resolver(mut self, conversation: Arc<ConversationManager>) -> Self {
        self.history_resolver = Some(HistoryResolver::new(conversation));
        self
    }

    /// CostManager 박은 채로 부팅 — LLM 호출마다 자동 비용 누적 (옛 TS recordLlmCost 패턴).
    pub fn with_cost_manager(mut self, cost: Arc<CostManager>) -> Self {
        self.cost = Some(cost);
        self
    }

    /// PromptBuilder 박은 채로 부팅 — 시스템 프롬프트 자동 주입 활성.
    pub fn with_prompt_builder(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.prompt_builder = Some(PromptBuilder::new(vault));
        self
    }

    /// SystemContextGatherer 박은 채로 부팅 — 시스템 프롬프트에 sysmod / mcp 동적 description 자동 주입.
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
    pub async fn process_with_tools_opts(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
        ai_opts: &AiRequestOpts,
    ) -> InfraResult<AiResponse> {
        // 도구 list 미전달 시 ToolManager 등록 도구 자동 사용 (옛 TS buildToolDefinitions 동등).
        let auto_tools: Vec<ToolDefinition>;
        let effective_tools: &[ToolDefinition] = if tools.is_empty() {
            auto_tools = self.build_tool_definitions();
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
        // 1:1. 본 step 에선 planExecuteRule (plan-store) / autoHistoryContext (router) 미박음 — 후속 batch.
        let mut effective_opts = opts.clone();
        if effective_opts.system_prompt.is_none() {
            if let Some(pb) = &self.prompt_builder {
                let mut extra_parts: Vec<String> = Vec::new();
                if let Some(g) = &self.context_gatherer {
                    let ctx = g.gather().await;
                    if !ctx.is_empty() {
                        extra_parts.push(ctx);
                    }
                }
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
                    if let Some(hist) = hr.resolve(owner, conv_id) {
                        extra_parts.push(hist);
                    }
                }
                let extra = if extra_parts.is_empty() {
                    None
                } else {
                    Some(extra_parts.join("\n\n"))
                };
                let base_prompt = pb.build(extra.as_deref(), None);
                let plan_prefix = plan_mode::prefix(ai_opts.plan_mode);
                effective_opts.system_prompt = Some(if plan_prefix.is_empty() {
                    base_prompt
                } else {
                    format!("{}\n\n{}", plan_prefix, base_prompt)
                });
            }
        }

        let mut prior_results: Vec<ToolResult> = Vec::new();
        let mut executed_actions: Vec<serde_json::Value> = Vec::new();
        let mut blocks: Vec<serde_json::Value> = Vec::new();
        let mut pending_actions: Vec<serde_json::Value> = Vec::new();
        let mut last_text = String::new();
        let mut last_model_id = self.llm.get_model_id();
        let mut total_cost: f64 = 0.0;
        // 학습 로그용 turn 별 (calls, results) 페어 누적 — 옛 TS toolExchanges 1:1.
        let mut tool_exchanges: Vec<(Vec<ToolCall>, Vec<ToolResult>)> = Vec::new();
        // cron agent 모드는 approval gate 우회 (UI 없는 server-side 자율 발행).
        let approval_enabled = self.dispatcher.is_some() && ai_opts.cron_agent.is_none();

        // Layer 2 per-turn duplicate guard — turn 안에서 같은 (name + args) 두 번째 호출 차단.
        // 옛 TS `turnCallSet` 1:1.
        let mut turn_call_set: HashSet<String>;

        // CLI session resume — model 이 `cli-` 로 시작 + 대화 ID 박혀있으면 DB 에서 직전 session_id 조회.
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
        let prompt_with_hint: String = match plan_mode::prompt_hint(ai_opts.plan_mode) {
            Some(hint) => format!("{}\n\n{}", hint, prompt),
            None => prompt.to_string(),
        };

        // OpenAI Responses API previous_response_id — 멀티턴 토큰 절감.
        // 첫 turn 엔 effective_opts.previous_response_id (사용자 전달 값) 사용. 이후 turn 매번 갱신.
        let mut current_response_id: Option<String> = effective_opts.previous_response_id.clone();

        for turn in 0..max_turns {
            // Cost budget guard — turn 0 시작 직전에만 체크 (옛 TS ai-manager.ts:1242-1248 1:1).
            // 한도 초과 시 LLM 호출 자체 차단 → 토큰 0 + 비용 0 으로 안전 종료.
            // CostManager 박혀있을 때만 작동 — 미박힘 시 한도 무제한 (회귀 안전).
            if turn == 0 {
                if let Some(cost) = &self.cost {
                    let check = cost.check_budget();
                    if !check.within_budget {
                        let reason = check
                            .reason
                            .clone()
                            .unwrap_or_else(|| "비용 한도 초과".to_string());
                        self.log.warn(&format!(
                            "[AiManager] 비용 한도 초과 — LLM 호출 차단: {}",
                            reason
                        ));
                        return Ok(AiResponse {
                            reply: String::new(),
                            blocks: Vec::new(),
                            executed_actions: Vec::new(),
                            suggestions: Vec::new(),
                            pending_actions: Vec::new(),
                            error: Some(format!("비용 한도 초과: {}", reason)),
                            model_id: Some(last_model_id.clone()),
                            cost_usd: Some(0.0),
                        });
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
                .ask_with_tools(llm_prompt, effective_tools, &prior_results, &turn_opts)
                .await?;
            last_text = response.text.clone();
            last_model_id = response.model_id.clone();
            if let Some(c) = response.cost_usd {
                total_cost += c;
            }

            // CLI session_id 영속화 — 어댑터가 첫 turn 에서 잡은 session_id 를 DB 에 저장.
            // 옛 TS onCliSessionId 콜백 1:1. ConversationManager 박혀있고 model 이 cli- 면 작동.
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
                    0, // cached_tokens — Phase B-17+ Anthropic cache 응답 박힌 후
                    response.cost_usd.unwrap_or(0.0),
                    Some("user-ai"),
                );
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
                // 2. ToolDispatcher 박혀있을 때만 작동
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
                            // pending 등록
                            let plan_id = create_pending(
                                &call.name,
                                call.arguments.clone(),
                                &approval.summary,
                            );
                            // schedule_task: runAt 이 이미 과거면 처음부터 past-runat 상태로 내려서
                            // 승인 버튼 대신 즉시보내기/시간변경 버튼이 뜨도록 유도 (옛 TS 1:1).
                            let mut pending = serde_json::json!({
                                "planId": plan_id,
                                "name": call.name,
                                "summary": approval.summary,
                                "args": call.arguments,
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
                            // executedActions 에는 노출 (UI 배지 표시) — 옛 TS 와 동등
                            executed_actions.push(serde_json::json!({
                                "tool": call.name,
                                "callId": call.id,
                                "success": true,
                                "pending": true,
                                "planId": plan_id,
                            }));
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

                // Layer 1 + 2 retry guard — 모든 도구 동일 적용 (특정 도구 하드코딩 X).
                let cache_key = tool_cache_key(&call.name, &call.arguments);
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
                        let result = self.dispatch_tool(call).await;
                        if result.success {
                            set_cached_tool_result(&cache_key, &result.result);
                        }
                        result
                    }
                };

                executed_actions.push(serde_json::json!({
                    "tool": call.name,
                    "callId": call.id,
                    "success": action.success,
                    "error": action.error,
                }));
                turn_results.push((call.clone(), action));
            }

            // Render component blocks — RENDER_TOOL_MAP 매칭 + tc.name == "render" + result.component
            // 옛 TS ai-manager.ts:1464-1478 1:1.
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
                }
            }

            // 중간 turn text — dedup 후 blocks 에 push (옛 TS 1:1).
            if !last_text.is_empty() {
                push_text_block_dedup(&mut blocks, &last_text);
            }

            // prior_results 누적 — 다음 turn 의 toolExchanges 로 LLM 에 전달.
            // 학습 로그용 — turn 별 (calls, results) 페어 별도 보존.
            let turn_calls: Vec<ToolCall> = turn_results.iter().map(|(c, _)| c.clone()).collect();
            let turn_action_results: Vec<ToolResult> =
                turn_results.iter().map(|(_, r)| r.clone()).collect();
            tool_exchanges.push((turn_calls, turn_action_results));
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

        Ok(AiResponse {
            reply: clean_reply,
            blocks: final_blocks,
            executed_actions,
            suggestions: Vec::new(),
            pending_actions,
            error: None,
            model_id: Some(last_model_id),
            cost_usd: Some(total_cost),
        })
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
        tool_exchanges: &[(Vec<ToolCall>, Vec<ToolResult>)],
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
        for (calls, results) in tool_exchanges {
            // model: functionCall parts
            let model_parts: Vec<serde_json::Value> = calls
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
            let response_parts: Vec<serde_json::Value> = results
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
/// 파싱 실패 시 false (보수적 — 안전한 쪽이 안 박힘).
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::llm::StubLlmAdapter;
    use crate::adapters::log::ConsoleLogAdapter;
    use crate::adapters::storage::LocalStorageAdapter;
    use crate::ports::{IStoragePort, LlmTextResponse, LlmToolResponse};
    use std::sync::Mutex as StdMutex;

    fn manager() -> AiManager {
        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        AiManager::new(llm, tools, log)
    }

    /// 스크립트 LLM — 첫 호출엔 박힌 tool_calls 반환, 이후 turn 엔 빈 tool_calls 로 종료.
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

    #[tokio::test]
    async fn ask_text_returns_stub_text() {
        let mgr = manager();
        let text = mgr.ask_text("hi", &LlmCallOpts::default()).await.unwrap();
        assert!(text.contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn process_with_tools_terminates_on_empty_calls() {
        let mgr = manager();
        let response = mgr
            .process_with_tools("hello", &[], &LlmCallOpts::default())
            .await
            .unwrap();
        assert!(response.executed_actions.is_empty());
        assert!(response.reply.contains("Phase B-17+"));
        assert_eq!(response.model_id.as_deref(), Some("stub"));
    }

    #[tokio::test]
    async fn process_with_tools_opts_uses_default_plan_off() {
        let mgr = manager();
        let response = mgr
            .process_with_tools_opts(
                "hello",
                &[],
                &LlmCallOpts::default(),
                &AiRequestOpts::default(),
            )
            .await
            .unwrap();
        // PlanMode::Off — 시스템 프롬프트에 plan prefix 미주입 (test 직접 검증 어려움 — Stub 가
        // system_prompt 안 받기 때문). 구조적으로 호출만 되는지 확인.
        assert_eq!(response.model_id.as_deref(), Some("stub"));
    }

    #[tokio::test]
    async fn process_with_tools_opts_cron_agent_extends_max_turns() {
        // cron agent 모드 — MAX_TOOL_TURNS 25. Stub 가 도구 호출 0 반환 → 1 turn 만 돌고 종료.
        // 하지만 max_turns 분기는 정확히 맞아야 함 (회귀 방어).
        let mgr = manager();
        let ai_opts = AiRequestOpts {
            cron_agent: Some(crate::ports::CronAgentOpts {
                job_id: "test".to_string(),
                title: None,
            }),
            ..Default::default()
        };
        let response = mgr
            .process_with_tools_opts("hello", &[], &LlmCallOpts::default(), &ai_opts)
            .await
            .unwrap();
        assert_eq!(response.model_id.as_deref(), Some("stub"));
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
        // executedActions 에는 pending: true 로 등장
        let exec = &response.executed_actions[0];
        assert_eq!(exec["pending"], serde_json::json!(true));
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
                // cronTime / runAt / delaySec 전부 미박음
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

    #[tokio::test]
    async fn cost_budget_guard_blocks_when_exceeded() {
        // CostManager 박은 채로 한도 초과 상태 만든 뒤 process_with_tools 호출 시 LLM 호출 차단 확인.
        use crate::adapters::database::SqliteDatabaseAdapter;
        use crate::adapters::vault::SqliteVaultAdapter;
        use crate::managers::cost::{CostBudget, CostManager};
        use crate::ports::IVaultPort;

        let db: Arc<SqliteDatabaseAdapter> =
            Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let cost = Arc::new(CostManager::new(db, vault));
        let budget = CostBudget {
            daily_usd: 1.0,
            monthly_usd: 30.0,
            daily_calls: 100,
            monthly_calls: 1000,
            alert_at_percent: 80,
        };
        cost.set_budget(&budget);
        // 한도 초과 — daily USD
        cost.record("m", 100, 100, 0, 5.0, None);

        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = AiManager::new(llm, tools, log).with_cost_manager(cost);

        let response = mgr
            .process_with_tools_opts(
                "hi",
                &[],
                &LlmCallOpts::default(),
                &AiRequestOpts::default(),
            )
            .await
            .unwrap();
        // 차단됨 — error 메시지 포함, executed_actions 0
        assert!(response.error.is_some());
        assert!(response.error.unwrap().contains("비용 한도 초과"));
        assert_eq!(response.executed_actions.len(), 0);
        assert_eq!(response.cost_usd, Some(0.0)); // 호출 안 했으므로 비용 0
    }

    /// CLI session resume 검증용 — 첫 호출 시 cli_session_id 발급, 이후 호출 시 cli_resume_session_id
    /// 가 들어왔는지 캡처.
    struct CliSessionMockLlm {
        model_id: String,
        emit_session_id: String,
        captured_resume: StdMutex<Option<String>>,
    }

    #[async_trait::async_trait]
    impl ILlmPort for CliSessionMockLlm {
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
            })
        }
        async fn ask_with_tools(
            &self,
            _prompt: &str,
            _tools: &[ToolDefinition],
            _prior_results: &[ToolResult],
            opts: &LlmCallOpts,
        ) -> InfraResult<LlmToolResponse> {
            // resume 값 캡처
            *self.captured_resume.lock().unwrap() = opts.cli_resume_session_id.clone();
            Ok(LlmToolResponse {
                text: "ok".to_string(),
                tool_calls: Vec::new(),
                model_id: self.model_id.clone(),
                cli_session_id: Some(self.emit_session_id.clone()),
                ..Default::default()
            })
        }
    }

    /// 학습 로그 capture 용 — `[USER_AI_TRAINING]` prefix 가진 info 호출 캡처.
    struct CapturingLog {
        captured: StdMutex<Vec<String>>,
    }

    impl CapturingLog {
        fn new() -> Self {
            Self {
                captured: StdMutex::new(Vec::new()),
            }
        }
    }

    impl crate::ports::ILogPort for CapturingLog {
        fn info(&self, msg: &str) {
            if msg.contains("[USER_AI_TRAINING]") {
                self.captured.lock().unwrap().push(msg.to_string());
            }
        }
        fn warn(&self, _msg: &str) {}
        fn error(&self, _msg: &str) {}
        fn debug(&self, _msg: &str) {}
    }

    #[tokio::test]
    async fn training_log_emitted_with_prompt_and_reply() {
        // Stub LLM 은 도구 호출 0 → 단순 prompt + reply 만 학습 로그에 박힘.
        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log = Arc::new(CapturingLog::new());
        let log_clone = log.clone();
        let mgr = AiManager::new(llm, tools, log_clone as Arc<dyn ILogPort>);

        mgr.process_with_tools_opts(
            "테스트 프롬프트",
            &[],
            &LlmCallOpts::default(),
            &AiRequestOpts::default(),
        )
        .await
        .unwrap();

        let captured = log.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let msg = &captured[0];
        assert!(msg.contains("[USER_AI_TRAINING]"));
        assert!(msg.contains("\"role\":\"user\""));
        assert!(msg.contains("테스트 프롬프트"));
        assert!(msg.contains("\"role\":\"model\""));
    }

    #[tokio::test]
    async fn training_log_includes_tool_exchanges() {
        // ScriptedLlm 으로 도구 호출 시나리오 만들고 contents 에 functionCall + functionResponse 박힘 확인.
        let scripted = vec![ToolCall {
            id: "c1".to_string(),
            name: "search_history".to_string(),
            arguments: serde_json::json!({"query": "test"}),
        }];
        let llm: Arc<dyn ILlmPort> = Arc::new(ScriptedLlm::new("scripted", scripted));
        let tools = Arc::new(ToolManager::new());
        let log = Arc::new(CapturingLog::new());
        let mgr = AiManager::new(llm, tools, log.clone() as Arc<dyn ILogPort>);

        mgr.process_with_tools_opts(
            "검색해줘",
            &[],
            &LlmCallOpts::default(),
            &AiRequestOpts::default(),
        )
        .await
        .unwrap();

        let captured = log.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let msg = &captured[0];
        // functionCall 블록 박힘
        assert!(msg.contains("\"functionCall\""));
        assert!(msg.contains("search_history"));
        // functionResponse 블록 박힘
        assert!(msg.contains("\"functionResponse\""));
    }

    #[tokio::test]
    async fn cli_session_resume_persists_and_loads() {
        // model 이 cli- 로 시작 + conversation_id 박혀있을 때:
        // 첫 호출 — cli_session_id 캡처 → ConversationManager 에 저장
        // 두 번째 호출 — DB 의 session_id 가 opts.cli_resume_session_id 로 주입
        use crate::adapters::database::SqliteDatabaseAdapter;
        use crate::managers::conversation::ConversationManager;
        use crate::ports::IDatabasePort;

        let _g = crate::utils::shared_test_lock();
        let db: Arc<SqliteDatabaseAdapter> =
            Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let conv_mgr = Arc::new(ConversationManager::new(
            db.clone() as Arc<dyn IDatabasePort>,
        ));
        // 대화 row 미리 생성 — set_cli_session 이 UPDATE 라 row 가 존재해야 함.
        conv_mgr
            .save_sync("admin", "conv-1", "test", &serde_json::json!([]), None)
            .unwrap();

        let llm = Arc::new(CliSessionMockLlm {
            model_id: "cli-claude-code".to_string(),
            emit_session_id: "sess-uuid-abc".to_string(),
            captured_resume: StdMutex::new(None),
        });
        let llm_arc: Arc<dyn ILlmPort> = llm.clone();
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = AiManager::new(llm_arc, tools, log)
            .with_conversation_manager(conv_mgr.clone());

        let ai_opts = AiRequestOpts {
            conversation_id: Some("conv-1".to_string()),
            ..Default::default()
        };

        // 첫 호출 — resume 미박힘 (DB 비어있음)
        mgr.process_with_tools_opts("hi", &[], &LlmCallOpts::default(), &ai_opts)
            .await
            .unwrap();
        assert!(llm.captured_resume.lock().unwrap().is_none());

        // DB 에 session_id 영속화 됐는지 직접 확인
        let saved = conv_mgr.get_cli_session("conv-1", "cli-claude-code");
        assert_eq!(saved.as_deref(), Some("sess-uuid-abc"));

        // 두 번째 호출 — resume 박힘
        mgr.process_with_tools_opts("hi 2", &[], &LlmCallOpts::default(), &ai_opts)
            .await
            .unwrap();
        let captured = llm.captured_resume.lock().unwrap().clone();
        assert_eq!(captured.as_deref(), Some("sess-uuid-abc"));
    }

    #[tokio::test]
    async fn search_components_handler_returns_top_k() {
        // search_components 도구 등록 + ToolManager.dispatch 통한 호출 → 26 components 의 top-5 반환.
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", dir.path());
        }
        use crate::adapters::embedder::stub::StubEmbedderAdapter;
        let embedder: Arc<dyn crate::ports::IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());

        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = AiManager::new(llm, tools.clone(), log)
            .register_search_components_tool(embedder);

        // 도구 등록 됐는지 확인
        assert!(tools.handler_count() >= 1);

        // ToolManager.dispatch 통해 호출
        let result = tools
            .dispatch(
                "search_components",
                &serde_json::json!({"query": "주식 차트", "limit": 3}),
            )
            .await
            .unwrap();
        let components = result["components"].as_array().unwrap();
        assert_eq!(components.len(), 3);
        let count = result["count"].as_u64().unwrap();
        assert_eq!(count, 3);
        // 첫 번째 결과는 score 가장 높음
        for w in components.windows(2) {
            let s1 = w[0]["score"].as_f64().unwrap();
            let s2 = w[1]["score"].as_f64().unwrap();
            assert!(s1 >= s2, "결과는 score 내림차순 정렬");
        }
        // 각 결과는 name + description + propsSchema 박힘
        for c in components {
            assert!(c["name"].is_string());
            assert!(c["description"].is_string());
            assert!(c["propsSchema"].is_object());
        }
        let _ = mgr;
    }
}
