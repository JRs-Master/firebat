//! OpenAI Chat Completions API — Ollama / OpenRouter / LM Studio compat (옛 TS openai-chat.ts).
//!
//! Phase B-17 minimum: 표준 chat completions. 도구 호출은 OpenAI tool_calls 표준.

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::llm::formats::common::{
    build_messages, compute_cost, http_client, map_reqwest_error, require_api_key,
};
use crate::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

pub struct OpenAiChatHandler;

impl OpenAiChatHandler {
    pub fn new() -> Self {
        Self
    }

    fn parse_response(body: &serde_json::Value) -> (String, Vec<ToolCall>, i64, i64) {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        if let Some(choices) = body.get("choices").and_then(|v| v.as_array()) {
            if let Some(first) = choices.first() {
                if let Some(msg) = first.get("message") {
                    if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                        text.push_str(content);
                    }
                    if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                        for tc in calls {
                            let id = tc
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let func = tc.get("function");
                            let name = func
                                .and_then(|f| f.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args_str = func
                                .and_then(|f| f.get("arguments"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("{}");
                            let arguments =
                                serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                            tool_calls.push(ToolCall { id, name, arguments });
                        }
                    }
                }
            }
        }
        let tokens_in = body
            .get("usage")
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let tokens_out = body
            .get("usage")
            .and_then(|u| u.get("completion_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        (text, tool_calls, tokens_in, tokens_out)
    }
}

#[async_trait::async_trait]
impl FormatHandler for OpenAiChatHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let key = require_api_key(config, api_key)?;
        let mut body = serde_json::json!({
            "model": config.id,
            "messages": build_messages(opts, prompt),
        });
        if let Some(t) = opts.temperature {
            body["temperature"] = serde_json::Value::from(t);
        }
        if let Some(m) = opts.max_tokens {
            body["max_tokens"] = serde_json::Value::from(m);
        }

        let response = http_client()
            .post(&config.endpoint)
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!("OpenAI Chat API 에러 {}: {}", status, body_json));
        }
        let (text, _calls, tokens_in, tokens_out) = Self::parse_response(&body_json);
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

        let tool_defs: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                let params = t.input_schema.clone().unwrap_or_else(
                    || serde_json::json!({"type": "object", "properties": {}}),
                );
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": params,
                    }
                })
            })
            .collect();
        // unused let warning 회피
        let _ = &tool_defs;

        // messages — system + user + (assistant tool_calls + tool results) per prior_results
        let mut messages = build_messages(opts, prompt).as_array().cloned().unwrap_or_default();
        if !prior_results.is_empty() {
            // assistant 메시지 with tool_calls reconstruction
            let assistant_calls: Vec<serde_json::Value> = prior_results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "id": r.call_id,
                        "type": "function",
                        "function": {
                            "name": r.name,
                            "arguments": "{}",
                        }
                    })
                })
                .collect();
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": assistant_calls,
            }));
            for r in prior_results {
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": r.call_id,
                    "content": serde_json::to_string(&r.result).unwrap_or_default(),
                }));
            }
        }

        let mut body = serde_json::json!({
            "model": config.id,
            "messages": messages,
            "tools": tool_defs,
        });
        if let Some(m) = opts.max_tokens {
            body["max_tokens"] = serde_json::Value::from(m);
        }

        let response = http_client()
            .post(&config.endpoint)
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!("OpenAI Chat API 에러 {}: {}", status, body_json));
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
        })
    }
}
