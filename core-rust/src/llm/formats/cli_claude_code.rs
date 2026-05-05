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
use crate::llm::formats::cli_image_helper::extract_image_base64;
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

pub struct ClaudeCodeCliHandler;

impl ClaudeCodeCliHandler {
    pub fn new() -> Self {
        Self
    }

    /// CLI subprocess 실행 — prompt stdin 으로 전달, stdout 캡처.
    ///
    /// 이미지 첨부 시 stream-json input 모드 사용 (옛 TS cli-claude-code.ts:259-272 1:1):
    /// - Claude Code 는 `--image` 플래그 없음
    /// - Read 도구가 disallowedTools 에 박혀 `@<path>` 참조 불가 → stream-json input 이 유일한 vision 경로
    /// - stdin 에 `{type:'user', message:{role:'user', content:[{type:'text', text}, {type:'image', source:{type:'base64', media_type, data}}]}}` JSON 박음
    async fn run_cli(binary: &str, prompt: &str, opts: &LlmCallOpts) -> InfraResult<String> {
        let image_data = extract_image_base64(opts.image.as_deref(), opts.image_mime_type.as_deref());

        let mut cmd = Command::new(binary);
        if image_data.is_some() {
            // stream-json input 모드 — 옛 TS 1:1
            cmd.arg("-p")
                .arg("--input-format")
                .arg("stream-json")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose");
        } else {
            // 일반 모드 — `--print` non-interactive
            cmd.arg("--print");
        }

        let mut child = cmd
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

        // stdin 으로 prompt 또는 stream-json user message 전달
        if let Some(mut stdin) = child.stdin.take() {
            let payload = if let Some((data, media_type)) = &image_data {
                // stream-json user message — 옛 TS cli-claude-code.ts 1:1
                let msg = serde_json::json!({
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
                        ]
                    }
                });
                serde_json::to_string(&msg).unwrap_or_default()
            } else {
                prompt.to_string()
            };
            stdin
                .write_all(payload.as_bytes())
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
