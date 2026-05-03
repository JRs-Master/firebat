//! Vertex AI Gemini — GCP Service Account 기반 (옛 TS vertex-gemini.ts).
//!
//! Endpoint: https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
//! Auth: Service Account JSON → JWT → access_token (1h cache).
//!
//! Phase B-17 minimum: Service Account JWT signing 미박음 — 사용자가 미리 발급한 access_token 을
//! Vault `system:vertex:access-token` 에 저장. JWT 자동 발급은 Phase B-17.5 (jsonwebtoken crate).

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};

pub struct VertexGeminiHandler;

impl VertexGeminiHandler {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl FormatHandler for VertexGeminiHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        _prompt: &str,
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        // Service Account JWT 자동 발급은 Phase B-17.5 — 현재는 access_token 직접 사용 가정.
        // api_key 가 access_token 으로 박혀있다고 가정.
        match api_key {
            Some(k) if !k.is_empty() => {
                Err(format!(
                    "Vertex Gemini access_token 직접 발급 — Phase B-17.5 jsonwebtoken JWT signing 박힌 후 활성. 임시: Vault `system:vertex:access-token` 에 미리 발급한 token 박으세요. (받은 key prefix: {})",
                    &k[..k.len().min(8)]
                ))
            }
            _ => Err(format!(
                "Vertex 인증 미설정 — Vault `{}` 박으세요 (Service Account JSON). Phase B-17.5 JWT 자동 발급 박힌 후 자동 작동.",
                config.api_key_vault_key.as_deref().unwrap_or("(미정의)")
            )),
        }
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
        Err("Vertex Gemini Phase B-17.5 — JWT 자동 발급 박힌 후 활성".to_string())
    }
}
