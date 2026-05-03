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

use std::sync::Arc;

use crate::managers::ai::history_resolver::HistoryResolver;
use crate::managers::ai::prompt_builder::PromptBuilder;
use crate::managers::ai::system_context::SystemContextGatherer;
use crate::managers::conversation::ConversationManager;
use crate::managers::cost::CostManager;
use crate::managers::module::ModuleManager;
use crate::managers::tool::{ToolListFilter, ToolManager};
use crate::ports::{
    ILlmPort, ILogPort, IVaultPort, InfraResult, LlmCallOpts, ToolCall, ToolDefinition, ToolResult,
};

const MAX_TOOL_TURNS: usize = 10;

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

    /// Function Calling 멀티턴 도구 루프.
    /// 시스템 프롬프트 자동 주입 (PromptBuilder 박힌 경우) + 도구 list 자동 build (tools 빈 배열이면).
    pub async fn process_with_tools(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        opts: &LlmCallOpts,
    ) -> InfraResult<AiResponse> {
        // 도구 list 미전달 시 ToolManager 등록 도구 자동 사용 (옛 TS buildToolDefinitions 동등).
        let auto_tools: Vec<ToolDefinition>;
        let effective_tools: &[ToolDefinition] = if tools.is_empty() {
            auto_tools = self.build_tool_definitions();
            &auto_tools
        } else {
            tools
        };

        // 시스템 프롬프트 자동 주입 (PromptBuilder 박힌 경우 + opts.system_prompt 미박힘 시).
        // SystemContextGatherer 박혀있으면 sysmod / mcp 동적 description 도 주입.
        // HistoryResolver 박혀있고 opts.conversation_id 박혀있으면 recent N 메시지 컨텍스트 prepend.
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
                    let owner = effective_opts.owner.as_deref().unwrap_or("admin");
                    if let Some(hist) =
                        hr.resolve(owner, effective_opts.conversation_id.as_deref())
                    {
                        extra_parts.push(hist);
                    }
                }
                let extra = if extra_parts.is_empty() {
                    None
                } else {
                    Some(extra_parts.join("\n\n"))
                };
                effective_opts.system_prompt = Some(pb.build(extra.as_deref()));
            }
        }

        let mut prior_results: Vec<ToolResult> = Vec::new();
        let mut executed_actions: Vec<serde_json::Value> = Vec::new();
        let mut last_text = String::new();
        let mut last_model_id = self.llm.get_model_id();
        let mut total_cost: f64 = 0.0;

        for turn in 0..MAX_TOOL_TURNS {
            let response = self
                .llm
                .ask_with_tools(prompt, effective_tools, &prior_results, &effective_opts)
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

            if response.tool_calls.is_empty() {
                self.log.info(&format!(
                    "[AiManager] turn {} 종료 — 도구 호출 0개",
                    turn + 1
                ));
                break;
            }

            for call in response.tool_calls {
                let action = self.dispatch_tool(&call).await;
                executed_actions.push(serde_json::json!({
                    "tool": call.name,
                    "callId": call.id,
                    "success": action.success,
                    "error": action.error,
                }));
                prior_results.push(action);
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

        Ok(AiResponse {
            reply: clean_reply,
            blocks: extracted_blocks,
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
}
