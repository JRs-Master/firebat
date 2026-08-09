//! ConfigDrivenAdapter — ILlmPort 의 config + format 핸들러 분기 구현체.
//!
//! 옛 TS infra/llm/config-adapter.ts Rust port. 모델당 1개 config, format 별 핸들러 분기.
//! 새 모델 도입 시 config 1개 추가만으로 활성 — 어댑터 수정 0.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use firebat_core::llm::config::{builtin_models, LlmModelConfig};
use crate::llm::formats;
use firebat_core::ports::{
    ILlmPort, IVaultPort, InfraResult, LlmCallOpts, LlmStreamSink, LlmTextResponse, LlmToolResponse,
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

    /// 스트리밍 변형 — 기본 = ask_with_tools 위임 (sink 무시). CLI 핸들러만 override.
    async fn ask_with_tools_streaming(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
        emit: Option<LlmStreamSink>,
    ) -> InfraResult<LlmToolResponse> {
        let _ = emit;
        self.ask_with_tools(config, api_key, prompt, tools, prior_results, opts).await
    }
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

    /// configs_dir 설정되어 있으면 해당 디렉토리의 모든 *.json 로드 후 빌트인 carousel 위에 merge.
    /// 같은 ID 가 디렉토리에 설정되어 있으면 디렉토리 우선 (사용자 override).
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
        // openai-chat — OpenAI 호환 서드파티(Upstage Solar / DeepSeek / Groq / 로컬 vLLM, chat/completions).
        handlers.insert(
            "openai-chat".to_string(),
            Arc::new(formats::openai_chat::OpenAiChatHandler::new()),
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
            .ok_or_else(|| firebat_core::i18n::t("core.error.llm.model_not_registered", None, &[("model", &model_id)]))
    }
}

#[async_trait::async_trait]
impl ILlmPort for ConfigDrivenAdapter {
    fn get_model_id(&self) -> String {
        self.resolve_current_model()
    }

    /// opts.model 또는 current default 모델의 config.features.mcp_connector 반환.
    fn supports_hosted_mcp(&self, opts: &LlmCallOpts) -> bool {
        self.select_config(opts)
            .map(|c| c.features.mcp_connector)
            .unwrap_or(false)
    }

    /// The declaration (`features.imageInput`) AND the format actually carrying the image. CLI
    /// formats always carry one; among the API formats only those listed here build image parts.
    /// A model whose declaration says yes but whose adapter drops the bytes must answer NO here,
    /// or the honest "I cannot see it" notice never fires and the user is answered blind.
    fn supports_image(&self, opts: &LlmCallOpts) -> bool {
        let Ok(c) = self.select_config(opts) else { return false };
        if c.format.starts_with("cli-") {
            return true;
        }
        c.features.image_input
            && matches!(
                c.format.as_str(),
                "gemini-native" | "vertex-gemini" | "openai-chat" | "anthropic-messages"
            )
    }

    /// The API formats that build a real multi-turn request. CLI formats keep the prose blob:
    /// they resume their own session, so structured turns would be a second copy of what the
    /// session already holds.
    fn wants_structured_history(&self, opts: &LlmCallOpts) -> bool {
        self.select_config(opts)
            .map(|c| {
                matches!(
                    c.format.as_str(),
                    "gemini-native" | "vertex-gemini" | "openai-chat" | "anthropic-messages"
                )
            })
            .unwrap_or(false)
    }

    async fn ask_text(
        &self,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let config = self.select_config(opts)?;
        let handler = self
            .handler_for(&config.format)
            .ok_or_else(|| firebat_core::i18n::t("core.error.llm.handler_missing", None, &[("format", &config.format)]))?;
        let api_key = self.fetch_api_key(&config);
        let enriched_opts = self.enrich_opts_for_format(&config, opts);
        handler
            .ask_text(&config, api_key.as_deref(), prompt, &enriched_opts)
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
            .ok_or_else(|| firebat_core::i18n::t("core.error.llm.handler_missing", None, &[("format", &config.format)]))?;
        let api_key = self.fetch_api_key(&config);
        let enriched_opts = self.enrich_opts_for_format(&config, opts);
        handler
            .ask_with_tools(&config, api_key.as_deref(), prompt, tools, prior_results, &enriched_opts)
            .await
    }

    async fn ask_with_tools_streaming(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
        emit: Option<LlmStreamSink>,
    ) -> InfraResult<LlmToolResponse> {
        let config = self.select_config(opts)?;
        let handler = self
            .handler_for(&config.format)
            .ok_or_else(|| firebat_core::i18n::t("core.error.llm.handler_missing", None, &[("format", &config.format)]))?;
        let api_key = self.fetch_api_key(&config);
        let enriched_opts = self.enrich_opts_for_format(&config, opts);
        handler
            .ask_with_tools_streaming(&config, api_key.as_deref(), prompt, tools, prior_results, &enriched_opts, emit)
            .await
    }
}

