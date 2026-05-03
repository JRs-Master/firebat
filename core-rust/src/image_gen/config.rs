//! ImageGenModelConfig + Registry — LLM 의 `LlmModelConfig` 와 병렬 구조.
//!
//! 옛 TS `infra/image/image-config.ts` 1:1 port. 빌드 타임 builtin carousel + 런타임
//! `system/image/configs/*.json` 디렉토리 자동 로드 (사용자 모델 추가).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImageGenFormat {
    /// OpenAI gpt-image-* (`/v1/images/generations` + `/v1/images/edits`).
    OpenaiImage,
    /// Gemini 3.1 Flash Image (AI Studio `generateContent` multimodal).
    GeminiNativeImage,
    /// Vertex AI Gemini 이미지 — 향후 박을 수 있음 (Service Account JSON 인증).
    VertexGeminiImage,
    /// Stability AI (SD3 등) — 향후.
    StabilityApi,
    /// Codex CLI `$imagegen` skill (구독 기반, 비용 0).
    CliCodexImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenModelConfig {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub provider: String,
    pub format: ImageGenFormat,
    pub endpoint: String,
    /// Vault 키 — 없어도 되는 CLI 모드 포함 (빈 string 으로 명시).
    #[serde(rename = "apiKeyVaultKey")]
    pub api_key_vault_key: String,
    /// 모델 별 features — `multilingualText / sizes / qualities / subscription` 등.
    /// 옛 TS Record<string, unknown> 1:1 — JSON value 그대로 보존.
    #[serde(default)]
    pub features: serde_json::Value,
    /// 가격 — `lowPerImage / mediumPerImage / highPerImage` (OpenAI),
    /// `perImage` (Gemini), `note` (구독) 등.
    #[serde(default)]
    pub pricing: serde_json::Value,
    /// extraHeaders — provider 별 추가 헤더.
    #[serde(rename = "extraHeaders", default, skip_serializing_if = "HashMap::is_empty")]
    pub extra_headers: HashMap<String, String>,
}

pub type ImageGenRegistry = HashMap<String, ImageGenModelConfig>;

/// config.pricing 에서 quality 별 단가 lookup.
/// 옛 TS `computeImageCost` 1:1 — 일반 로직 (provider hardcode X).
///
/// 지원 형식:
///   - `{ lowPerImage, mediumPerImage, highPerImage }` — quality 별 (OpenAI gpt-image-*)
///   - `{ perImage }` — 단일 단가 (Gemini Imagen)
///   - `{ note: ... }` — 구독 기반 (Codex CLI) → None 반환 (cost 0 / 미박음)
///
/// 미정의 / 매칭 실패 시 None. 어댑터가 None 받으면 `ImageGenResult.cost_usd` 박지 않음.
pub fn compute_image_cost(config: &ImageGenModelConfig, quality: Option<&str>) -> Option<f64> {
    let pricing = config.pricing.as_object()?;

    // 단일 단가 (Gemini)
    if let Some(per_image) = pricing.get("perImage").and_then(|v| v.as_f64()) {
        return Some(per_image);
    }

    // quality 별 (OpenAI). quality 미박음 시 medium fallback (가장 흔한 default).
    let q = quality.unwrap_or("medium").to_lowercase();
    let key = format!("{}PerImage", q);
    pricing.get(&key).and_then(|v| v.as_f64())
}

/// Builtin carousel — 빌드 타임 박힘. 사용자 추가 모델은 디렉토리 로드로.
pub fn builtin_configs() -> Vec<ImageGenModelConfig> {
    const GPT_IMAGE_1: &str = include_str!("configs/gpt-image-1.json");
    const GEMINI_FLASH_IMAGE: &str = include_str!("configs/gemini-3-1-flash-image.json");
    const CLI_CODEX_IMAGE: &str = include_str!("configs/cli-codex-image.json");
    [GPT_IMAGE_1, GEMINI_FLASH_IMAGE, CLI_CODEX_IMAGE]
        .iter()
        .filter_map(|raw| serde_json::from_str(raw).ok())
        .collect()
}

/// 디렉토리에서 `*.json` 자동 로드 (사용자 추가 모델). 옛 TS `loadImageGenRegistry` 1:1.
/// 디렉토리 없으면 빈 결과. 개별 파일 파싱 실패는 무시 (다른 파일 영향 X).
pub fn load_registry_from_dir(dir: &Path) -> ImageGenRegistry {
    let mut registry = ImageGenRegistry::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return registry;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(cfg) = serde_json::from_str::<ImageGenModelConfig>(&raw) {
            if !cfg.id.is_empty() {
                registry.insert(cfg.id.clone(), cfg);
            }
        }
    }
    registry
}

/// Builtin + 사용자 디렉토리 통합 registry. 같은 id 의 user 디렉토리 config 가 builtin override.
pub fn build_registry(user_dir: Option<&Path>) -> ImageGenRegistry {
    let mut registry = ImageGenRegistry::new();
    for cfg in builtin_configs() {
        registry.insert(cfg.id.clone(), cfg);
    }
    if let Some(dir) = user_dir {
        let user = load_registry_from_dir(dir);
        for (id, cfg) in user {
            registry.insert(id, cfg);
        }
    }
    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_configs_load_three() {
        let configs = builtin_configs();
        assert_eq!(configs.len(), 3);
        let ids: Vec<&str> = configs.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"gpt-image-1"));
        assert!(ids.contains(&"gemini-3.1-flash-image-preview"));
        assert!(ids.contains(&"cli-codex-image"));
    }

    #[test]
    fn compute_cost_openai_quality_based() {
        let configs = builtin_configs();
        let gpt = configs.iter().find(|c| c.id == "gpt-image-1").unwrap();
        assert_eq!(compute_image_cost(gpt, Some("low")), Some(0.011));
        assert_eq!(compute_image_cost(gpt, Some("medium")), Some(0.042));
        assert_eq!(compute_image_cost(gpt, Some("high")), Some(0.167));
        // quality 미박음 시 medium fallback
        assert_eq!(compute_image_cost(gpt, None), Some(0.042));
    }

    #[test]
    fn compute_cost_gemini_per_image() {
        let configs = builtin_configs();
        let gemini = configs
            .iter()
            .find(|c| c.id == "gemini-3.1-flash-image-preview")
            .unwrap();
        // perImage 박혀있으면 quality 무관 동일 단가
        assert_eq!(compute_image_cost(gemini, None), Some(0.039));
        assert_eq!(compute_image_cost(gemini, Some("low")), Some(0.039));
        assert_eq!(compute_image_cost(gemini, Some("high")), Some(0.039));
    }

    #[test]
    fn compute_cost_cli_subscription_returns_none() {
        let configs = builtin_configs();
        let codex = configs.iter().find(|c| c.id == "cli-codex-image").unwrap();
        // 구독 기반 — pricing.note 만 박혀있어 None
        assert_eq!(compute_image_cost(codex, None), None);
        assert_eq!(compute_image_cost(codex, Some("medium")), None);
    }

    #[test]
    fn build_registry_without_user_dir() {
        let registry = build_registry(None);
        assert_eq!(registry.len(), 3);
        assert!(registry.contains_key("gpt-image-1"));
    }

    #[test]
    fn build_registry_with_nonexistent_user_dir() {
        // 디렉토리 없음 → builtin 만 로드 (silent fail, 옛 TS 동등)
        let registry = build_registry(Some(Path::new("nonexistent_xyz_path")));
        assert_eq!(registry.len(), 3);
    }
}
