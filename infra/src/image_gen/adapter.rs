//! ConfigDrivenImageGenAdapter — IImageGenPort 구현.
//!
//! 옛 TS `infra/image/config-adapter.ts` 1:1 port. LLM 의 ConfigDrivenAdapter 와 병렬 구조.
//!
//! 동작:
//!   1. 모델 ID 로 config JSON 해석 (registry — builtin + 사용자 디렉토리)
//!   2. `config.format` → ImageFormatHandler 위임
//!   3. handler 가 실제 HTTP / subprocess 호출 + binary 반환
//!
//! 새 모델 도입 시:
//!   - 기존 format 재사용 → JSON config 추가만 (코드 변경 0)
//!   - 신규 format → formats/ 에 핸들러 추가 + register

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::image_gen::config::{
    build_registry, ImageGenFormat, ImageGenModelConfig, ImageGenRegistry,
};
use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use crate::image_gen::formats::{CliCodexImageFormat, GeminiNativeImageFormat, OpenAiImageFormat};
use firebat_core::ports::{
    IImageGenPort, ImageGenCallOpts, ImageGenOpts, ImageGenResult, ImageModelInfo, InfraResult,
    IVaultPort,
};

pub struct ConfigDrivenImageGenAdapter {
    vault: Arc<dyn IVaultPort>,
    default_model_id: String,
    registry: ImageGenRegistry,
    handlers: HashMap<ImageGenFormat, Arc<dyn ImageFormatHandler>>,
}

impl ConfigDrivenImageGenAdapter {
    /// builtin 만 — 사용자 디렉토리 미박음.
    pub fn new(vault: Arc<dyn IVaultPort>, default_model_id: String) -> Self {
        Self::with_configs_dir(vault, default_model_id, None)
    }

    /// builtin + 사용자 디렉토리 (`system/image/configs/*.json`) 통합.
    pub fn with_configs_dir(
        vault: Arc<dyn IVaultPort>,
        default_model_id: String,
        configs_dir: Option<&Path>,
    ) -> Self {
        let registry = build_registry(configs_dir);
        let mut handlers: HashMap<ImageGenFormat, Arc<dyn ImageFormatHandler>> = HashMap::new();
        handlers.insert(ImageGenFormat::OpenaiImage, Arc::new(OpenAiImageFormat::new()));
        handlers.insert(
            ImageGenFormat::GeminiNativeImage,
            Arc::new(GeminiNativeImageFormat::new()),
        );
        handlers.insert(
            ImageGenFormat::CliCodexImage,
            Arc::new(CliCodexImageFormat::new()),
        );
        // VertexGeminiImage / StabilityApi — 향후 박을 수 있음. 미지원 시 generate 가 명시 에러.
        Self {
            vault,
            default_model_id,
            registry,
            handlers,
        }
    }

    /// 모델 ID 해석 — 옛 TS `resolveConfig` 1:1 (직접 매칭 → prefix 매칭 → default).
    fn resolve_config(&self, model_id: Option<&str>) -> Option<&ImageGenModelConfig> {
        let id = model_id.unwrap_or(&self.default_model_id);
        if id.is_empty() {
            return self.registry.values().next();
        }
        if let Some(direct) = self.registry.get(id) {
            return Some(direct);
        }
        // prefix 매치 (LLM 어댑터와 동일 패턴)
        for cfg in self.registry.values() {
            if cfg.id.starts_with(id) || id.starts_with(&cfg.id) {
                return Some(cfg);
            }
        }
        // fallback — default model 또는 첫 번째
        self.registry
            .get(&self.default_model_id)
            .or_else(|| self.registry.values().next())
    }
}

#[async_trait::async_trait]
impl IImageGenPort for ConfigDrivenImageGenAdapter {
    fn get_model_id(&self) -> String {
        // Vault `system:image:model` 우선 — 미박음 시 default.
        // 옛 TS 는 ConfigDrivenAdapter 부팅 시 default 결정 — 여기선 매 호출 lookup (Vault 변경 즉시 반영).
        self.vault
            .get_secret("system:image:model")
            .unwrap_or_else(|| self.default_model_id.clone())
    }

