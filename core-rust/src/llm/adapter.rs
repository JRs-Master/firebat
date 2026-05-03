//! ConfigDrivenAdapter — ILlmPort 의 config + format 핸들러 분기 구현체.
//!
//! 옛 TS infra/llm/config-adapter.ts Rust port. 모델당 1개 config, format 별 핸들러 분기.
//! 새 모델 도입 시 config 1개 추가만으로 활성 — 어댑터 수정 0.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::llm::config::{builtin_models, LlmModelConfig};
use crate::llm::formats;
use crate::ports::{
    ILlmPort, IVaultPort, InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse,
    ToolDefinition, ToolResult,
};

/// FormatHandler — 옛 TS formats/*.ts 의 단일 trait. config + creds 받아 LLM 호출.
#[async_trait::async_trait]
pub trait FormatHandler: Send + Sync {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse>;

    async fn ask_with_tools(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse>;
}

pub struct ConfigDrivenAdapter {
    /// 모델 ID → config (carousel)
    models: HashMap<String, LlmModelConfig>,
    /// Vault — API 키 lazy 조회
    vault: Arc<dyn IVaultPort>,
    /// 현재 활성 모델 ID — Vault `system:llm:model` 또는 default
    current_model: Mutex<String>,
    /// format 핸들러 dispatch
    handlers: HashMap<String, Arc<dyn FormatHandler>>,
}

impl ConfigDrivenAdapter {
    pub fn new(vault: Arc<dyn IVaultPort>, default_model: String) -> Self {
        Self::with_configs_dir(vault, default_model, None)
    }

    /// configs_dir 박혀있으면 해당 디렉토리의 모든 *.json 로드 후 빌트인 carousel 위에 merge.
    /// 같은 ID 가 디렉토리에 박혀있으면 디렉토리 우선 (사용자 override).
    /// 새 모델 = JSON 파일 1개 추가만으로 활성 (옛 TS infra/llm/configs/*.json 동등).
    pub fn with_configs_dir(
        vault: Arc<dyn IVaultPort>,
        default_model: String,
        configs_dir: Option<&Path>,
    ) -> Self {
        let mut models: HashMap<String, LlmModelConfig> = builtin_models()
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();

        if let Some(dir) = configs_dir {
            for cfg in Self::load_configs_from_dir(dir) {
                models.insert(cfg.id.clone(), cfg);
            }
        }

        let mut handlers: HashMap<String, Arc<dyn FormatHandler>> = HashMap::new();
        handlers.insert(
            "anthropic-messages".to_string(),
            Arc::new(formats::anthropic::AnthropicMessagesHandler::new()),
        );
        handlers.insert(
            "openai-responses".to_string(),
            Arc::new(formats::openai_responses::OpenAiResponsesHandler::new()),
        );
        handlers.insert(
            "gemini-native".to_string(),
            Arc::new(formats::gemini_native::GeminiNativeHandler::new()),
        );
        handlers.insert(
            "vertex-gemini".to_string(),
            Arc::new(formats::vertex_gemini::VertexGeminiHandler::new()),
        );
        handlers.insert(
            "openai-chat".to_string(),
            Arc::new(formats::openai_chat::OpenAiChatHandler::new()),
        );
        handlers.insert(
            "cli-claude-code".to_string(),
            Arc::new(formats::cli_claude_code::ClaudeCodeCliHandler::new()),
        );
        handlers.insert(
            "cli-codex".to_string(),
            Arc::new(formats::cli_codex::CodexCliHandler::new()),
        );
        handlers.insert(
            "cli-gemini".to_string(),
            Arc::new(formats::cli_gemini::GeminiCliHandler::new()),
        );

        Self {
            models,
            vault,
            current_model: Mutex::new(default_model),
            handlers,
        }
    }

