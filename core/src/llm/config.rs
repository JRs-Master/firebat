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

    /// Max output tokens cap (per-model). API formats use it as the max_tokens / maxOutputTokens
    /// default — a high ceiling so the model judges actual length via the prompt, not an artificial
    /// cap. Unset → conservative 8192 fallback. CLI formats ignore this (the CLI manages output).
    #[serde(rename = "maxOutput", default, skip_serializing_if = "Option::is_none")]
    pub max_output: Option<i64>,

    /// 모델 features 토글 — 모델별 quirk 명시.
    #[serde(default)]
    pub features: LlmFeatures,

    /// 추가 헤더 (API 모드만) — Anthropic 의 anthropic-version / mcp-client beta 등
    #[serde(rename = "extraHeaders", default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub extra_headers: std::collections::HashMap<String, String>,

    /// 비용 (1M 토큰 USD) — input / output / cached
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<LlmPricing>,

    /// thinking / reasoning 모드 + 허용 레벨. 미지원 모델은 omit.
    /// Phase 5 확장 (2026-05-13) — frontend types.ts 의 hardcoded THINKING_LEVELS / getThinkingKind /
    /// filterThinkingLevels 폐기 → JSON 단일 source. 새 모델 / 레벨 변경 시 JSON 수정만.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingConfig>,

    /// 실행 모드 — "api" (pay-per-token) 또는 "cli" (구독 기반, 자체 인증).
    /// frontend SettingsModal 의 옛 prefix 분기 (`startsWith('cli-')` 등) 폐기 → entry lookup.
    /// 2026-05-13 확장.
    #[serde(default, rename = "execMode")]
    pub exec_mode: String,

    /// CLI 모델의 provider sub-category — "claude" / "codex" / "gemini". API 모델은 omit.
    /// frontend 의 inferCliProvider 옛 prefix 분기 폐기 → entry lookup.
    #[serde(default, rename = "cliProvider", skip_serializing_if = "Option::is_none")]
    pub cli_provider: Option<String>,

    /// UI 분류 키 — "cli-claude" / "cli-codex" / "cli-gemini" / "vertex-google" / "api-openai" /
    /// "api-google" / "api-anthropic". `firebat_last_model_by_category` Vault key 분류.
    /// frontend 의 categoryOf 옛 prefix 분기 폐기 → entry lookup.
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    /// "reasoning" (OpenAI effort) / "thinking" (Gemini level) / "extendedThinking" (Anthropic budget).
    pub kind: String,
    /// 허용 thinking 레벨 — frontend dropdown 그대로 표시.
    pub levels: Vec<ThinkingLevel>,
    /// **파라미터를 생략했을 때** 그 모델이 사고를 하는가. 세대마다 갈리는데 요청 shape 로는 구분이
    /// 안 돼 선언이 필요하다: Opus 4.8/4.7/4.6·Sonnet 4.6·Haiku = 생략이면 **안 함**(기본 false) /
    /// **Opus 5·Sonnet 5·Fable 5 = 생략해도 adaptive 로 함**(true). true 인데 생략하면 "껐다"고
    /// 믿은 요청이 사고를 하고, thinking 이 max_tokens 를 응답과 함께 먹어 답이 잘린다.
    #[serde(rename = "onWhenOmitted", default)]
    pub on_when_omitted: bool,
    /// 명시적으로 끌 수 있는가. Fable 5 는 `{type:"disabled"}` 자체가 400 이라 끌 방법이 없다.
    /// `on_when_omitted` 가 true 인 모델에서만 의미 있음(false 면 생략이 곧 off).
    #[serde(rename = "canDisable", default = "default_true")]
    pub can_disable: bool,
    /// 끄기가 허용되는 effort 상한 — Opus 5 는 `disabled` + `xhigh`/`max` 조합이 400 이라 "high".
    /// 미지정 = 상한 없음.
    #[serde(rename = "disableMaxEffort", default, skip_serializing_if = "Option::is_none")]
    pub disable_max_effort: Option<String>,
    /// The level to SEND when the caller picked none. Needed where the model's own default is
    /// the wrong one for us: solar-pro4 with tools present reasons ZERO unless asked (measured
    /// 2026-08-09 — every FC round's trace came back empty and the word-chain turns replayed
    /// templates without a thought), while `low` alongside tools costs ~a hundred tokens and
    /// records WHY an action was picked. A user-chosen level always wins over this.
    #[serde(rename = "defaultLevel", default, skip_serializing_if = "Option::is_none")]
    pub default_level: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Thinking effort ladder — 백엔드 값의 강도 순서. 스냅 계산에만 쓴다(전송 값은 문자열 그대로).
