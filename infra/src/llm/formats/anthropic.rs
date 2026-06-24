//! Anthropic Messages API — Claude 4 시리즈 (옛 TS anthropic-messages.ts).
//!
//! 핵심 features:
//! - extended thinking (low/medium/high/xhigh/max → budget_tokens 매핑)
//! - MCP connector 2025-11-20 (betas + tools.mcp_toolset)
//! - prompt caching (Vault 토글) — 옛 TS 4-26 설정
//! - 멀티턴 tool_use / tool_result (tool_use_id + content blocks)
//!
//! Phase B-17 minimum: ask_text + ask_with_tools 단순 호출. extended thinking / MCP / cache 토글은
//! 후속 (현재 표준 messages API 만).

use crate::llm::adapter::FormatHandler;
use firebat_core::llm::config::LlmModelConfig;
use crate::llm::formats::common::{
    compute_cost, http_client, map_reqwest_error, require_api_key,
};
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

pub struct AnthropicMessagesHandler;

impl AnthropicMessagesHandler {
    pub fn new() -> Self {
        Self
    }

    /// Extended thinking 요청 파라미터 주입 — features.extendedThinking 활성 + thinking_level 실 레벨일 때만.
    /// 현재 Claude(Opus 4.6+/Sonnet 4.6/Haiku 4.5/Fable) = **adaptive thinking + output_config.effort** 가 정공.
    /// 옛 budget_tokens(`{type:enabled, budget_tokens}`)는 Opus 4.7/4.8/Fable 에서 폐기 = 400 → adaptive 로 전환.
    /// 레벨값(low/medium/high/xhigh/max) = effort 값 1:1. effort 는 Haiku 4.5 미지원(400)이라 Haiku 는 adaptive 만.
    /// temperature 제거(thinking 은 temperature 미지원).
    fn apply_extended_thinking(
        body: &mut serde_json::Value,
        config: &LlmModelConfig,
        opts: &LlmCallOpts,
    ) {
        if !config.features.extended_thinking {
            return;
        }
        let level = match opts.thinking_level.as_deref() {
            Some(l @ ("low" | "medium" | "high" | "xhigh" | "max")) => l,
            _ => return, // none / minimal / 미설정 → thinking off (param 생략 = 비활성)
        };
        // display:"summarized" 명시 — Opus 4.8/4.7/Fable 은 display 기본값이 "omitted"(thinking 빈 채 반환)라
        // 명시 안 하면 thinking 안 보인다. summarized 로 요약 사고 노출(4.6/Sonnet/Haiku 는 기본 summarized = no-op).
        // adaptive 와 호환(문서: always-on 모델도 display:summarized 명시 가능). budget_tokens 는 4.7+ 400.
        body["thinking"] = serde_json::json!({ "type": "adaptive", "display": "summarized" });
        // effort = Opus/Sonnet 4.6/Fable 지원, Haiku 4.5 미지원(400) → Haiku 는 adaptive 만.
        if !config.id.contains("haiku") {
            if let Some(obj) = body.as_object_mut() {
                let oc = obj
                    .entry("output_config")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(oc_map) = oc.as_object_mut() {
                    oc_map.insert("effort".to_string(), serde_json::Value::from(level));
                }
            }
        }
        // adaptive 는 thinking 예산이 max_tokens 에 안 섞임 → 출력 여유만 보장(최소 16000).
        let cur = body.get("max_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        let want = opts.max_tokens.or(config.max_output).unwrap_or(16000).max(16000);
        if cur < want {
            body["max_tokens"] = serde_json::Value::from(want);
        }
        if let Some(obj) = body.as_object_mut() {
            obj.remove("temperature");
        }
    }

    /// Anthropic 표준 헤더 빌드 — x-api-key + anthropic-version + extra (config.extra_headers).
    fn build_headers(
        config: &LlmModelConfig,
        api_key: &str,
    ) -> Result<reqwest::header::HeaderMap, String> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-api-key",
            reqwest::header::HeaderValue::from_str(api_key)
                .map_err(|e| format!("invalid api key: {e}"))?,
        );
        headers.insert(
            "content-type",
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        for (k, v) in &config.extra_headers {
            let name: reqwest::header::HeaderName = k
                .parse()
                .map_err(|e| format!("invalid extra header name {k}: {e}"))?;
            headers.insert(
                name,
                reqwest::header::HeaderValue::from_str(v)
                    .map_err(|e| format!("invalid extra header value: {e}"))?,
            );
        }
        Ok(headers)
    }

