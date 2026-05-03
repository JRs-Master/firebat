//! LlmModelConfig — 옛 TS infra/llm/configs/*.json Rust 재현.
//!
//! 모델당 1개 config. 새 모델 도입 시 JSON 만 추가 (코드 변경 0).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelConfig {
    /// 모델 식별자 (예: "claude-4-sonnet", "gpt-5-nano", "gemini-3-pro")
    pub id: String,

    /// 사용자 표시명
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// 공급자 (UI 카테고리 — "OpenAI" / "Anthropic" / "Google" / "Vertex" / "CLI")
    pub provider: String,

    /// 핸들러 분기 키.
    /// API: "openai-responses" | "anthropic-messages" | "gemini-native" | "vertex-gemini" | "openai-chat"
    /// CLI: "cli-claude-code" | "cli-codex" | "cli-gemini"
    pub format: String,

    /// API endpoint URL (CLI 의 경우 binary 이름)
    pub endpoint: String,

    /// API 키 Vault key (CLI 모드는 미사용 — 구독 인증)
    #[serde(rename = "apiKeyVaultKey", default, skip_serializing_if = "Option::is_none")]
    pub api_key_vault_key: Option<String>,

    /// 모델 features 토글 — 모델별 quirk 명시.
    #[serde(default)]
    pub features: LlmFeatures,

    /// 추가 헤더 (API 모드만) — Anthropic 의 anthropic-version / mcp-client beta 등
    #[serde(rename = "extraHeaders", default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub extra_headers: std::collections::HashMap<String, String>,

    /// 비용 (1M 토큰 USD) — input / output / cached
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<LlmPricing>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmFeatures {
    /// MCP connector 지원 (Anthropic 2025-11-20 / OpenAI hosted MCP)
    #[serde(rename = "mcpConnector", default)]
    pub mcp_connector: bool,
    /// 도구 schema strict mode (OpenAI / Gemini)
    #[serde(rename = "strictTools", default)]
    pub strict_tools: bool,
    /// reasoning 모드 (OpenAI o1/o3/GPT-5)
    #[serde(default)]
    pub reasoning: bool,
    /// Gemini thinking 4 단계 (off/dynamic/standard/extended)
    #[serde(default)]
    pub thinking: bool,
    /// Anthropic extended thinking (low/medium/high/xhigh/max)
    #[serde(rename = "extendedThinking", default)]
    pub extended_thinking: bool,
    /// OpenAI tool_search (Responses API)
    #[serde(rename = "toolSearch", default)]
    pub tool_search: bool,
    /// 이미지 입력 지원 — 옛 TS 의 vision 필드 alias.
    #[serde(rename = "imageInput", alias = "vision", default)]
    pub image_input: bool,
    /// 옛 TS 호환 — temperature 옵션 지원 여부.
    #[serde(default)]
    pub temperature: bool,
    /// 옛 TS 호환 — Anthropic prompt cache 토글 가능.
    #[serde(rename = "promptCache", default)]
    pub prompt_cache: bool,
}

/// 옛 TS LlmPricing 1:1 호환 — pricing.input / output / cachedInput (per 1M).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmPricing {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cachedInput", default)]
    pub cached_input: f64,
}

impl LlmModelConfig {
    /// 빌트인 stub config — 부팅 시 default 모델 fallback 용 (옛 TS 의 DEFAULT_MODEL).
    pub fn stub() -> Self {
        Self {
            id: "stub-model".to_string(),
            display_name: "Stub LLM (Phase B-17 미박음)".to_string(),
            provider: "Stub".to_string(),
            format: "stub".to_string(),
            endpoint: String::new(),
            api_key_vault_key: None,
            features: LlmFeatures::default(),
            extra_headers: Default::default(),
            pricing: None,
        }
    }
}