    fn list_models(&self) -> Vec<ImageModelInfo> {
        self.registry
            .values()
            .map(|cfg| {
                let features = cfg.features.as_object();
                let sizes = features
                    .and_then(|f| f.get("sizes"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let qualities = features
                    .and_then(|f| f.get("qualities"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let subscription = features
                    .and_then(|f| f.get("subscription"))
                    .and_then(|v| v.as_bool());
                ImageModelInfo {
                    id: cfg.id.clone(),
                    display_name: cfg.display_name.clone(),
                    provider: cfg.provider.clone(),
                    format: format_to_string(cfg.format).to_string(),
                    requires_organization_verification: None,
                    sizes,
                    qualities,
                    subscription,
                }
            })
            .collect()
    }

    async fn generate(
        &self,
        opts: &ImageGenOpts,
        call_opts: &ImageGenCallOpts,
    ) -> InfraResult<ImageGenResult> {
        // 모델 결정 — opts.model > call_opts.model > Vault > default
        let active_model = opts
            .model
            .clone()
            .or_else(|| call_opts.model.clone())
            .or_else(|| self.vault.get_secret("system:image:model"))
            .unwrap_or_else(|| self.default_model_id.clone());

        let config = self
            .resolve_config(Some(&active_model))
            .ok_or_else(|| "이미지 생성 모델이 설정되지 않았습니다".to_string())?;
        let handler = self.handlers.get(&config.format).ok_or_else(|| {
            format!("지원하지 않는 format: {}", format_to_string(config.format))
        })?;

        let vault = self.vault.clone();
        let api_key_vault_key = config.api_key_vault_key.clone();
        let ctx = ImageFormatHandlerContext {
            config,
            resolve_api_key: Box::new(move || {
                if api_key_vault_key.is_empty() {
                    return None;
                }
                vault.get_secret(&api_key_vault_key)
            }),
        };
        handler.generate(opts, call_opts, ctx).await
    }
}

fn format_to_string(format: ImageGenFormat) -> &'static str {
    match format {
        ImageGenFormat::OpenaiImage => "openai-image",
        ImageGenFormat::GeminiNativeImage => "gemini-native-image",
        ImageGenFormat::VertexGeminiImage => "vertex-gemini-image",
        ImageGenFormat::StabilityApi => "stability-api",
        ImageGenFormat::CliCodexImage => "cli-codex-image",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn make_adapter(default_model: &str) -> (ConfigDrivenImageGenAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        let adapter = ConfigDrivenImageGenAdapter::new(vault, default_model.to_string());
        (adapter, dir)
    }

    #[test]
    fn list_models_returns_three_builtin() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        let models = adapter.list_models();
        assert_eq!(models.len(), 3);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"gpt-image-1"));
        assert!(ids.contains(&"gemini-3.1-flash-image-preview"));
        assert!(ids.contains(&"cli-codex-image"));
    }

    #[test]
    fn list_models_extracts_features() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        let models = adapter.list_models();
        let gpt = models.iter().find(|m| m.id == "gpt-image-1").unwrap();
        assert_eq!(gpt.provider, "openai");
        assert_eq!(gpt.format, "openai-image");
        assert!(gpt.sizes.contains(&"1024x1024".to_string()));
        assert!(gpt.qualities.contains(&"medium".to_string()));

        let codex = models.iter().find(|m| m.id == "cli-codex-image").unwrap();
        assert_eq!(codex.subscription, Some(true));
    }

    #[test]
    fn get_model_id_falls_back_to_default() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        // Vault 미박음 → default
        assert_eq!(adapter.get_model_id(), "gpt-image-1");
    }

    #[test]
    fn get_model_id_reads_vault_override() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        // Vault 박힘 → 그 값 우선 (옛 TS 와 동일 패턴 — 사용자가 모델 swap)
        adapter
            .vault
            .set_secret("system:image:model", "gemini-3.1-flash-image-preview");
        assert_eq!(
            adapter.get_model_id(),
            "gemini-3.1-flash-image-preview"
        );
    }

    #[test]
    fn resolve_config_direct_match() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        let cfg = adapter.resolve_config(Some("gpt-image-1")).unwrap();
        assert_eq!(cfg.id, "gpt-image-1");
    }

    #[test]
    fn resolve_config_prefix_match() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        // "gpt-image" prefix → "gpt-image-1" 매칭 (옛 TS prefix 매칭)
        let cfg = adapter.resolve_config(Some("gpt-image")).unwrap();
        assert_eq!(cfg.id, "gpt-image-1");
    }

    #[test]
    fn resolve_config_unknown_falls_back_to_default() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        let cfg = adapter.resolve_config(Some("totally-unknown-xyz")).unwrap();
        // default model 박혔으니 그 쪽으로
        assert_eq!(cfg.id, "gpt-image-1");
    }

    #[tokio::test]
    async fn generate_without_api_key_returns_clear_error() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        // Vault 에 API 키 미박음 → handler 가 명시 error
        let r = adapter
            .generate(
                &ImageGenOpts {
                    prompt: "test".to_string(),
                    ..Default::default()
                },
                &ImageGenCallOpts::default(),
            )
            .await;
        assert!(r.is_err());
        let err = r.unwrap_err();
        assert!(
            err.contains("API 키") && err.contains("OPENAI_API_KEY"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn generate_with_unknown_model_falls_back() {
        let (adapter, _tmp) = make_adapter("gpt-image-1");
        // unknown model + key 미박음 → fallback model 으로 시도 후 API 키 error
        let r = adapter
            .generate(
                &ImageGenOpts {
                    prompt: "test".to_string(),
                    model: Some("totally-unknown-xyz".to_string()),
                    ..Default::default()
                },
                &ImageGenCallOpts::default(),
            )
            .await;
        assert!(r.is_err());
    }
}
