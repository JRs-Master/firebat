//! 8 format 핸들러 공유 helpers — reqwest client + 비용 계산 + 에러 변환.

use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::LlmCallOpts;

/// 공유 reqwest::Client — connection pool 재사용. core utils 로 이동 (services 와 공유).
/// re-export 로 옛 호출부 호환.
pub use firebat_core::utils::http_client::http_client;

/// API 키 또는 명시 에러.
pub fn require_api_key(config: &LlmModelConfig, api_key: Option<&str>) -> Result<String, String> {
    match api_key {
        Some(k) if !k.is_empty() => Ok(k.to_string()),
        _ => Err(format!(
            "{} API 키 미설정 — Vault `{}` 박으세요",
            config.id,
            config.api_key_vault_key.as_deref().unwrap_or("(미정의)")
        )),
    }
}

/// reqwest::Error → InfraResult 변환.
pub fn map_reqwest_error<E: std::fmt::Display>(e: E) -> String {
    format!("HTTP 요청 실패: {e}")
}

/// 비용 계산 — input/output 토큰 수 + config.pricing → USD.
/// 매 응답마다 호출. None pricing 이면 0.
pub fn compute_cost(config: &LlmModelConfig, tokens_in: i64, tokens_out: i64) -> f64 {
    let Some(pricing) = &config.pricing else {
        return 0.0;
    };
    (tokens_in as f64 / 1_000_000.0) * pricing.input
        + (tokens_out as f64 / 1_000_000.0) * pricing.output
}

/// system prompt + user prompt → 단일 messages 배열.
/// 옛 TS 의 `LlmCallOpts.systemPrompt` 가 박혀있으면 system role 으로 분리, 없으면 user only.
pub fn build_messages(opts: &LlmCallOpts, user_prompt: &str) -> serde_json::Value {
    if let Some(sp) = opts.system_prompt.as_deref() {
        if !sp.is_empty() {
            return serde_json::json!([
                {"role": "system", "content": sp},
                {"role": "user", "content": user_prompt},
            ]);
        }
    }
    serde_json::json!([{"role": "user", "content": user_prompt}])
}
