//! LlmModelConfig — 옛 TS infra/llm/configs/*.json Rust 재현.
//!
//! 모델당 1개 config. 새 모델 도입 시 JSON 만 추가 (코드 변경 0).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelConfig {
    /// 모델 식별자 (예: "claude-sonnet-4-6", "gpt-5", "gemini-3-pro")
    pub id: String,

    /// 사용자 표시명
    #[serde(rename = "displayName")]
    pub display_name: String,

    /// 공급자 (UI 카테고리 — "OpenAI" / "Anthropic" / "Google" / "Vertex" / "CLI")
    pub provider: String,

    /// 핸들러 분기 키.
    /// API: "openai-responses" | "anthropic-messages" | "gemini-native" | "vertex-gemini"
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
            display_name: "Stub LLM (Phase B-17 미구현)".to_string(),
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

// ─── Helper functions — 모델 family 가 동일 endpoint / format / features 공유
//     factory 패턴으로 builtin_models 는 단순 list. 새 모델 추가 = 한 줄.

fn anthropic_api(id: &str, name: &str, input_price: f64, output_price: f64) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
        provider: "Anthropic".to_string(),
        format: "anthropic-messages".to_string(),
        endpoint: "https://api.anthropic.com/v1/messages".to_string(),
        api_key_vault_key: Some("system:anthropic:api-key".to_string()),
        features: LlmFeatures {
            mcp_connector: true,
            extended_thinking: true,
            image_input: true,
            prompt_cache: true,
            ..Default::default()
        },
        extra_headers: [("anthropic-version".to_string(), "2023-06-01".to_string())]
            .into_iter()
            .collect(),
        pricing: Some(LlmPricing {
            input: input_price,
            output: output_price,
            cached_input: input_price * 0.1,
        }),
    }
}

fn google_api(id: &str, name: &str) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
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
    }
}

fn vertex_api(id: &str, name: &str) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
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
    }
}

fn openai_api(id: &str, name: &str, input_price: f64, output_price: f64) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
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
            input: input_price,
            output: output_price,
            cached_input: input_price * 0.1,
        }),
        ..Default::default()
    }
}

fn cli_claude(id: &str, name: &str) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
        provider: "CLI".to_string(),
        format: "cli-claude-code".to_string(),
        endpoint: "claude".to_string(),
        api_key_vault_key: None,
        features: LlmFeatures {
            mcp_connector: true,
            extended_thinking: true,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn cli_gemini(id: &str, name: &str) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
        provider: "CLI".to_string(),
        format: "cli-gemini".to_string(),
        endpoint: "gemini".to_string(),
        api_key_vault_key: None,
        features: LlmFeatures {
            mcp_connector: true,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn cli_codex(id: &str, name: &str) -> LlmModelConfig {
    LlmModelConfig {
        id: id.to_string(),
        display_name: name.to_string(),
        provider: "CLI".to_string(),
        format: "cli-codex".to_string(),
        endpoint: "codex".to_string(),
        api_key_vault_key: None,
        features: LlmFeatures {
            mcp_connector: true,
            reasoning: true,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// 빌트인 LLM 모델 carousel — frontend types.ts AI_MODELS 와 1:1 매칭.
///
/// Phase 5 정공 (2026-05-13) — 옛 Rust 하드코드 폐기. `infra/data/llm-models.json` source.
/// infra startup 에 `registry_loader::init_from_file()` 호출 → 본 함수가 registry 에서 가져옴.
///
/// 새 모델 추가 = JSON edit + restart (Rust 재빌드 0).
pub fn builtin_models() -> Vec<LlmModelConfig> {
    crate::llm::registry::builtin_models()
}

// ─── Helper functions — 옛 호환 유지 (tests / 동적 모델 추가 시 사용).
//     JSON registry 가 single source 라 일반 운영에서 호출 없음 — tests 만 유지.

#[allow(dead_code)]
fn _retain_helpers() {
    let _ = anthropic_api;
    let _ = google_api;
    let _ = vertex_api;
    let _ = openai_api;
    let _ = cli_claude;
    let _ = cli_gemini;
    let _ = cli_codex;
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

    // Phase 5 정공 (2026-05-13) — 옛 builtin_models() 직접 호출 테스트는 registry init 의존.
    // 본 단위 테스트는 helper function 의 config 구조 검증만 — registry 의존 0.
    // 통합 검증 (JSON 파싱 + 모든 모델 카운트) = infra integration test 영역.

    #[test]
    fn anthropic_helper_has_mcp_and_extended_thinking() {
        let m = anthropic_api("claude-sonnet-4-6", "Claude Sonnet 4.6", 3.0, 15.0);
        assert!(m.features.mcp_connector);
        assert!(m.features.extended_thinking);
        assert_eq!(
            m.extra_headers.get("anthropic-version").map(String::as_str),
            Some("2023-06-01"),
        );
    }

    #[test]
    fn cli_helpers_have_no_api_key() {
        assert!(cli_claude("cli-claude-code-auto", "x").api_key_vault_key.is_none());
        assert!(cli_codex("cli-codex-auto", "x").api_key_vault_key.is_none());
        assert!(cli_gemini("cli-gemini-auto", "x").api_key_vault_key.is_none());
    }

    #[test]
    fn anthropic_pricing_passthrough() {
        let m = anthropic_api("claude-opus-4-7", "Claude Opus 4.7", 5.0, 25.0);
        let p = m.pricing.expect("opus pricing");
        assert_eq!(p.input, 5.0);
        assert_eq!(p.output, 25.0);
    }

    #[test]
    fn formats_distinct_per_helper() {
        assert_eq!(google_api("x", "y").format, "gemini-native");
        assert_eq!(vertex_api("x", "y").format, "vertex-gemini");
        assert_eq!(openai_api("x", "y", 0.0, 0.0).format, "openai-responses");
        assert_eq!(cli_claude("x", "y").format, "cli-claude-code");
        assert_eq!(cli_codex("x", "y").format, "cli-codex");
        assert_eq!(cli_gemini("x", "y").format, "cli-gemini");
    }
}
