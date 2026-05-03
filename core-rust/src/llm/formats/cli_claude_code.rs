//! Claude Code CLI — `claude` 자식 프로세스 (옛 TS cli-claude-code.ts).
//!
//! Phase B-17 minimum: cold spawn + stdin prompt + stdout 파싱 (단순 텍스트 응답).
//! stream-json + tool_use / tool_result 파싱 + --resume session_id 영속 + MCP --mcp-config
//! 같은 advanced features 는 Phase B-17.5 후속.
//!
//! 실 동작 조건: `claude` binary PATH 박혀있어야 함 (구독 OAuth 로그인 완료 상태).
//! `claude auth login` 한 번 실행 후 사용 가능.

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

pub struct ClaudeCodeCliHandler;

impl ClaudeCodeCliHandler {
    pub fn new() -> Self {
        Self
    }

    /// CLI subprocess 실행 — prompt stdin 으로 전달, stdout 캡처.
    async fn run_cli(binary: &str, prompt: &str, _opts: &LlmCallOpts) -> InfraResult<String> {
        let mut child = Command::new(binary)
            .arg("--print") // non-interactive 모드 (옛 TS 패턴)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "Claude Code CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `claude auth login` 한 번 실행했는지 확인",
                    binary, binary
                )
            })?;

        // stdin 으로 prompt 전달 + close
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("Claude Code CLI stdin write 실패: {e}"))?;
            drop(stdin);
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("Claude Code CLI wait 실패: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Claude Code CLI 종료 코드 {:?}: {}",
                output.status.code(),
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    }
}

#[async_trait::async_trait]
impl FormatHandler for ClaudeCodeCliHandler {
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
            cost_usd: Some(0.0), // CLI 구독 모드 — 호출 단위 비용 0 (월정액)
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
        // Phase B-17.5 — stream-json input + --mcp-config + tool_use / tool_result content blocks
        // 박힌 후 활성. 현재 minimum 은 ask_text 만.
        Err("Claude Code CLI ask_with_tools — Phase B-17.5 stream-json + MCP 박힌 후 활성".to_string())
    }
}