/// 등록된 LLM 모델 carousel — Vault `system:llm:registry` 또는 빌트인 .json 파일에서 로드.
/// Phase B-17 minimum: 빌트인 carousel 7개 (각 format 당 1개) — 사용자가 Vault 에 API 키 박으면 활성.
pub fn builtin_models() -> Vec<LlmModelConfig> {
    vec![
        // ── Anthropic API ──────────────────────────────────────────────────
        LlmModelConfig {
            id: "claude-4-sonnet".to_string(),
            display_name: "Claude 4 Sonnet".to_string(),
            provider: "Anthropic".to_string(),
            format: "anthropic-messages".to_string(),
            endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            api_key_vault_key: Some("system:anthropic:api-key".to_string()),
            features: LlmFeatures {
                mcp_connector: true,
                extended_thinking: true,
                image_input: true,
                ..Default::default()
            },
            extra_headers: [
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ]
            .into_iter()
            .collect(),
            pricing: Some(LlmPricing {
                input: 3.0,
                output: 15.0,
                cached_input: 0.3,
            }),
        },
        // ── OpenAI Responses API ───────────────────────────────────────────
        LlmModelConfig {
            id: "gpt-5".to_string(),
            display_name: "GPT-5".to_string(),
            provider: "OpenAI".to_string(),
            format: "openai-responses".to_string(),
            endpoint: "https://api.openai.com/v1/responses".to_string(),
            api_key_vault_key: Some("system:openai:api-key".to_string()),
            features: LlmFeatures {
                mcp_connector: true,
                strict_tools: true,
                reasoning: true,
                tool_search: true,
                image_input: true,
                ..Default::default()
            },
            pricing: Some(LlmPricing {
                input: 5.0,
                output: 30.0,
                cached_input: 0.5,
            }),
            ..Default::default()
        },
        // ── Gemini AI Studio ────────────────────────────────────────────────
        LlmModelConfig {
            id: "gemini-3-pro".to_string(),
            display_name: "Gemini 3 Pro".to_string(),
            provider: "Google".to_string(),
            format: "gemini-native".to_string(),
            endpoint: "https://generativelanguage.googleapis.com".to_string(),
            api_key_vault_key: Some("system:gemini:api-key".to_string()),
            features: LlmFeatures {
                strict_tools: true,
                thinking: true,
                image_input: true,
                ..Default::default()
            },
            ..Default::default()
        },
        // ── Vertex AI ──────────────────────────────────────────────────────
        LlmModelConfig {
            id: "vertex-gemini-3-pro".to_string(),
            display_name: "Gemini 3 Pro (Vertex)".to_string(),
            provider: "Vertex".to_string(),
            format: "vertex-gemini".to_string(),
            endpoint: "https://aiplatform.googleapis.com".to_string(),
            api_key_vault_key: Some("system:vertex:service-account-json".to_string()),
            features: LlmFeatures {
                strict_tools: true,
                thinking: true,
                image_input: true,
                ..Default::default()
            },
            ..Default::default()
        },
        // ── OpenAI compat (Ollama / OpenRouter / LM Studio) ────────────────
        LlmModelConfig {
            id: "openai-compat".to_string(),
            display_name: "OpenAI Compat (Ollama/OpenRouter)".to_string(),
            provider: "Compat".to_string(),
            format: "openai-chat".to_string(),
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            api_key_vault_key: Some("system:openai-compat:api-key".to_string()),
            ..Default::default()
        },
        // ── CLI 구독 모드 ──────────────────────────────────────────────────
        LlmModelConfig {
            id: "cli-claude-code".to_string(),
            display_name: "Claude Code (구독)".to_string(),
            provider: "CLI".to_string(),
            format: "cli-claude-code".to_string(),
            endpoint: "claude".to_string(), // binary 이름
            api_key_vault_key: None,
            features: LlmFeatures {
                mcp_connector: true,
                ..Default::default()
            },
            ..Default::default()
        },
        LlmModelConfig {
            id: "cli-codex".to_string(),
            display_name: "Codex (ChatGPT 구독)".to_string(),
            provider: "CLI".to_string(),
            format: "cli-codex".to_string(),
            endpoint: "codex".to_string(),
            api_key_vault_key: None,
            ..Default::default()
        },
        LlmModelConfig {
            id: "cli-gemini".to_string(),
            display_name: "Gemini CLI (Google AI Pro)".to_string(),
            provider: "CLI".to_string(),
            format: "cli-gemini".to_string(),
            endpoint: "gemini".to_string(),
            api_key_vault_key: None,
            ..Default::default()
        },
    ]
}

impl Default for LlmModelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            display_name: String::new(),
            provider: String::new(),
            format: String::new(),
            endpoint: String::new(),
            api_key_vault_key: None,
            features: LlmFeatures::default(),
            extra_headers: Default::default(),
            pricing: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_carousel_has_8_formats() {
        let models = builtin_models();
        assert_eq!(models.len(), 8);
        let formats: Vec<&str> = models.iter().map(|m| m.format.as_str()).collect();
        assert!(formats.contains(&"anthropic-messages"));
        assert!(formats.contains(&"openai-responses"));
        assert!(formats.contains(&"gemini-native"));
        assert!(formats.contains(&"vertex-gemini"));
        assert!(formats.contains(&"openai-chat"));
        assert!(formats.contains(&"cli-claude-code"));
        assert!(formats.contains(&"cli-codex"));
        assert!(formats.contains(&"cli-gemini"));
    }

    #[test]
    fn anthropic_config_has_mcp_and_extended_thinking() {
        let m = builtin_models().into_iter().find(|m| m.id == "claude-4-sonnet").unwrap();
        assert!(m.features.mcp_connector);
        assert!(m.features.extended_thinking);
        assert_eq!(m.extra_headers.get("anthropic-version").map(String::as_str), Some("2023-06-01"));
    }

    #[test]
    fn cli_models_have_no_api_key() {
        for m in builtin_models() {
            if m.format.starts_with("cli-") {
                assert!(m.api_key_vault_key.is_none());
            }
        }
    }
}