impl ConfigDrivenAdapter {
    /// format 별 옵션 enrichment — 호출자 (AiManager) 가 직접 Vault 조회 안 해도 어댑터가 자동 채움.
    /// 옛 TS `FormatHandlerContext.resolveXxx()` 패턴 1:1 — ctx 없이 어댑터 안에서 처리.
    fn enrich_opts_for_format(&self, config: &LlmModelConfig, opts: &LlmCallOpts) -> LlmCallOpts {
        let mut enriched = opts.clone();
        // Anthropic prompt cache 토글 — system block + 마지막 tool 에 cache_control 마커 자동 추가.
        // 모델이 prompt_cache feature 활성된 anthropic-messages 일 때만 Vault 조회.
        if config.format == "anthropic-messages"
            && config.features.prompt_cache
            && enriched.anthropic_cache_enabled.is_none()
        {
            let cache_enabled = self
                .vault
                .get_secret(firebat_core::vault_keys::VK_LLM_ANTHROPIC_CACHE)
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false);
            enriched.anthropic_cache_enabled = Some(cache_enabled);
        }
        // CLI 모델 유도 — 레지스트리 id(예: "cli-claude-code-sonnet-4-6")는 Firebat id 지 provider 모델 문자열이 아님.
        // opts.cli_model 은 요청에 안 실려(프론트 미전송) 항상 None → 3 CLI(claude/codex/gemini) 모두 --model 미전송
        // → 각 CLI 기본 모델로 돌아 "모델 선택이 무시되던" 버그. 여기서 id → 실제 모델 문자열 유도(한 곳에서 3 CLI fix).
        // "*-auto" 는 None 유지(CLI 기본 모델). claude 는 "claude-{}" 가 --model 값임이 실측 검증됨.
        if enriched.cli_model.is_none() && !config.id.ends_with("-auto") {
            let id = config.id.as_str();
            let derived = match config.format.as_str() {
                "cli-claude-code" => id.strip_prefix("cli-claude-code-").map(|r| format!("claude-{r}")),
                "cli-gemini" => id.strip_prefix("cli-gemini-").map(|r| format!("gemini-{r}")),
                "cli-codex" => id.strip_prefix("cli-codex-").map(|r| r.to_string()),
                _ => None,
            };
            if let Some(m) = derived {
                enriched.cli_model = Some(m);
            }
        }
        // Thinking 레벨을 **모델 선언 집합**으로 스냅 — 호출자가 박은 값(consolidation 의 "minimal" 등)이
        // 그 모델에 없으면 provider 가 400 으로 거부한다. 포맷 핸들러마다 모델별 매핑을 박는 대신
        // 선언(models.json)이 유일한 진실이 되게 여기서 한 번 막는다.
        if let Some(req) = enriched.thinking_level.as_deref().map(str::to_string) {
            let snapped = match config.thinking.as_ref() {
                // The model declares its levels — snap onto that set.
                Some(tc) => tc.snap_level(&req),
                // It declares nothing, and this guard used to skip that case entirely, which is
                // precisely where the failure lived: a caller asking for the cheapest reasoning sent
                // "minimal", an undeclared model rejected it with a 400, and consolidation died on
                // every conversation for weeks. With no declaration to snap onto, only send values
                // that are portable across providers and drop the rest — an omitted level cannot be
                // rejected, whereas an exotic one can.
                None => match req.as_str() {
                    "low" | "medium" | "high" => Some(req.clone()),
                    _ => None,
                },
            };
            if snapped.as_deref() != Some(req.as_str()) {
                tracing::info!(
                    category = "ai",
                    "thinking level adjusted — model={} requested={} → {:?} (declared={})",
                    config.id,
                    req,
                    snapped,
                    config.thinking.is_some()
                );
            }
            enriched.thinking_level = snapped;
        }
        // 진단 — CLI 가 실제 받는 모델 확인용(per-request 모델이 로그에 없어 "AI 멍청해짐" 추적 불가했던 갭).
        // None = CLI 기본 모델 / Some = --model 로 전송. effort 도 같이(추론 깊이).
        if config.format.starts_with("cli-") {
            tracing::info!(
                category = "ai",
                "CLI model resolve — id={} → --model={:?} thinking={:?} (None=CLI default)",
                config.id,
                enriched.cli_model,
                enriched.thinking_level
            );
        }
        enriched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use crate::llm::registry_loader;
    use std::sync::Once;
    use tempfile::tempdir;

    static INIT_REGISTRY: Once = Once::new();

    /// 테스트 setup — LLM registry 1회 초기화. Phase 5 (commit 5aed3a1) 이후 builtin_models 가
    /// OnceLock 폴백 (빈 list) 라 테스트에서 직접 init 해야 모델 검색 가능.
    /// CARGO_MANIFEST_DIR = infra crate 경로 → workspace root 의 system/llm/models.json absolute path.
    fn ensure_registry() {
        INIT_REGISTRY.call_once(|| {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../system/llm/models.json");
            std::env::set_var("FIREBAT_LLM_MODELS_PATH", path);
            registry_loader::init_from_file();
        });
    }

    fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
        ensure_registry();
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
        let adapter = ConfigDrivenAdapter::new(vault, "claude-sonnet-5".to_string());
        let result = adapter.ask_text("hi", &LlmCallOpts::default()).await;
        // API 키 없으니 핸들러가 명시 에러 반환 (실 LLM 호출 안 함)
        assert!(result.is_err());
        assert!(result.unwrap_err().to_lowercase().contains("api"));
    }

    #[tokio::test]
    async fn vault_override_model_id() {
        let (vault, _dir) = vault();
        vault.set_secret("system:llm:model", "gpt-5");
        let adapter = ConfigDrivenAdapter::new(vault, "claude-sonnet-5".to_string());
        // Vault override 우선
        assert_eq!(adapter.get_model_id(), "gpt-5");
    }
}