    /// 디렉토리 안 *.json 모두 LlmModelConfig 로 deserialize. 잘못된 파일은 silent skip.
    /// 옛 TS `infra/llm/configs/` 와 같은 디렉토리 구조 + schema.
    fn load_configs_from_dir(dir: &Path) -> Vec<LlmModelConfig> {
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return out,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if let Ok(cfg) = serde_json::from_str::<LlmModelConfig>(&raw) {
                out.push(cfg);
            }
        }
        out
    }

    /// 등록된 전체 모델 ID 목록 — 어드민 UI 의 모델 선택 드롭다운 용.
    pub fn list_model_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.models.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Vault `system:llm:model` 에서 현재 모델 ID 동적 lookup. 없으면 ctor default 사용.
    fn resolve_current_model(&self) -> String {
        if let Some(stored) = self.vault.get_secret("system:llm:model") {
            if !stored.is_empty() {
                return stored;
            }
        }
        self.current_model.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn config_for(&self, model_id: &str) -> Option<&LlmModelConfig> {
        self.models.get(model_id)
    }

    fn handler_for(&self, format: &str) -> Option<Arc<dyn FormatHandler>> {
        self.handlers.get(format).cloned()
    }

    fn fetch_api_key(&self, config: &LlmModelConfig) -> Option<String> {
        config
            .api_key_vault_key
            .as_ref()
            .and_then(|k| self.vault.get_secret(k))
            .filter(|v| !v.is_empty())
    }

    /// 옵션의 모델 override 또는 활성 모델 사용.
    fn select_config(&self, opts: &LlmCallOpts) -> InfraResult<LlmModelConfig> {
        let model_id = opts
            .model
            .as_deref()
            .unwrap_or_else(|| {
                // Vault override → ctor default
                Box::leak(self.resolve_current_model().into_boxed_str()) as &str
            })
            .to_string();
        self.config_for(&model_id)
            .cloned()
            .ok_or_else(|| format!("LLM 모델 미등록: {model_id}"))
    }
}

#[async_trait::async_trait]
impl ILlmPort for ConfigDrivenAdapter {
    fn get_model_id(&self) -> String {
        self.resolve_current_model()
    }

    async fn ask_text(
        &self,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let config = self.select_config(opts)?;
        let handler = self
            .handler_for(&config.format)
            .ok_or_else(|| format!("LLM format 핸들러 미박음: {}", config.format))?;
        let api_key = self.fetch_api_key(&config);
        handler
            .ask_text(&config, api_key.as_deref(), prompt, opts)
            .await
    }

    async fn ask_with_tools(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        let config = self.select_config(opts)?;
        let handler = self
            .handler_for(&config.format)
            .ok_or_else(|| format!("LLM format 핸들러 미박음: {}", config.format))?;
        let api_key = self.fetch_api_key(&config);
        handler
            .ask_with_tools(&config, api_key.as_deref(), prompt, tools, prior_results, opts)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let v: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        (v, dir)
    }

    #[tokio::test]
    async fn unknown_model_returns_error() {
        let (vault, _dir) = vault();
        let adapter = ConfigDrivenAdapter::new(vault, "nonexistent".to_string());
        let result = adapter.ask_text("hi", &LlmCallOpts::default()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn anthropic_without_api_key_returns_error() {
        let (vault, _dir) = vault();
        let adapter = ConfigDrivenAdapter::new(vault, "claude-4-sonnet".to_string());
        let result = adapter.ask_text("hi", &LlmCallOpts::default()).await;
        // API 키 없으니 핸들러가 명시 에러 반환 (실 LLM 호출 안 함)
        assert!(result.is_err());
        assert!(result.unwrap_err().to_lowercase().contains("api"));
    }

    #[tokio::test]
    async fn vault_override_model_id() {
        let (vault, _dir) = vault();
        vault.set_secret("system:llm:model", "gpt-5");
        let adapter = ConfigDrivenAdapter::new(vault, "claude-4-sonnet".to_string());
        // Vault override 우선
        assert_eq!(adapter.get_model_id(), "gpt-5");
    }
}
