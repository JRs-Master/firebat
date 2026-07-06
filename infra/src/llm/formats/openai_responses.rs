//! OpenAI Responses API — GPT-5.x 시리즈 (옛 TS openai-responses.ts).
//!
//! Phase B-17 minimum + FC multiturn (2026-07-06): previous_response_id chain (response `id`
//! parsed → ai.rs echoes it next round; input = latest round's function_call_output only) with
//! a full-replay fallback (function_call + output pairs). hosted MCP / tool_search 는 후속.
//! ⚠️ FC path unverified live (no OpenAI key registered) — spec-per-docs implementation.

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

    /// Reasoning 요청 파라미터 주입 — features.reasoning 활성 + thinking_level 실 레벨일 때만.
    /// body["reasoning"]={effort} + temperature 제거(reasoning 모델 미지원). 옛엔 요청에 미구현 →
    /// 모델이 reasoning 자체를 안 함 → 추론 0 (추출은 정상이어도 빈값). thinking_level → effort 매핑.
    fn apply_reasoning(
        body: &mut serde_json::Value,
        config: &LlmModelConfig,
        opts: &LlmCallOpts,
    ) {
        if !config.features.reasoning {
            return;
        }
        let effort = match opts.thinking_level.as_deref() {
            Some("minimal") => "minimal",
            Some("low") => "low",
            Some("medium") => "medium",
            Some("high") | Some("xhigh") | Some("max") => "high",
            _ => return, // none / 미설정
        };
        body["reasoning"] = serde_json::json!({ "effort": effort });
        if let Some(obj) = body.as_object_mut() {
            obj.remove("temperature");
        }
    }

    /// 반환: (text, tool_calls, tokens_in 총입력, tokens_out, cached 부분집합, thinking).
    fn parse_response(
        body: &serde_json::Value,
    ) -> (String, Vec<ToolCall>, i64, i64, i64, Option<String>) {
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
                        // emit 하는 thinking 요약. text 가 비어있을 수도 (encrypted_content 만).
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
                        // 도구 호출 마커 — frontend ThinkingBlock 본문에 누적 표시.
                        // 옛 Node 의 onChunk({type:'thinking', content:'[도구 호출: name]'}) 와 동등.
                        if !name.is_empty() {
                            if !thinking_text.is_empty() {
                                thinking_text.push('\n');
                            }
                            thinking_text.push_str(&firebat_core::i18n::t("core.llm.tool_call_marker", None, &[("name", &name)]));
                        }
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
        // Responses usage.input_tokens 는 캐시 포함 총 입력. cached 는 input_tokens_details.cached_tokens 부분집합.
        let usage = body.get("usage");
        let tokens_in = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let tokens_out = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cached_tokens = usage
            .and_then(|u| u.get("input_tokens_details"))
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let thinking_opt = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };
        (text, tool_calls, tokens_in, tokens_out, cached_tokens, thinking_opt)
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
        // Default 8192 — 모든 API 어댑터 일관 default (옛 node 버전의 답변 길이 회복).
        body["max_output_tokens"] = serde_json::Value::from(opts.max_tokens.or(config.max_output).unwrap_or(8192));
        Self::apply_reasoning(&mut body, config, opts);

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
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error",
                None,
                &[
                    ("name", "OpenAI Responses"),
                    ("status", &status.to_string()),
                    ("detail", body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")),
                ],
            ));
        }
        let (text, _calls, tokens_in, tokens_out, cached_tokens, _thinking) =
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

        // input — Responses API multiturn (string / item array).
        //
        // Canonical FC loop = previous_response_id chain: the server already holds the prompt +
        // the model's function_call items from the previous response, so the new input is ONLY
        // the outputs of the LATEST round (opts.tool_exchanges.last(); flat prior_results would
        // re-send earlier rounds the chain already contains).
        //
        // Fallback (no previous_response_id captured) = full replay: prompt + every
        // (function_call + function_call_output) pair with REAL args. An orphan
        // function_call_output without its matching function_call is rejected by the API —
        // the old code sent exactly that shape and would 400 on any multiturn.
        let prev_id = opts
            .previous_response_id
            .as_deref()
            .filter(|s| !s.is_empty());
        let input: serde_json::Value = if prior_results.is_empty() {
            serde_json::json!(prompt)
        } else if prev_id.is_some() {
            let latest: &[ToolResult] = opts
                .tool_exchanges
                .last()
                .map(|ex| ex.tool_results.as_slice())
                .unwrap_or(prior_results);
            let arr: Vec<serde_json::Value> = latest
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "type": "function_call_output",
                        "call_id": r.call_id,
                        "output": serde_json::to_string(&r.result).unwrap_or_default(),
                    })
                })
                .collect();
            serde_json::Value::Array(arr)
        } else {
            let mut arr: Vec<serde_json::Value> = vec![serde_json::json!({
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}]
            })];
            for r in prior_results {
                arr.push(serde_json::json!({
                    "type": "function_call",
                    "call_id": r.call_id,
                    "name": r.name,
                    "arguments": serde_json::to_string(&r.arguments)
                        .unwrap_or_else(|_| "{}".to_string()),
                }));
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
        if let Some(prev) = prev_id {
            body["previous_response_id"] = serde_json::Value::from(prev);
        }
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["instructions"] = serde_json::Value::String(sp.to_string());
            }
        }
        // Default 8192 — 모든 API 어댑터 일관 default (옛 node 버전의 답변 길이 회복).
        body["max_output_tokens"] = serde_json::Value::from(opts.max_tokens.or(config.max_output).unwrap_or(8192));
        Self::apply_reasoning(&mut body, config, opts);

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
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error",
                None,
                &[
                    ("name", "OpenAI Responses"),
                    ("status", &status.to_string()),
                    ("detail", body_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("(unknown)")),
                ],
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
            // ai.rs feeds this back as previous_response_id next round (server-side history
            // chain — the input then carries only the new function_call_output items).
            response_id: body_json
                .get("id")
                .and_then(|v| v.as_str())
                .map(String::from),
            ..Default::default()
        })
    }
}
