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

use std::sync::Arc;

use crate::managers::ai::prompt_builder::PromptBuilder;
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
        }
    }

    /// PromptBuilder 박은 채로 부팅 — 시스템 프롬프트 자동 주입 활성.
    pub fn with_prompt_builder(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.prompt_builder = Some(PromptBuilder::new(vault));
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
        let mut effective_opts = opts.clone();
        if effective_opts.system_prompt.is_none() {
            if let Some(pb) = &self.prompt_builder {
                effective_opts.system_prompt = Some(pb.build(None));
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

        Ok(AiResponse {
            reply: last_text,
            blocks: Vec::new(),
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
