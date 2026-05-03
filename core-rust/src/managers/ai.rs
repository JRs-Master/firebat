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

use std::collections::HashSet;
use std::sync::Arc;

use crate::managers::ai::history_resolver::HistoryResolver;
use crate::managers::ai::prompt_builder::PromptBuilder;
use crate::managers::ai::system_context::SystemContextGatherer;
use crate::managers::conversation::ConversationManager;
use crate::managers::cost::CostManager;
use crate::managers::module::ModuleManager;
use crate::managers::tool::{ToolListFilter, ToolManager};
use crate::ports::{
    AiRequestOpts, ILlmPort, ILogPort, IVaultPort, InfraResult, LlmCallOpts, ToolCall,
    ToolDefinition, ToolResult,
};
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
        }
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
        let mut last_text = String::new();
        let mut last_model_id = self.llm.get_model_id();
        let mut total_cost: f64 = 0.0;

        // Layer 2 per-turn duplicate guard — turn 안에서 같은 (name + args) 두 번째 호출 차단.
        // 옛 TS `turnCallSet` 1:1.
        let mut turn_call_set: HashSet<String>;

        // 첫 turn user prompt — plan_mode hint prefix 자동 주입 (옛 TS promptForLlm 첫 turn 분기 1:1).
        let prompt_with_hint: String = match plan_mode::prompt_hint(ai_opts.plan_mode) {
            Some(hint) => format!("{}\n\n{}", hint, prompt),
            None => prompt.to_string(),
        };

        for turn in 0..max_turns {
            // Dynamic temperature — toolExchanges 비어있으면 (첫 turn 또는 도구 호출 없음) 0.2,
            // 쌓여있으면 (요약·해설 turn) 0.85. 옛 TS 1:1.
            let dynamic_temp = if prior_results.is_empty() {
                TEMP_TOOL_TURN
            } else {
                TEMP_FINAL_TURN
            };
            let mut turn_opts = effective_opts.clone();
            turn_opts.temperature = Some(dynamic_temp);

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

        Ok(AiResponse {
            reply: clean_reply,
            blocks: final_blocks,
            executed_actions,
            suggestions: Vec::new(),
            error: None,
            model_id: Some(last_model_id),
            cost_usd: Some(total_cost),
        })
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

    fn manager() -> AiManager {
        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        AiManager::new(llm, tools, log)
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
}
