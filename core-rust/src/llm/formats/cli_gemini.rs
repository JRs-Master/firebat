//! Gemini CLI — `gemini -p` 자식 프로세스 (옛 TS cli-gemini.ts).
//!
//! Phase B-17 minimum: `gemini -p <prompt>` 형태 — Gemini CLI 가 prompt 를 첫 인자로 받음.
//! @path 첨부 / settings.json MCP / session_id resume 같은 advanced 는 Phase B-17.5.

use tokio::process::Command;

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

pub struct GeminiCliHandler;

impl GeminiCliHandler {
    pub fn new() -> Self {
        Self
    }

    async fn run_cli(binary: &str, prompt: &str, _opts: &LlmCallOpts) -> InfraResult<String> {
        let output = Command::new(binary)
            .arg("-p")
            .arg(prompt)
            .output()
            .await
            .map_err(|e| {
                format!(
                    "Gemini CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `gemini auth login` 한 번 실행했는지 확인",
                    binary, binary
                )
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Gemini CLI 종료 코드 {:?}: {}",
                output.status.code(),
                stderr.trim()
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[async_trait::async_trait]
impl FormatHandler for GeminiCliHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        _api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let text = Self::run_cli(&config.endpoint, prompt, opts).await?;
        Ok(LlmTextResponse {
            text,
            model_id: config.id.clone(),
            cost_usd: Some(0.0),
            tokens_in: None,
            tokens_out: None,
        })
    }

    async fn ask_with_tools(
        &self,
        _config: &LlmModelConfig,
        _api_key: Option<&str>,
        _prompt: &str,
        _tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        Err("Gemini CLI ask_with_tools — Phase B-17.5 settings.json MCP + tool_use 이벤트 박힌 후 활성"
            .to_string())
    }
}
