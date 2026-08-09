//! 8 format 핸들러 공유 helpers — reqwest client + 비용 계산 + 에러 변환.

use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::LlmCallOpts;

/// LLM 전용 reqwest::Client — 공유 client(core utils, timeout 120s)와 분리.
/// LLM 라운드는 큰 프롬프트+추론으로 2분을 넘길 수 있다(2026-07-06 실측: Solar FC 라운드가
/// 120s timeout 에 걸려 "error sending request" — 도구/모듈 HTTP 와 달리 LLM 은 장고
/// 응답이 정상 동작). read timeout 600s + connect 10s(죽은 엔드포인트는 빠른 실패).
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(600))
            .pool_max_idle_per_host(8)
            .build()
            .expect("LLM reqwest client 빌드 실패")
    })
}

/// LLM 스트리밍 전용 client — total timeout 없음(스트림은 청크 간 idle timeout 이 행 감지를
/// 담당, total 을 걸면 정상적인 장고 스트림이 중간에 잘림). connect 10s 는 유지.
pub fn llm_stream_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_max_idle_per_host(8)
            .build()
            .expect("LLM stream reqwest client 빌드 실패")
    })
}

/// API 키 또는 명시 에러. 사용자 친화 메시지 — 내부 Vault key 노출 X (사용자가 어디서 입력하는지 모름).
pub fn require_api_key(config: &LlmModelConfig, api_key: Option<&str>) -> Result<String, String> {
    match api_key {
        Some(k) if !k.is_empty() => Ok(k.to_string()),
        _ => Err(firebat_core::i18n::t(
            "core.error.llm.api_key_required",
            None,
            &[("name", &config.display_name)],
        )),
    }
}

/// reqwest::Error → InfraResult 변환.
/// reqwest 의 Display 는 "error sending request for url" 까지만이고 진짜 원인(timeout /
/// connection reset / dns)은 source 체인에 있다 → 체인을 이어붙여 사용자 메시지에 포함 +
/// journal 에도 남긴다(옛엔 유저 메시지로만 가서 서버 로그에 흔적 0 = 진단 불가, 2026-07-06 실측).
pub fn map_reqwest_error<E: std::error::Error>(e: E) -> String {
    let mut detail = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        detail.push_str(": ");
        detail.push_str(&s.to_string());
        src = s.source();
    }
    tracing::warn!(target: "llm", error = %detail, "LLM HTTP request failed");
    firebat_core::i18n::t("core.error.llm.http_failed", None, &[("detail", &detail)])
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
/// 옛 TS 의 `LlmCallOpts.systemPrompt` 가 설정되어 있으면 system role 으로 분리, 없으면 user only.
///
/// An attached image rides in the user turn as OpenAI-style content parts. It used to ride
/// nowhere: ai.rs resolved the attachment to a data URL and this function dropped it, so every
/// openai-chat model was answered about a picture it never saw (2026-08-09 실측). The caller
/// gates on `ILlmPort::supports_image`, so an image reaching here is one the model can read.
pub fn build_messages(opts: &LlmCallOpts, user_prompt: &str) -> serde_json::Value {
    let user_content = match opts.image.as_deref().filter(|s| !s.is_empty()) {
        Some(img) => serde_json::json!([
            {"type": "text", "text": user_prompt},
            {"type": "image_url", "image_url": {"url": image_data_url(img, opts.image_mime_type.as_deref())}},
        ]),
        None => serde_json::Value::String(user_prompt.to_string()),
    };
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(opts.history.len() + 2);
    if let Some(sp) = opts.system_prompt.as_deref() {
        if !sp.is_empty() {
            messages.push(serde_json::json!({"role": "system", "content": sp}));
        }
    }
    // Prior turns as real messages. Until 2026-08-09 the caller pasted them into the system
    // prompt instead, which read as text to continue — the model answered a new question by
    // reproducing its own previous reply word for word.
    for h in &opts.history {
        let role = if h.role == "assistant" { "assistant" } else { "user" };
        let text = match &h.content {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if text.trim().is_empty() {
            continue;
        }
        messages.push(serde_json::json!({"role": role, "content": text}));
    }
    messages.push(serde_json::json!({"role": "user", "content": user_content}));
    serde_json::Value::Array(messages)
}

/// Normalize an image argument to a `data:` URL. ai.rs already converts slug URLs to base64, so
/// this only has to pass a data URL through and wrap bare base64 (the older opts shape).
pub fn image_data_url(image: &str, mime: Option<&str>) -> String {
    if image.starts_with("data:") || image.starts_with("http://") || image.starts_with("https://") {
        return image.to_string();
    }
    format!("data:{};base64,{}", mime.unwrap_or("image/png"), image)
}

/// Split a `data:<mime>;base64,<payload>` URL into its parts — the shape Anthropic wants
/// (`source: {type:"base64", media_type, data}`) rather than a URL.
pub fn image_media_and_data(image: &str, mime: Option<&str>) -> (String, String) {
    if let Some(rest) = image.strip_prefix("data:") {
        if let Some((meta, payload)) = rest.split_once(',') {
            let media = meta.split(';').next().unwrap_or("image/png");
            return (media.to_string(), payload.to_string());
        }
    }
    (mime.unwrap_or("image/png").to_string(), image.to_string())
}