    /// Anthropic 응답에서 사용량 + content 추출.
    /// 응답 schema: { content: [{type: "text", text: ...}, {type: "thinking", thinking: ...}, {type: "tool_use", id, name, input}], usage: {input_tokens, output_tokens} }
    /// 반환: (text, tool_calls, tokens_in 총입력, tokens_out, cached 부분집합, thinking).
    fn parse_response(
        body: &serde_json::Value,
    ) -> (String, Vec<ToolCall>, i64, i64, i64, Option<String>) {
        let mut text = String::new();
        let mut thinking_text = String::new();
        let mut tool_calls = Vec::new();
        if let Some(content) = body.get("content").and_then(|v| v.as_array()) {
            for block in content {
                let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                    }
                    "thinking" => {
                        // Extended Thinking — `thinking` 필드에 reasoning text 가 들어감.
                        if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                            if !thinking_text.is_empty() {
                                thinking_text.push('\n');
                            }
                            thinking_text.push_str(t);
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let arguments = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                        // 도구 호출 마커 — frontend ThinkingBlock 본문에 누적 표시.
                        // 옛 Node 의 onChunk({type:'thinking', content:'[도구 호출: name]'}) 와 동등.
                        if !name.is_empty() {
                            if !thinking_text.is_empty() {
                                thinking_text.push('\n');
                            }
                            thinking_text.push_str(&format!("[도구 호출: {}]", name));
                        }
                        tool_calls.push(ToolCall { id, name, arguments });
                    }
                    _ => {}
                }
            }
        }
        // Anthropic usage 의 input_tokens 는 캐시 제외 신규 입력만 — cache_read / cache_creation 은 별도 가산.
        // 총 입력(tokens_in) = input_tokens + cache_creation + cache_read 로 합산해 다른 포맷과 의미 통일.
        let usage = body.get("usage");
        let get_usage = |key: &str| -> i64 {
            usage.and_then(|u| u.get(key)).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let input_new = get_usage("input_tokens");
        let cache_creation = get_usage("cache_creation_input_tokens");
        let cache_read = get_usage("cache_read_input_tokens");
        let tokens_in = input_new + cache_creation + cache_read;
        let tokens_out = get_usage("output_tokens");
        // cached = 캐시에서 읽힌 부분만 (0.1x 과금). cache_creation 은 신규 쓰기라 제외.
        let cached_tokens = cache_read;
        let thinking_opt = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };
        (text, tool_calls, tokens_in, tokens_out, cached_tokens, thinking_opt)
    }
}

