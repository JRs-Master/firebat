//! StubLlmAdapter — ILlmPort 의 Phase B-16 minimum 구현체.
//!
//! 실 LLM 호출 안 함. AiManager 의 도구 dispatch 흐름이 작동하도록 echo + 표준 응답 반환.
//!
//! Phase B-17+ 후속:
//! - ConfigDrivenAdapter — JSON config + 포맷 핸들러 5+3 분기 (옛 TS infra/llm/config-adapter.ts).
//! - 5 API: openai-responses / anthropic-messages / gemini-native / vertex-gemini / openai-chat
//! - 3 CLI: cli-claude-code / cli-codex / cli-gemini (subprocess + stream-json + resume)
//! - thinking level / extended thinking / MCP connector / hosted tools / web search 등 features

use firebat_core::ports::{
    ILlmPort, InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition,
    ToolResult,
};

pub struct StubLlmAdapter {
    model_id: String,
}

impl StubLlmAdapter {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
        }
    }
}

#[async_trait::async_trait]
impl ILlmPort for StubLlmAdapter {
    fn get_model_id(&self) -> String {
        self.model_id.clone()
    }

    async fn ask_text(&self, prompt: &str, _opts: &LlmCallOpts) -> InfraResult<LlmTextResponse> {
        // Phase B-17+ 에서 실 LLM 호출. 현재는 prompt 의 첫 200자 echo + Phase 표기.
        let preview: String = prompt.chars().take(200).collect();
        Ok(LlmTextResponse {
            text: format!("[StubLlm — Phase B-17+ 미박음] prompt preview: {preview}"),
            model_id: self.model_id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(prompt.len() as i64),
            tokens_out: Some(0),
        })
    }

    async fn ask_with_tools(
        &self,
        prompt: &str,
        _tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // Phase B-17+ 에서 실 LLM 호출 후 tool_calls 분리. 현재는 빈 도구 호출 + 안내 텍스트 반환.
        let preview: String = prompt.chars().take(200).collect();
        Ok(LlmToolResponse {
            text: format!("[StubLlm — Phase B-17+ 미박음] prompt preview: {preview}"),
            tool_calls: Vec::new(),
            model_id: self.model_id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(prompt.len() as i64),
            tokens_out: Some(0),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_ask_text_returns_phase_note() {
        let llm = StubLlmAdapter::new("stub-model");
        let response = llm
            .ask_text("hello", &LlmCallOpts::default())
            .await
            .unwrap();
        assert_eq!(response.model_id, "stub-model");
        assert!(response.text.contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn stub_ask_with_tools_returns_no_calls() {
        let llm = StubLlmAdapter::new("stub-model");
        let response = llm
            .ask_with_tools("hi", &[], &[], &LlmCallOpts::default())
            .await
            .unwrap();
        assert!(response.tool_calls.is_empty());
        assert!(response.text.contains("Phase B-17+"));
    }
}