const THINKING_LADDER: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// The cheapest level that still thinks, for the model with this id — `None` when the model is
/// unknown or declares no thinking. Thin lookup; the rule is `ThinkingConfig::cheapest`.
pub fn cheapest_thinking_level(model_id: &str) -> Option<String> {
    builtin_models()
        .into_iter()
        .find(|m| m.id == model_id)?
        .thinking?
        .cheapest()
}

impl ThinkingConfig {
    /// 요청 레벨을 **이 모델이 선언한 레벨** 중 하나로 스냅한다.
    ///
    /// 왜 필요한가: 호출자가 의도("가장 싼 추론" = `minimal`)를 문자열로 박아 보내는데, 그 값을
    /// 선언하지 않은 모델은 400 으로 거부한다(실측: consolidation 이 `minimal` 을 보내 GPT-5.6 이
    /// `unsupported_value` 400 → 기억 추출이 조용히 전멸). 모델별 매핑을 핸들러마다 박는 게 아니라
    /// **선언(models.json)이 유일한 진실**이 되게 여기서 한 번 막는다.
    ///
    /// 규칙 = ladder 상 가장 가까운 선언 레벨, **동률이면 위쪽**(품질 쪽이 안전 — `minimal` 은
    /// "추론 끄기"가 아니라 "가장 얕은 추론"이 의도라 `none` 보다 `low` 가 맞다).
    /// The cheapest level that still thinks — what a background job should pick.
    ///
    /// The lowest declared level, skipping `none`: that one means "reasoning off", not "reasoning
    /// cheaply", and 13 of the 31 declaring models put it first (solar-pro4 and every GPT-5.x), so
    /// taking the head of the list would quietly switch memory extraction's thinking off on all of
    /// them. Picking from the model's own declaration makes the value legal by construction, which
    /// is why the extraction job no longer names a level and hopes `snap_level` fixes it — that
    /// hope is how a hard-coded `"minimal"` reached GPT-5.6 as a 400 and took extraction with it.
    pub fn cheapest(&self) -> Option<String> {
        self.levels
            .iter()
            .find(|l| l.value != "none")
            .or_else(|| self.levels.first())
            .map(|l| l.value.clone())
    }

    pub fn snap_level(&self, requested: &str) -> Option<String> {
        if self.levels.is_empty() {
            return Some(requested.to_string()); // 선언 없음 = 검증 불가, 그대로 통과(하위호환)
        }
        if self.levels.iter().any(|l| l.value == requested) {
            return Some(requested.to_string());
        }
        let rank = |v: &str| THINKING_LADDER.iter().position(|x| *x == v);
        let want = rank(requested)?;
        self.levels
            .iter()
            .filter_map(|l| rank(&l.value).map(|r| (l.value.clone(), r)))
            .min_by_key(|(_, r)| (r.abs_diff(want), if *r < want { 1 } else { 0 }))
            .map(|(v, _)| v)
    }
}

#[cfg(test)]
mod thinking_tests {
    use super::*;

    /// The real declarations, read at compile time. `builtin_models()` reads a registry that only
    /// infra fills at startup, so a core-only test run sees an empty list and would assert nothing.
    const MODELS_JSON: &str = include_str!("../../../system/llm/models.json");

