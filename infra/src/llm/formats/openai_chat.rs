//! OpenAI Chat Completions API — Ollama / OpenRouter / LM Studio compat (옛 TS openai-chat.ts).
//!
//! Phase B-17 minimum: 표준 chat completions. 도구 호출은 OpenAI tool_calls 표준.

use crate::llm::adapter::FormatHandler;
use firebat_core::llm::config::LlmModelConfig;
use crate::llm::formats::common::{
    build_messages, compute_cost, http_client, map_reqwest_error, require_api_key,
};
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

pub struct OpenAiChatHandler;

impl OpenAiChatHandler {
    pub fn new() -> Self {
        Self
    }

    fn parse_response(body: &serde_json::Value) -> (String, Vec<ToolCall>, i64, i64, i64) {
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
        // chat/completions 캐시 = usage.prompt_tokens_details.cached_tokens (호환 모델은 없을 수 있음 → 0).
        let cached_tokens = body
            .get("usage")
            .and_then(|u| u.get("prompt_tokens_details"))
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        (text, tool_calls, tokens_in, tokens_out, cached_tokens)
    }

    /// thinking_level → `reasoning_effort` (Solar Pro 3 / OpenAI-compat hybrid-reasoning models).
    /// Solar semantics: low = reasoning OFF, medium (default) = ON, high = ON deeper. Only emitted
    /// when features.reasoning is on; otherwise None (param omitted → model's own default).
    fn reasoning_effort(config: &LlmModelConfig, opts: &LlmCallOpts) -> Option<&'static str> {
        if !config.features.reasoning {
            return None;
        }
        Some(match opts.thinking_level.as_deref() {
            Some("none") | Some("minimal") | Some("low") => "low", // Solar low = reasoning OFF
            Some("high") | Some("xhigh") | Some("max") => "high",
            _ => "medium", // medium / unset → balanced reasoning ON (default)
        })
    }

    /// Parse the `reasoning` field a hybrid-reasoning model returns alongside `content`
    /// (`choices[0].message.reasoning`). Empty when reasoning was OFF or the model omits it.
    fn parse_reasoning(body: &serde_json::Value) -> String {
        body.get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|f| f.get("message"))
            .and_then(|m| m.get("reasoning"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// Sanitized assistant message for multiturn echo — `{role, content, tool_calls}` only.
    /// Returned as `raw_model_parts` so the NEXT round replays the model's own turn verbatim
    /// (inter-round narration text + exact call grouping preserved). `reasoning` is stripped:
    /// it is not part of the chat multiturn contract and must not be re-sent.
    /// None when the turn had no tool_calls (final turn — the loop ends, no echo needed).
    fn sanitized_assistant_message(body: &serde_json::Value) -> Option<serde_json::Value> {
        let msg = body
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|f| f.get("message"))?;
        let tool_calls = msg
            .get("tool_calls")
            .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))?
            .clone();
        Some(serde_json::json!({
            "role": "assistant",
            "content": msg.get("content").cloned().unwrap_or(serde_json::Value::Null),
            "tool_calls": tool_calls,
        }))
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
        // max_tokens = 명시 요청 시에만. chat-completions 는 completion 예산이 컨텍스트 창에
        // **선차감**된다 — maxOutput(32000) 상시 전송은 메시지 100K+ 턴에서 400
        // context_length_exceeded 를 냈다(실측 회귀). 생략 = 서버가 남은 공간 자동 맞춤(정답).
        // (gemini maxOutputTokens/anthropic max_tokens 는 의미론이 달라 미러 부적절.
        //  추출 JSON 잘림 방어는 structured outputs 가 담당.)
        if let Some(m) = opts.max_tokens {
            body["max_tokens"] = serde_json::Value::from(m);
        }
        if let Some(effort) = Self::reasoning_effort(config, opts) {
            body["reasoning_effort"] = serde_json::Value::from(effort);
        }
        // Structured output — hard-constrains the response to the caller's JSON Schema
        // (live-verified on solar-pro3 incl. nullable unions). Makes JSON extraction robust
        // on weak models instead of assuming a strong one.
        if let Some(schema) = &opts.json_schema {
            body["response_format"] = serde_json::json!({
                "type": "json_schema",
                "json_schema": { "name": "response", "strict": true, "schema": schema },
            });
        }
        // Prompt caching — a stable per-conversation key lets Upstage cache the large system-prompt
        // prefix across the FC tool-loop rounds (cached input ≈ 10× cheaper). The FC path re-sends
        // the whole prompt + tool defs every round, so this matters a lot for multi-tool turns.
        if let Some(cid) = opts.conversation_id.as_deref().filter(|s| !s.is_empty()) {
            body["prompt_cache_key"] = serde_json::Value::from(cid);
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
            // 공유 핸들러(Upstage/Ollama/OpenRouter 등 OpenAI-호환) — 하드코딩 "OpenAI" 가
            // Solar 에러에 그대로 노출돼 혼란. 모델 표시명 + 호환 계열 표기.
            return Err(format!(
                "{}(OpenAI-호환 API) 에러 {}: {}",
                config.display_name, status, body_json
            ));
        }
        let (text, _calls, tokens_in, tokens_out, cached_tokens) = Self::parse_response(&body_json);
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

        // messages — system + user, then the prior tool rounds in canonical multi-turn shape.
        //
        // Preferred source = opts.tool_exchanges (per-ROUND entries, gemini mirror): each round
        // replays as ONE assistant message (raw echo when captured — preserves the model's own
        // inter-round narration text + exact call grouping) followed by its tool results. Without
        // the echo the model loses what it said/decided between rounds and flounders (observed:
        // Solar re-sending "improved" telegram messages because its own plan text was erased).
        //
        // Fallback = flat prior_results (callers that don't populate exchanges): one synthesized
        // assistant(tool_calls=[real args]) + tool pair per call. Real args matter — the old code
        // sent `arguments:"{}"`, erasing the model's own context across rounds.
        let mut messages = build_messages(opts, prompt).as_array().cloned().unwrap_or_default();
        if !opts.tool_exchanges.is_empty() {
            for ex in &opts.tool_exchanges {
                if let Some(raw) = &ex.raw_model_parts {
                    // Raw echo — sanitized {role, content, tool_calls} captured from this handler's
                    // own prior response (see sanitized_assistant_message).
                    messages.push(raw.clone());
                } else {
                    let calls: Vec<serde_json::Value> = ex
                        .tool_calls
                        .iter()
                        .map(|tc| {
                            serde_json::json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::to_string(&tc.arguments)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                },
                            })
                        })
                        .collect();
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": null,
                        "tool_calls": calls,
                    }));
                }
                for tr in &ex.tool_results {
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tr.call_id,
                        "name": tr.name,
                        "content": serde_json::to_string(&tr.result).unwrap_or_default(),
                    }));
                }
            }
        } else {
            for r in prior_results {
                let args_str = if r.arguments.is_null() {
                    "{}".to_string()
                } else {
                    serde_json::to_string(&r.arguments).unwrap_or_else(|_| "{}".to_string())
                };
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": r.call_id,
                        "type": "function",
                        "function": { "name": r.name, "arguments": args_str },
                    }],
                }));
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": r.call_id,
                    "name": r.name,
                    "content": serde_json::to_string(&r.result).unwrap_or_default(),
                }));
            }
        }

        // NOTE: no `parallel_tool_calls` — Upstage's live API rejects it (400 "Unrecognized
        // request arguments") despite its docs, and this handler is shared with Ollama/OpenRouter/
        // LM Studio which also may not accept it. The model can still return multiple tool_calls;
        // parse_response already handles a batch.
        let mut body = serde_json::json!({
            "model": config.id,
            "messages": messages,
            "tools": tool_defs,
        });
        // Dynamic temperature from the tool loop (tool turn 0.2 / final turn 0.85) — ask_text
        // already sent it; this path dropped it, so Solar ran tool-selection turns at the
        // provider's default temp (a likely axis of its nondeterministic tool adherence).
        if let Some(t) = opts.temperature {
            body["temperature"] = serde_json::Value::from(t);
        }
        // max_tokens = 명시 요청 시에만. chat-completions 는 completion 예산이 컨텍스트 창에
        // **선차감**된다 — maxOutput(32000) 상시 전송은 메시지 100K+ 턴에서 400
        // context_length_exceeded 를 냈다(실측 회귀). 생략 = 서버가 남은 공간 자동 맞춤(정답).
        // (gemini maxOutputTokens/anthropic max_tokens 는 의미론이 달라 미러 부적절.
        //  추출 JSON 잘림 방어는 structured outputs 가 담당.)
        if let Some(m) = opts.max_tokens {
            body["max_tokens"] = serde_json::Value::from(m);
        }
        if let Some(effort) = Self::reasoning_effort(config, opts) {
            body["reasoning_effort"] = serde_json::Value::from(effort);
        }
        // Structured output — same as ask_text (schema-constrained response).
        if let Some(schema) = &opts.json_schema {
            body["response_format"] = serde_json::json!({
                "type": "json_schema",
                "json_schema": { "name": "response", "strict": true, "schema": schema },
            });
        }
        // Prompt caching — a stable per-conversation key lets Upstage cache the large system-prompt
        // prefix across the FC tool-loop rounds (cached input ≈ 10× cheaper). The FC path re-sends
        // the whole prompt + tool defs every round, so this matters a lot for multi-tool turns.
        if let Some(cid) = opts.conversation_id.as_deref().filter(|s| !s.is_empty()) {
            body["prompt_cache_key"] = serde_json::Value::from(cid);
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
            // 공유 핸들러(Upstage/Ollama/OpenRouter 등 OpenAI-호환) — 하드코딩 "OpenAI" 가
            // Solar 에러에 그대로 노출돼 혼란. 모델 표시명 + 호환 계열 표기.
            return Err(format!(
                "{}(OpenAI-호환 API) 에러 {}: {}",
                config.display_name, status, body_json
            ));
        }
        let (text, tool_calls, tokens_in, tokens_out, cached_tokens) =
            Self::parse_response(&body_json);
        let reasoning = Self::parse_reasoning(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cached_tokens: Some(cached_tokens),
            thinking_text: if reasoning.is_empty() { None } else { Some(reasoning) },
            // Echoed back next round via opts.tool_exchanges[].raw_model_parts (gemini mirror) —
            // preserves this turn's narration text + call grouping in the multiturn replay.
            raw_model_parts: Self::sanitized_assistant_message(&body_json),
            ..Default::default()
        })
    }
}
