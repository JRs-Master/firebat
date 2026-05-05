//! Gemini CLI — `gemini -p` 자식 프로세스 (옛 TS cli-gemini.ts).
//!
//! Phase B-17 minimum: `gemini -p <prompt>` 형태 — Gemini CLI 가 prompt 를 첫 인자로 받음.
//! @path 첨부 / settings.json MCP / session_id resume 같은 advanced 는 Phase B-17.5.

use tokio::process::Command;

use crate::llm::adapter::FormatHandler;
use firebat_core::llm::config::LlmModelConfig;
use crate::llm::formats::cli_image_helper::{cleanup_temp_file, write_image_temp_file};
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

/// Gemini CLI workspace 환경변수 — workspace dir override (옛 TS `geminiWorkspace`).
/// 미지정 시 `/tmp/firebat-gemini-workspace` 기본값. 첨부 이미지 임시 파일 저장 위치 (workspace 외
/// 경로는 `@-syntax` 차단됨).
const GEMINI_WORKSPACE_ENV: &str = "FIREBAT_GEMINI_WORKSPACE";
const GEMINI_WORKSPACE_DEFAULT: &str = "/tmp/firebat-gemini-workspace";

pub struct GeminiCliHandler;

impl GeminiCliHandler {
    pub fn new() -> Self {
        Self
    }

    fn gemini_workspace() -> String {
        std::env::var(GEMINI_WORKSPACE_ENV)
            .unwrap_or_else(|_| GEMINI_WORKSPACE_DEFAULT.to_string())
    }

    async fn run_cli(binary: &str, prompt: &str, opts: &LlmCallOpts) -> InfraResult<String> {
        // 첨부 이미지 — 옛 TS cli-gemini.ts:247-253 1:1.
        // **중요**: Gemini CLI 는 workspace (cwd) 외 경로 차단 ("Path not in workspace") →
        // 임시 파일을 workspace 안에 저장해야 `@-syntax` 작동.
        let workspace = Self::gemini_workspace();
        // workspace 디렉토리 보장 — 첨부 이미지 안 박혀도 cwd 로 사용
        let _ = std::fs::create_dir_all(&workspace);
        let tmp_image = write_image_temp_file(
            opts.image.as_deref(),
            opts.image_mime_type.as_deref(),
            Some(&workspace),
        );
        // `@<path>\n\n<prompt>` 형태로 prompt 앞에 박음 (옛 TS 1:1)
        let final_prompt = match &tmp_image {
            Some(t) => format!("@{}\n\n{}", t.path, prompt),
            None => prompt.to_string(),
        };

        let output = Command::new(binary)
            .arg("-p")
            .arg(&final_prompt)
            .current_dir(&workspace) // workspace 안에서 spawn → @-syntax 작동
            .output()
            .await
            .map_err(|e| {
                cleanup_temp_file(tmp_image.as_ref().map(|t| t.path.as_str()));
                format!(
                    "Gemini CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `gemini auth login` 한 번 실행했는지 확인",
                    binary, binary
                )
            })?;

        // 첨부 이미지 임시 파일 정리 — 옛 TS child.on('close', ...) 1:1
        cleanup_temp_file(tmp_image.as_ref().map(|t| t.path.as_str()));

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
