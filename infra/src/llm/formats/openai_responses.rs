//! OpenAI Responses API — GPT-5.x 시리즈 (옛 TS openai-responses.ts).
//!
//! Phase B-17 minimum: 표준 input/output. reasoning / hosted MCP / tool_search /
//! previous_response_id (24h cache) 같은 features 는 후속.

use crate::llm::adapter::FormatHandler;
use firebat_core::llm::config::LlmModelConfig;
use crate::llm::formats::common::{
    compute_cost, http_client, map_reqwest_error, require_api_key,
};
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

pub struct OpenAiResponsesHandler;

impl OpenAiResponsesHandler {
    pub fn new() -> Self {
        Self
    }

    fn parse_response(
        body: &serde_json::Value,
    ) -> (String, Vec<ToolCall>, i64, i64, Option<String>) {
        let mut text = String::new();
        let mut thinking_text = String::new();
        let mut tool_calls = Vec::new();
        // Responses API 의 output 은 array — { type: "message", content: [{ type: "output_text", text }] }
        // 또는 { type: "function_call", call_id, name, arguments }
        // 또는 { type: "reasoning", summary: [{ type: "summary_text", text }] } — o-series / GPT-5 reasoning 모델.
        if let Some(output) = body.get("output").and_then(|v| v.as_array()) {
            for item in output {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "message" => {
                        if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                            for c in content {
                                if c.get("type").and_then(|v| v.as_str()) == Some("output_text") {
                                    if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                        text.push_str(t);
                                    }
                                }
                            }
                        }
                    }
                    "reasoning" => {
                        // reasoning.summary[*].text — reasoning 모델 (o1 / o3 / GPT-5) 가
                        // emit 박는 thinking 요약. text 가 비어있을 수도 (encrypted_content 만).
                        if let Some(summary) = item.get("summary").and_then(|v| v.as_array()) {
                            for s in summary {
                                if let Some(t) = s.get("text").and_then(|v| v.as_str()) {
                                    if !thinking_text.is_empty() {
                                        thinking_text.push('\n');
                                    }
                                    thinking_text.push_str(t);
                                }
                            }
                        }
                    }
                    "function_call" => {
                        let call_id = item
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // arguments 는 string (JSON-serialized) — parse
                        let args_str = item
                            .get("arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let arguments =
                            serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                        tool_calls.push(ToolCall {
                            id: call_id,
                            name,
                            arguments,
                        });
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
        let thinking_opt = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };
        (text, tool_calls, tokens_in, tokens_out, thinking_opt)
    }
}

#[async_trait::async_trait]
impl FormatHandler for OpenAiResponsesHandler {
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
            "input": prompt,
        });
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["instructions"] = serde_json::Value::String(sp.to_string());
            }
        }
        if let Some(t) = opts.temperature {
            body["temperature"] = serde_json::Value::from(t);
        }
        // Default 8192 — 모든 API 어댑터 일관 default (옛 node 버전 박은 답변 길이 회복).
        body["max_output_tokens"] = serde_json::Value::from(opts.max_tokens.unwrap_or(8192));

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
            return Err(format!(
                "OpenAI Responses API 에러 {}: {}",
                status,
                body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")
            ));
        }
        let (text, _calls, tokens_in, tokens_out, _thinking) = Self::parse_response(&body_json);
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

        // tools → Responses API tool 형식: { type: "function", name, description, parameters }
        let tool_defs: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                let mut def = serde_json::json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                });
                if let Some(schema) = &t.input_schema {
                    def["parameters"] = schema.clone();
                } else {
                    def["parameters"] = serde_json::json!({"type": "object", "properties": {}});
                }
                def
            })
            .collect();

        // input — 사용자 prompt + (직전 tool 결과는 input 에 함께 inject)
        // Responses API 의 input 은 string 또는 message array. 단순화 — 첫 호출은 string.
        // prior_results 있으면 array 로 변환:
        let input: serde_json::Value = if prior_results.is_empty() {
            serde_json::json!(prompt)
        } else {
            let mut arr: Vec<serde_json::Value> = vec![serde_json::json!({
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}]
            })];
            for r in prior_results {
                arr.push(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": r.call_id,
                    "output": serde_json::to_string(&r.result).unwrap_or_default(),
                }));
            }
            serde_json::Value::Array(arr)
        };

        let mut body = serde_json::json!({
            "model": config.id,
            "input": input,
            "tools": tool_defs,
        });
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["instructions"] = serde_json::Value::String(sp.to_string());
            }
        }
        // Default 8192 — 모든 API 어댑터 일관 default (옛 node 버전 박은 답변 길이 회복).
        body["max_output_tokens"] = serde_json::Value::from(opts.max_tokens.unwrap_or(8192));

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
            return Err(format!(
                "OpenAI Responses API 에러 {}: {}",
                status,
                body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")
            ));
        }
        let (text, tool_calls, tokens_in, tokens_out, thinking_text) =
            Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            thinking_text,
            ..Default::default()
        })
    }
}