#[async_trait::async_trait]
impl FormatHandler for AnthropicMessagesHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let key = require_api_key(config, api_key)?;
        let headers = Self::build_headers(config, &key)?;

        let cache_enabled = opts.anthropic_cache_enabled.unwrap_or(false);
        let mut body = serde_json::json!({
            "model": config.id,
            "max_tokens": opts.max_tokens.or(config.max_output).unwrap_or(8192),
            "messages": [{"role": "user", "content": prompt}],
        });
        // system block — cache 토글 ON 시 `[{type:'text', text, cache_control:{type:'ephemeral'}}]`
        // 형식 사용. OFF 시 단순 string. 옛 TS anthropic-messages.ts 1:1.
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                if cache_enabled {
                    body["system"] = serde_json::json!([{
                        "type": "text",
                        "text": sp,
                        "cache_control": { "type": "ephemeral" }
                    }]);
                } else {
                    body["system"] = serde_json::Value::String(sp.to_string());
                }
            }
        }
        if let Some(t) = opts.temperature {
            body["temperature"] = serde_json::Value::from(t);
        }
        Self::apply_extended_thinking(&mut body, config, opts);

        let response = http_client()
            .post(&config.endpoint)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value =
            response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!(
                "Anthropic API 에러 {}: {}",
                status,
                body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")
            ));
        }
        let (text, _tool_calls, tokens_in, tokens_out, cached_tokens, _thinking) =
            Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmTextResponse {
            text,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cached_tokens: Some(cached_tokens),
        })
    }

    async fn ask_with_tools(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        let key = require_api_key(config, api_key)?;
        let headers = Self::build_headers(config, &key)?;
        let cache_enabled = opts.anthropic_cache_enabled.unwrap_or(false);

        // 도구 정의 → Anthropic schema { name, description, input_schema }.
        // cache 토글 ON 시 마지막 tool 에 `cache_control: { type:'ephemeral' }` 마커 추가.
        // 옛 TS anthropic-messages.ts:116 1:1 (`cacheEnabled && i === tools.length - 1`).
        let tools_len = tools.len();
        let tool_defs: Vec<serde_json::Value> = tools
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut def = serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                });
                if let Some(schema) = &t.input_schema {
                    def["input_schema"] = schema.clone();
                } else {
                    def["input_schema"] = serde_json::json!({"type": "object", "properties": {}});
                }
                if cache_enabled && i + 1 == tools_len {
                    def["cache_control"] = serde_json::json!({ "type": "ephemeral" });
                }
                def
            })
            .collect();

        // 멀티턴 messages — user prompt + (assistant tool_use + user tool_result) loop.
        // Phase B-17 minimum: prior_results 가 있으면 단순화 — 첫 user message 에 user prompt,
        // 그 다음 assistant tool_use blocks (id 매칭), user tool_result blocks.
        let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
            "role": "user",
            "content": [{"type": "text", "text": prompt}]
        })];
        if !prior_results.is_empty() {
            // 옛 TS 패턴: 직전 assistant tool_use 응답 reconstruction. 우리는 prior_results 만 받으니
            // tool_use 메타는 임시 합성 (call_id 만 보존). Anthropic API 는 reconstruction 한 ID 매칭.
            let assistant_calls: Vec<serde_json::Value> = prior_results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "type": "tool_use",
                        "id": r.call_id,
                        "name": r.name,
                        "input": serde_json::json!({}) // 원본 input 모름 — empty 로
                    })
                })
                .collect();
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": assistant_calls
            }));
            let user_results: Vec<serde_json::Value> = prior_results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": r.call_id,
                        "content": serde_json::to_string(&r.result).unwrap_or_default(),
                        "is_error": !r.success,
                    })
                })
                .collect();
            messages.push(serde_json::json!({
                "role": "user",
                "content": user_results
            }));
        }

        let mut body = serde_json::json!({
            "model": config.id,
            "max_tokens": opts.max_tokens.or(config.max_output).unwrap_or(8192),
            "messages": messages,
            "tools": tool_defs,
        });
        Self::apply_extended_thinking(&mut body, config, opts);
        // system block — cache 토글 ON 시 `[{type:'text', text, cache_control}]` 형식.
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                if cache_enabled {
                    body["system"] = serde_json::json!([{
                        "type": "text",
                        "text": sp,
                        "cache_control": { "type": "ephemeral" }
                    }]);
                } else {
                    body["system"] = serde_json::Value::String(sp.to_string());
                }
            }
        }

        let response = http_client()
            .post(&config.endpoint)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value =
            response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!(
                "Anthropic API 에러 {}: {}",
                status,
                body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")
            ));
        }
        let (text, tool_calls, tokens_in, tokens_out, cached_tokens, thinking_text) =
            Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cached_tokens: Some(cached_tokens),
            thinking_text,
            ..Default::default()
        })
    }
}
