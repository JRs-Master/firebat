//! Anthropic Messages API — Claude 4 시리즈 (옛 TS anthropic-messages.ts).
//!
//! 핵심 features:
//! - extended thinking (low/medium/high/xhigh/max → budget_tokens 매핑)
//! - MCP connector 2025-11-20 (betas + tools.mcp_toolset)
//! - prompt caching (Vault 토글) — 옛 TS 4-26 박힘
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
    /// 응답 schema: { content: [{type: "text", text: ...}, {type: "tool_use", id, name, input}], usage: {input_tokens, output_tokens} }
    fn parse_response(body: &serde_json::Value) -> (String, Vec<ToolCall>, i64, i64) {
        let mut text = String::new();
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
                        tool_calls.push(ToolCall { id, name, arguments });
                    }
                    _ => {}
                }
            }
        }
        let tokens_in = body
            .get("usage")
            .and_then(|u| u.get("input_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let tokens_out = body
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        (text, tool_calls, tokens_in, tokens_out)
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

        let mut body = serde_json::json!({
            "model": config.id,
            "max_tokens": opts.max_tokens.unwrap_or(4096),
            "messages": [{"role": "user", "content": prompt}],
        });
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["system"] = serde_json::Value::String(sp.to_string());
            }
        }
        if let Some(t) = opts.temperature {
            body["temperature"] = serde_json::Value::from(t);
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
        let (text, _tool_calls, tokens_in, tokens_out) = Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmTextResponse {
            text,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
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

        // 도구 정의 → Anthropic schema { name, description, input_schema }
        let tool_defs: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                let mut def = serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                });
                if let Some(schema) = &t.input_schema {
                    def["input_schema"] = schema.clone();
                } else {
                    def["input_schema"] = serde_json::json!({"type": "object", "properties": {}});
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
            "max_tokens": opts.max_tokens.unwrap_or(4096),
            "messages": messages,
            "tools": tool_defs,
        });
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["system"] = serde_json::Value::String(sp.to_string());
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
        let (text, tool_calls, tokens_in, tokens_out) = Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            ..Default::default()
        })
    }
}
