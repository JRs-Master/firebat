//! OpenAI Chat Completions API — Ollama / OpenRouter / LM Studio compat (옛 TS openai-chat.ts).
//!
//! Phase B-17 minimum: 표준 chat completions. 도구 호출은 OpenAI tool_calls 표준.

use crate::llm::adapter::FormatHandler;
use firebat_core::llm::config::LlmModelConfig;
use crate::llm::formats::common::{
    build_messages, compute_cost, http_client, llm_stream_client, map_reqwest_error,
    require_api_key,
};
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

/// 스트림 청크 간 최대 무데이터 허용 — 이걸 넘기면 행(hang)으로 판정.
/// 정상 라운드는 reasoning 토큰이 수 초 안에 흐르기 시작한다(라이브 검증) — 180s 는
/// 프롬프트 큐잉·첫 토큰 지연의 넉넉한 상한이면서, 옛 비스트리밍의 "행에 10분 낭비"를 없앤다.
const STREAM_IDLE_TIMEOUT_SECS: u64 = 180;

pub struct OpenAiChatHandler;

/// Repair a model-authored tool-call `arguments` string into a valid JSON object.
/// Weak models emit broken JSON (comments / trailing commas / truncation). Two failure
/// surfaces need this: (1) local dispatch parse, (2) the multiturn echo — the upstream API
/// VALIDATES replayed `function.arguments` as JSON, so echoing the raw broken string is a
/// permanent 400 on every later round of the turn (2026-07-07 schedule_task 실측).
/// Chain: strict parse → tolerant cleanup (comment/trailing-comma strip) → `{}` last resort.
/// Returns (parsed value, canonical string) — both sides stay consistent.
fn repair_tool_args(raw: &str) -> (serde_json::Value, String) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if v.is_object() {
            return (v, raw.to_string());
        }
    }
    let cleaned = firebat_core::managers::ai::render_exec::tolerant_json_cleanup(raw);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned) {
        if v.is_object() {
            let s = v.to_string();
            tracing::warn!(
                target: "llm",
                "tool-call arguments repaired via tolerant parse ({} chars)",
                raw.len()
            );
            return (v, s);
        }
    }
    tracing::warn!(
        target: "llm",
        "tool-call arguments unparseable — replaced with {{}} ({} chars head: {})",
        raw.len(),
        raw.chars().take(120).collect::<String>()
    );
    (serde_json::json!({}), "{}".to_string())
}

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
                            // Repair (not just fallback): a tolerant parse recovers the model's
                            // intended args for comment/trailing-comma dialects, so the tool can
                            // actually run instead of failing validation on {}.
                            let (arguments, _) = repair_tool_args(args_str);
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

    /// chat/completions 호출 — 기본 SSE 스트리밍으로 받아 **비스트리밍 응답 shape 으로 조립**
    /// (다운스트림 parse_response/parse_reasoning/sanitized_assistant_message 무변경).
    ///
    /// 왜 스트리밍: 비스트리밍은 total timeout 하나로만 행(hang)을 구분할 수 있어 "느리지만
    /// 완주하는 라운드"(실측 166s)를 살리려면 행에 10분을 낭비한다(2026-07-06 upstage 행 2회
    /// 실측). 스트리밍은 청크 간 idle timeout 으로 행을 빨리 감지하면서 정상 장고 라운드는
    /// 제한 없이 받는다. shape 은 solar-pro3 라이브 검증: delta.content/reasoning 조각,
    /// tool_calls 는 index 별 조각(후속 조각의 name="" 은 덮어쓰기 금지, arguments 는 이어붙임),
    /// 마지막 chunk 에 usage(stream_options.include_usage), 종료 = data: [DONE].
    ///
    /// `stream=false`(json_schema 등 스트리밍 미검증 조합) 또는 응답이 SSE 가 아닌 호환 서버
    /// (stream 플래그 무시하고 JSON 통짜 반환)는 기존 비스트리밍 경로 그대로.
    async fn send_chat(
        config: &LlmModelConfig,
        key: &str,
        mut body: serde_json::Value,
        stream: bool,
    ) -> InfraResult<(reqwest::StatusCode, serde_json::Value)> {
        if !stream {
            let response = http_client()
                .post(&config.endpoint)
                .bearer_auth(key)
                .json(&body)
                .send()
                .await
                .map_err(map_reqwest_error)?;
            let status = response.status();
            let body_json: serde_json::Value =
                response.json().await.map_err(map_reqwest_error)?;
            return Ok((status, body_json));
        }

        body["stream"] = serde_json::Value::Bool(true);
        body["stream_options"] = serde_json::json!({ "include_usage": true });
        let response = llm_stream_client()
            .post(&config.endpoint)
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let is_sse = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.contains("text/event-stream"))
            .unwrap_or(false);
        if !status.is_success() || !is_sse {
            // 에러 바디 또는 스트림 미지원 호환 서버(JSON 통짜) — 그대로 파싱해 기존 경로로.
            let text = response.text().await.map_err(map_reqwest_error)?;
            let json = serde_json::from_str(&text)
                .unwrap_or_else(|_| serde_json::json!({ "raw": text }));
            return Ok((status, json));
        }

        use futures_util::StreamExt;
        let mut byte_stream = response.bytes_stream();
        // 바이트 버퍼 — 청크가 멀티바이트(한글) 문자 중간에서 끊길 수 있어 줄(\n) 경계에서만
        // UTF-8 변환한다 (from_utf8_lossy 를 청크 단위로 쓰면 한글 깨짐).
        let mut buf: Vec<u8> = Vec::new();
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut finish: Option<String> = None;
        let mut usage: Option<serde_json::Value> = None;
        // index → (id, name, arguments 누적)
        let mut calls: std::collections::BTreeMap<u64, (String, String, String)> =
            std::collections::BTreeMap::new();
        let mut done = false;
        while !done {
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS),
                byte_stream.next(),
            )
            .await;
            let chunk = match next {
                Err(_) => {
                    let detail = format!(
                        "stream idle timeout — no data for {STREAM_IDLE_TIMEOUT_SECS}s"
                    );
                    tracing::warn!(target: "llm", error = %detail, "LLM HTTP request failed");
                    return Err(firebat_core::i18n::t(
                        "core.error.llm.http_failed",
                        None,
                        &[("detail", &detail)],
                    ));
                }
                Ok(None) => break, // 스트림 정상 종료 ([DONE] 없이 EOF 도 수용)
                Ok(Some(Err(e))) => return Err(map_reqwest_error(e)),
                Ok(Some(Ok(bytes))) => bytes,
            };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&c| c == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                    usage = Some(u.clone());
                }
                let Some(choice) = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                else {
                    continue;
                };
                if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                    finish = Some(fr.to_string());
                }
                let Some(delta) = choice.get("delta") else { continue };
                if let Some(s) = delta.get("content").and_then(|v| v.as_str()) {
                    content.push_str(s);
                }
                if let Some(s) = delta.get("reasoning").and_then(|v| v.as_str()) {
                    reasoning.push_str(s);
                }
                if let Some(arr) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in arr {
                        let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                        let entry = calls.entry(idx).or_default();
                        if let Some(id) = tc
                            .get("id")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            entry.0 = id.to_string();
                        }
                        if let Some(f) = tc.get("function") {
                            if let Some(nm) = f
                                .get("name")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                            {
                                entry.1 = nm.to_string();
                            }
                            if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                                entry.2.push_str(a);
                            }
                        }
                    }
                }
            }
        }

        // 비스트리밍 shape 으로 조립 — 다운스트림 파서 공용.
        let mut message = serde_json::json!({ "role": "assistant", "content": content });
        if !reasoning.is_empty() {
            message["reasoning"] = serde_json::Value::String(reasoning);
        }
        if !calls.is_empty() {
            let arr: Vec<serde_json::Value> = calls
                .into_values()
                .map(|(id, name, args)| {
                    serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": args },
                    })
                })
                .collect();
            message["tool_calls"] = serde_json::Value::Array(arr);
        }
        let assembled = serde_json::json!({
            "choices": [{ "message": message, "finish_reason": finish }],
            "usage": usage.unwrap_or_else(|| serde_json::json!({})),
        });
        Ok((status, assembled))
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
        let mut tool_calls = msg
            .get("tool_calls")
            .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))?
            .clone();
        // Echo must be VALID JSON per call — the upstream validates replayed
        // function.arguments, so one malformed round would 400 every later round.
        // Repair to the same canonical string the dispatcher parsed (consistency).
        if let Some(calls) = tool_calls.as_array_mut() {
            for tc in calls.iter_mut() {
                let raw = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string();
                let (_, canonical) = repair_tool_args(&raw);
                if canonical != raw {
                    if let Some(f) = tc.get_mut("function") {
                        f["arguments"] = serde_json::Value::String(canonical);
                    }
                }
            }
        }
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

        // json_schema(structured outputs) 조합만 비스트리밍 유지 — stream+response_format 은
        // 라이브 미검증(worker/cron 경로라 행 리스크도 낮음). 그 외 = 스트리밍(행 조기 감지).
        let (status, body_json) =
            Self::send_chat(config, &key, body, opts.json_schema.is_none()).await?;
        if !status.is_success() {
            // 공유 핸들러(Upstage/Ollama/OpenRouter 등 OpenAI-호환) — 모델 표시명 + 호환 계열 표기.
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error_compat",
                None,
                &[
                    ("name", &config.display_name),
                    ("status", &status.to_string()),
                    ("detail", &body_json.to_string()),
                ],
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
        });
        // Omit `tools` entirely when empty — OpenAI-compatible APIs reject `"tools": []` with
        // 400 `empty_array` (Upstage 실측 2026-07-10: F2 force-final round(도구 제거)가 빈 배열을
        // 보내 턴이 통째로 죽었다 — 22시 날씨 cron·실시간 차트 턴 둘 다). No tools = plain chat.
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::Value::Array(tool_defs);
        }
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

        // FC 라운드 = 스트리밍(행 조기 감지 — 2026-07-06 upstage 행 2회의 주 피해 경로).
        // json_schema 조합만 비스트리밍(stream+response_format 라이브 미검증).
        let (status, body_json) =
            Self::send_chat(config, &key, body, opts.json_schema.is_none()).await?;
        if !status.is_success() {
            // 공유 핸들러(Upstage/Ollama/OpenRouter 등 OpenAI-호환) — 모델 표시명 + 호환 계열 표기.
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error_compat",
                None,
                &[
                    ("name", &config.display_name),
                    ("status", &status.to_string()),
                    ("detail", &body_json.to_string()),
                ],
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