    fn declared() -> Vec<(String, ThinkingConfig)> {
        let doc: serde_json::Value = serde_json::from_str(MODELS_JSON).expect("models.json parses");
        doc["models"]
            .as_array()
            .expect("models array")
            .iter()
            .filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                let t = m.get("thinking")?;
                let cfg: ThinkingConfig = serde_json::from_value(t.clone()).ok()?;
                Some((id, cfg))
            })
            .collect()
    }

    /// The extraction job used to send a hard-coded `"minimal"` and let the adapter snap it. It now
    /// picks from the model's own declaration instead, and the two must agree on every model — or
    /// background extraction quietly changed effort the day this landed.
    #[test]
    fn the_cheapest_pick_matches_what_snapping_minimal_used_to_produce() {
        let models = declared();
        assert!(models.len() > 20, "expected many declaring models, saw {}", models.len());
        for (id, cfg) in models {
            let picked = cfg.cheapest().expect("declares levels");
            let snapped = cfg.snap_level("minimal").expect("minimal ranks on the ladder");
            assert_eq!(picked, snapped, "{id} disagrees");
        }
    }

    /// Why the head of the list is not simply taken: `none` means "do not think".
    #[test]
    fn none_is_never_the_cheapest_pick_when_anything_else_is_declared() {
        let mut saw_a_none_first = false;
        for (id, cfg) in declared() {
            if cfg.levels.first().map(|l| l.value.as_str()) != Some("none") {
                continue;
            }
            saw_a_none_first = true;
            assert_ne!(
                cfg.cheapest().as_deref(),
                Some("none"),
                "{id} would run background extraction with reasoning off"
            );
        }
        assert!(saw_a_none_first, "fixture drift — no model declares `none` first any more");
    }

    /// The label is derived from the value now, so the declarations must not carry one — a
    /// reintroduced `labels` block is the start of the 17-spellings drift all over again.
    #[test]
    fn no_declaration_carries_a_hand_written_label() {
        let doc: serde_json::Value = serde_json::from_str(MODELS_JSON).unwrap();
        for m in doc["models"].as_array().unwrap() {
            let Some(levels) = m.pointer("/thinking/levels").and_then(|v| v.as_array()) else {
                continue;
            };
            for l in levels {
                assert!(
                    l.get("labels").is_none(),
                    "{} still declares labels",
                    m["id"].as_str().unwrap_or("?")
                );
            }
        }
    }

    #[test]
    fn an_empty_declaration_has_no_cheapest_level() {
        let cfg: ThinkingConfig =
            serde_json::from_value(serde_json::json!({ "kind": "reasoning", "levels": [] }))
                .expect("empty level list parses");
        assert_eq!(cfg.cheapest(), None);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingLevel {
    /// 백엔드에 전달되는 값 ("none" / "minimal" / "low" / "medium" / "high" / "xhigh" / "max").
    ///
    /// 표시 이름은 이 값에서 파생한다(frontend `thinkingLevelLabel`). 옛 `labels` 필드는 모델마다
    /// 손으로 적혀 **158개**였고, 값 7종이 표기 17종으로 갈라져 있었다 — 같은 `high` 가 고른 모델에
    /// 따라 "High" · "High (높음)" · "High (높음, 기본)" 로 보였다. 이름이 값의 함수라 목록을
    /// 유지할 이유가 없다. [[feedback_derive_dont_maintain_lists]]
    pub value: String,
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
            thinking: None,
            exec_mode: "api".to_string(),
            cli_provider: None,
            max_output: None,
            category: String::new(),
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
        thinking: None,
        exec_mode: "api".to_string(),
        cli_provider: None,
        max_output: None,
        category: "api-anthropic".to_string(),
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
/// Phase 5 정공 (2026-05-13) — 옛 Rust 하드코드 폐기. `system/llm/models.json` source.
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
            thinking: None,
            exec_mode: "api".to_string(),
            cli_provider: None,
            max_output: None,
            category: String::new(),
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
        let m = anthropic_api("claude-sonnet-5", "Claude Sonnet 5", 3.0, 15.0);
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
        let m = anthropic_api("claude-opus-4-8", "Claude Opus 4.8", 5.0, 25.0);
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
