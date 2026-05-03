//! Codex CLI — `codex exec` 자식 프로세스 (옛 TS cli-codex.ts).
//!
//! Phase B-17 minimum: `codex exec` non-interactive 모드 + prompt stdin + stdout 캡처.
//! thread_id resume + mcp_servers config.toml + item.completed 이벤트 파싱은 Phase B-17.5 후속.

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

pub struct CodexCliHandler;

impl CodexCliHandler {
    pub fn new() -> Self {
        Self
    }

    async fn run_cli(binary: &str, prompt: &str, _opts: &LlmCallOpts) -> InfraResult<String> {
        let mut child = Command::new(binary)
            .arg("exec")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "Codex CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `codex login` 한 번 실행했는지 확인",
                    binary, binary
                )
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("Codex CLI stdin write 실패: {e}"))?;
            drop(stdin);
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("Codex CLI wait 실패: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Codex CLI 종료 코드 {:?}: {}",
                output.status.code(),
                stderr.trim()
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[async_trait::async_trait]
impl FormatHandler for CodexCliHandler {
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
            cost_usd: Some(0.0), // 구독 모드
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
        Err("Codex CLI ask_with_tools — Phase B-17.5 mcp_servers + thread.* 이벤트 박힌 후 활성"
            .to_string())
    }
}
